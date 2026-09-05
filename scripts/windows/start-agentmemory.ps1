# Start the agentmemory daemon with secrets injected from Windows
# Credential Manager.
#
# The point of this wrapper: ~/.agentmemory/.env holds only non-secret
# configuration (endpoints, model names, feature flags). Every actual
# credential is read from the OS credential vault at launch and exists
# only in this process's environment, which is inherited by the engine
# and the worker it spawns. Nothing secret is written to disk, so .env
# is safe to read, diff, and back up.
#
# Usage:
#   .\start-agentmemory.ps1              # start detached, log to ~/.agentmemory
#   .\start-agentmemory.ps1 -Foreground  # run attached (for debugging)
#   .\start-agentmemory.ps1 -Stop        # stop engine + worker, incl. orphans
#   .\start-agentmemory.ps1 -IfDown      # restart only if :3111 is silent (watchdog)

[CmdletBinding()]
param(
  [switch]$Foreground,
  [switch]$Stop,
  # Watchdog mode: restart ONLY if nothing answers on the REST port. Any HTTP
  # status from 127.0.0.1 -- including 401 -- proves the listener is alive; a
  # wedged daemon (process up, port silent, seen 2026-09-05) is the only case
  # this restarts. Idempotent, so a scheduled task can call it every few minutes.
  [switch]$IfDown
)

$ErrorActionPreference = 'Stop'
$AM = Join-Path $env:USERPROFILE '.agentmemory'
$CredStore = Join-Path $PSScriptRoot 'credstore.ps1'

# REST is the anchor; the other three derive from it, matching
# config.ts. Setting III_REST_PORT=3211 yields 3212/3213/49234, so a
# second instance does not collide with the first.
$RestPort    = if ($env:III_REST_PORT) { [int]$env:III_REST_PORT } else { 3111 }
$StreamsPort = $RestPort + 1
$ViewerPort  = $RestPort + 2
$EnginePort  = $RestPort + 46023

# Secrets to pull from the vault, mapped to the env var agentmemory reads.
# Add a line here when a new provider is wired; missing entries are
# skipped with a warning rather than being fatal, so the daemon can still
# start in a reduced mode.
$SECRETS = @{
  'agentmemory/CLOUDFLARE_API_TOKEN' = 'CLOUDFLARE_API_TOKEN'
}

function Stop-AgentMemory {
  # `agentmemory stop` tracks a single worker.pid. The engine spawns the
  # worker via iii-exec, so a worker started by a previous engine can
  # outlive the pidfile and keep holding :3111 -- which then makes the
  # next start fail with "address already in use" and no obvious cause.
  # Sweep by command line as well as by pidfile.
  try { & agentmemory stop 2>&1 | Out-Null } catch { }
  Start-Sleep -Seconds 1

  # Match BOTH worker entry points. The published package starts its worker
  # from dist/index.mjs, but this fork runs from source and starts it from
  # dist/cli.mjs -- the bare CLI *is* a worker ("(default) Start agentmemory
  # worker"). Matching only index.mjs meant this never reaped a fork worker:
  # the sweep reported success, the old worker kept running, and the new one
  # registered all 268 function ids alongside it. The engine load-balances
  # between same-named workers, so half of every call was served by the old
  # process -- and when the older one was later killed, the survivor was left
  # holding no HTTP routes and every endpoint 404'd.
  $stragglers = Get-CimInstance Win32_Process -Filter "Name='iii.exe' OR Name='node.exe'" |
    Where-Object {
      $_.Name -eq 'iii.exe' -or
      $_.CommandLine -like '*agentmemory*dist*index.mjs*' -or
      $_.CommandLine -like '*agentmemory*dist*cli.mjs*'
    }
  foreach ($proc in $stragglers) {
    Write-Host "  reaping $($proc.Name) pid $($proc.ProcessId)"
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }

  Start-Sleep -Seconds 2
  $held = Get-NetTCPConnection -State Listen -LocalPort $RestPort, $StreamsPort, $ViewerPort, $EnginePort -ErrorAction SilentlyContinue
  if ($held) {
    Write-Warning "Ports still held by PID(s): $(($held.OwningProcess | Sort-Object -Unique) -join ', ')"
  } else {
    Write-Host "Stopped. Ports released." -ForegroundColor Green
  }
}

if ($Stop) { Stop-AgentMemory; return }

# --- inject secrets -------------------------------------------------------
$loaded = @()
foreach ($target in $SECRETS.Keys) {
  $envVar = $SECRETS[$target]
  try {
    $value = & $CredStore -Get -Name $target
    if ([string]::IsNullOrWhiteSpace($value)) { throw "empty" }
    Set-Item -Path "Env:$envVar" -Value $value
    $loaded += "$envVar ($($value.Length) chars)"
  } catch {
    Write-Warning "$envVar not available from credential vault: $($_.Exception.Message)"
  }
}
if ($loaded.Count -gt 0) {
  Write-Host "Injected from Credential Manager: $($loaded -join ', ')" -ForegroundColor Green
}

