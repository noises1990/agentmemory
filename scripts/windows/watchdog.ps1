# Keep the daemon and its tunnel up. Runs every few minutes from the
# `agentmemory-watchdog` task (register-watchdog.ps1).
#
# Why: on 2026-09-05 the daemon's node and iii processes were alive while
# nothing answered on :3111 -- a wedge, not a crash. The tunnel stayed
# healthy and published that dead origin to the whole estate as 502 for
# hours, and the logon task that should have mattered was disabled. A
# process that exists is not a service that works; only the port is.
#
# Both launchers are idempotent in this mode: start-agentmemory -IfDown
# restarts only when :3111 gives no HTTP answer at all, and start-tunnel
# returns immediately when cloudflared's /ready is 200.

$ErrorActionPreference = 'Continue'
$S = $PSScriptRoot
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$log = Join-Path (Join-Path $env:USERPROFILE '.agentmemory') 'watchdog.log'

function Note([string]$line) { Add-Content -Path $log -Value "$stamp $line" }

$d = & "$S\start-agentmemory.ps1" -IfDown 2>&1 | Out-String
if ($d -match 'restarting') { Note "daemon: RESTARTED ($($d.Trim() -replace '\s+',' '))" }

$t = & "$S\start-tunnel.ps1" 2>&1 | Out-String
if ($t -notmatch 'already connected') { Note "tunnel: STARTED ($($t.Trim() -replace '\s+',' '))" }

# Keep the log from growing without bound: only actions are logged, but cap it anyway.
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 512KB)) {
  Get-Content $log -Tail 500 | Set-Content $log
}
