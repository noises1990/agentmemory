# Keep the daemon and its tunnel up. Runs every few minutes from the
# `agentmemory-watchdog` task (register-watchdog.ps1).
#
# Why: on 2026-09-05 the daemon's node and iii processes were alive while
# nothing answered on :3111 -- a wedge, not a crash. The tunnel stayed
# healthy and published that dead origin to the whole estate as 502 for
# hours, and the logon task that should have mattered was disabled. A
# process that exists is not a service that works; only the port is.
#
# This script decides from the ports, never from a launcher's printed
# output: Write-Host does not travel through 2>&1 in Windows PowerShell,
# and the first version logged a "tunnel: STARTED" for a tunnel that was
# already up because it parsed an empty string.

$ErrorActionPreference = 'Continue'
$S   = $PSScriptRoot
$AM  = Join-Path $env:USERPROFILE '.agentmemory'
$log = Join-Path $AM 'watchdog.log'
$RestPort    = if ($env:III_REST_PORT) { [int]$env:III_REST_PORT } else { 3111 }
$MetricsPort = 20241

function Note([string]$line) { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $line" }

# Any HTTP status from our own loopback port -- 401 included -- is a live listener.
function Test-DaemonAlive {
  try { Invoke-WebRequest -Uri "http://127.0.0.1:$RestPort/agentmemory/livez" -UseBasicParsing -TimeoutSec 5 | Out-Null; return $true }
  catch { return [bool]$_.Exception.Response }
}
# cloudflared's /ready is 200 only while it holds a connection to Cloudflare.
function Test-TunnelReady {
  try { return ((Invoke-WebRequest -Uri "http://127.0.0.1:$MetricsPort/ready" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) }
  catch { return $false }
}

if (-not (Test-DaemonAlive)) {
  Note "daemon: :$RestPort silent -- restarting"
  & "$S\start-agentmemory.ps1" *> $null
  Note "daemon: after restart alive=$(Test-DaemonAlive)"
}

if (-not (Test-TunnelReady)) {
  Note "tunnel: /ready not 200 -- starting"
  & "$S\start-tunnel.ps1" *> $null
  Note "tunnel: after start ready=$(Test-TunnelReady)"
}

# Only actions are logged, but cap the file anyway.
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 512KB)) {
  Get-Content $log -Tail 500 | Set-Content $log
}