# Note: this script deliberately does NOT clear other provider keys from
# the environment. Set AGENTMEMORY_PROVIDER in ~/.agentmemory/.env to pin
# the provider; detection honours the pin and will never silently fall
# back to a different provider (and so never silently bill one).

# AGENTMEMORY_URL is a CLIENT setting: it tells a CLI or MCP client where to
# reach a server. The server must never read it, and inheriting it from the
# ambient environment is not harmless.
#
# Measured here on 2026-08-29. A User-scoped AGENTMEMORY_URL pointed at this
# box's Tailscale name. getBaseUrl() returned it, and isEngineRunning() treats
# ANY HTTP response as proof of a live engine -- Tailscale answered 404, which
# is a response. So the CLI concluded an engine was already up, skipped
# startEngine(), and the worker sat in a WebSocket reconnect loop against a
# port nothing was listening on. The daemon had been down since 8 August and
# every start "succeeded" in the terminal while never binding 3111.
#
# Cleared for THIS process only, which the engine and worker inherit. The
# user-level variable is untouched, so remote clients keep resolving.
#
# This is the launcher-side half. The real fix is upstream: isEngineRunning()
# must not count a 404 as a live engine.
if ($env:AGENTMEMORY_URL) {
  Write-Host "Ignoring inherited AGENTMEMORY_URL=$($env:AGENTMEMORY_URL) for the server process (client setting)." -ForegroundColor DarkYellow
  [Environment]::SetEnvironmentVariable('AGENTMEMORY_URL', $null)
}

if ($IfDown) {
  $alive = $false
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$RestPort/agentmemory/livez" -UseBasicParsing -TimeoutSec 5 | Out-Null
    $alive = $true
  } catch {
    # A response with any status is a live listener. Only no response at all is "down".
    if ($_.Exception.Response) { $alive = $true }
  }
  if ($alive) { Write-Host "agentmemory answers on :$RestPort -- nothing to do."; return }
  Write-Warning "agentmemory is NOT answering on :$RestPort -- restarting (watchdog)."
}

Stop-AgentMemory

# Run the FORK, not the globally-installed @agentmemory/agentmemory.
#
# `agentmemory.cmd` resolves to ~/AppData/Roaming/npm/node_modules/@agentmemory,
# which is the published upstream package. Because the bare CLI *is* a worker
# ("(default) Start agentmemory worker"), starting it registered upstream code
# against the engine alongside the fork worker that iii-exec spawns -- two
# workers, same name, all 268 function ids each. The engine load-balances, so
# roughly half of every mem::summarize and mem::compress call was served by
# upstream code with none of this fork's fixes. That is invisible from the
# outside: same function names, same responses, intermittently the old
# behaviour.
#
# Heap flags mirror the iii-exec line in iii-config.yaml so both entry points
# get the same ceiling.
$ForkCli = 'X:/Projects/agentmemory/dist/cli.mjs'
$NodeArgs = @('--max-old-space-size=8192', '--max-semi-space-size=64', $ForkCli)

if (-not (Test-Path $ForkCli)) { throw "Fork CLI not found at $ForkCli -- run 'npm run build' in the fork." }

if ($Foreground) {
  & node @NodeArgs --verbose
} else {
  $out = Join-Path $AM 'daemon.log'
  $err = Join-Path $AM 'daemon.err.log'
  $proc = Start-Process -FilePath 'node' -ArgumentList $NodeArgs `
    -WorkingDirectory $env:USERPROFILE `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err
  Write-Host "agentmemory starting (pid $($proc.Id)); logs: $out" -ForegroundColor Green

  # 127.0.0.1, not localhost.
  #
  # The REST server binds IPv4 only (Get-NetTCPConnection shows
  # LocalAddress 127.0.0.1), but .NET resolves "localhost" to ::1 first and
  # only falls back to IPv4 after ~2.05s. With -TimeoutSec 2 that fallback
  # never lands, so every one of the 60 attempts failed by ~50ms and the
  # probe reported "Not reachable after 60s" against a daemon that was
  # answering in 39ms. The warning was unconditional, which made a healthy
  # start look like a failed one. Measured: localhost/2s -> timeout,
  # localhost/10s -> 200 in 2054ms, 127.0.0.1/2s -> 200 in 39ms.
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:$RestPort/agentmemory/livez" -UseBasicParsing -TimeoutSec 5 | Out-Null
      Write-Host "Ready after ${i}s: http://localhost:$RestPort" -ForegroundColor Green
      return
    } catch { }
  }
  Write-Warning "Not reachable after 60s -- check $err"
}
