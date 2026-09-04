# Start the Cloudflare Tunnel that publishes this machine's agentmemory
# daemon as https://mem.inspekter.app.
#
# Why this exists: the estate's memory upstream (mem.inspekter.app) used to
# front a daemon on the clawnet VPS. That box was repurposed on 2026-09-04
# and the daemon on it removed, leaving every workspace agent's memory call
# answering 502 behind Access. The only running daemon is this machine's,
# on 127.0.0.1:3111, so this machine now carries the tunnel.
#
# Tunnel: workhorse-agentmemory (7afee8a8-7d99-45cb-84f3-0d514878e066),
# remotely managed -- its ingress (mem.inspekter.app -> http://127.0.0.1:3111)
# lives in the Cloudflare dashboard, not in a local config.yml.
#
# The tunnel token lives in Windows Credential Manager under
# agentmemory/TUNNEL_TOKEN and reaches cloudflared ONLY through the
# TUNNEL_TOKEN environment variable of the child process. Never as an
# argument (visible to every process on the box) and never in a file.
# Same rule as start-agentmemory.ps1.
#
# Runs as the interactive user, not as a service: DPAPI can only decrypt
# the vault inside this user's logon session. See register-autostart.ps1
# for the reasoning; register-tunnel-autostart.ps1 applies it to this
# script.
#
# Usage:
#   .\start-tunnel.ps1          # start, or report that it is already up
#   .\start-tunnel.ps1 -Stop    # stop cloudflared

[CmdletBinding()]
param([switch]$Stop)

$ErrorActionPreference = 'Stop'

$AM          = Join-Path $env:USERPROFILE '.agentmemory'
$CredStore   = Join-Path $PSScriptRoot 'credstore.ps1'
$VaultEntry  = 'agentmemory/TUNNEL_TOKEN'
$MetricsPort = 20241

# cloudflared serves /ready on its metrics port, and it returns 200 only
# while it holds a live connection to Cloudflare. That is the one signal
# worth trusting: a running process with no connection is not "up".
function Test-TunnelReady {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$MetricsPort/ready" -UseBasicParsing -TimeoutSec 3
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Stop-Tunnel {
  $procs = Get-Process cloudflared -ErrorAction SilentlyContinue
  if (-not $procs) { Write-Host "No cloudflared process running."; return }
  $procs | Stop-Process -Force
  Write-Host "Stopped cloudflared (pid $($procs.Id -join ', '))." -ForegroundColor Yellow
}

if ($Stop) { Stop-Tunnel; return }

if (Test-TunnelReady) {
  Write-Host "Tunnel already connected (127.0.0.1:$MetricsPort/ready = 200)." -ForegroundColor Green
  return
}

# Resolve cloudflared. PATH first; then the places winget and the MSI put it.
# No download here: an install is a deliberate step, not a side effect of
# a logon task.
$exe = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $exe) {
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe'),
    (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe')
  )
  $pkgs = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  if (Test-Path $pkgs) {
    $candidates += Get-ChildItem $pkgs -Recurse -Filter 'cloudflared*.exe' -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty FullName
  }
  $exe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $exe) {
  throw "cloudflared not found. Install it first: winget install --id Cloudflare.cloudflared -e"
}

if (-not (Test-Path $CredStore)) { throw "credstore.ps1 not found next to this script." }
$token = & $CredStore -Get -Name $VaultEntry
if ([string]::IsNullOrWhiteSpace($token)) {
  throw "Vault entry '$VaultEntry' is missing or empty -- refusing to start a tunnel with no identity."
}

# A cloudflared that is running but not ready is a stale or wedged one.
# Sweep it rather than start a second connector beside it.
Stop-Tunnel

$out = Join-Path $AM 'tunnel.log'
$err = Join-Path $AM 'tunnel.err.log'   # cloudflared logs to stderr

# The token enters the child's environment and nothing else. Cleared from
# this process the moment the child exists.
$env:TUNNEL_TOKEN = $token
try {
  $proc = Start-Process -FilePath $exe `
    -ArgumentList @('tunnel', '--no-autoupdate', '--loglevel', 'info', '--metrics', "127.0.0.1:$MetricsPort", 'run') `
    -WorkingDirectory $env:USERPROFILE `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err
} finally {
  $env:TUNNEL_TOKEN = $null
  $token = $null
}
Write-Host "cloudflared starting (pid $($proc.Id)); logs: $err" -ForegroundColor Green

for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 1
  if (Test-TunnelReady) {
    Write-Host "Tunnel connected after ${i}s: workhorse-agentmemory -> mem.inspekter.app -> 127.0.0.1:3111" -ForegroundColor Green
    return
  }
  if ($proc.HasExited) { break }
}
Write-Warning "Tunnel not connected -- last lines of $err :"
Get-Content $err -Tail 15 -ErrorAction SilentlyContinue
exit 1
