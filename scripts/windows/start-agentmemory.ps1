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

[CmdletBinding()]
param(
  [switch]$Foreground,
  [switch]$Stop
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

  $stragglers = Get-CimInstance Win32_Process -Filter "Name='iii.exe' OR Name='node.exe'" |
    Where-Object {
      $_.Name -eq 'iii.exe' -or
      $_.CommandLine -like '*agentmemory*dist*index.mjs*'
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
Stop-AgentMemory

if ($Foreground) {
  & agentmemory --verbose
} else {
  $out = Join-Path $AM 'daemon.log'
  $err = Join-Path $AM 'daemon.err.log'
  $proc = Start-Process -FilePath 'agentmemory.cmd' `
    -WorkingDirectory $env:USERPROFILE `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err
  Write-Host "agentmemory starting (pid $($proc.Id)); logs: $out" -ForegroundColor Green

  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    try {
      Invoke-WebRequest -Uri "http://localhost:$RestPort/agentmemory/livez" -UseBasicParsing -TimeoutSec 2 | Out-Null
      Write-Host "Ready after ${i}s: http://localhost:$RestPort" -ForegroundColor Green
      return
    } catch { }
  }
  Write-Warning "Not reachable after 60s -- check $err"
}
