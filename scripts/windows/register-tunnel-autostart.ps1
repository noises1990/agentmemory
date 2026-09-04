# Register (or remove) a per-user Scheduled Task that starts the
# mem.inspekter.app tunnel at logon.
#
# Mirrors register-autostart.ps1 exactly, and for the same reason: the
# tunnel token lives in Windows Credential Manager under DPAPI, so the
# task has to run as the interactive user. A SYSTEM service could not
# read it.
#
# The delay is longer than the daemon's (45s) on purpose: a tunnel that
# connects before the daemon listens on :3111 would publish 502s to the
# estate for the gap.
#
# Usage:
#   .\register-tunnel-autostart.ps1              # register / refresh
#   .\register-tunnel-autostart.ps1 -Status
#   .\register-tunnel-autostart.ps1 -Unregister

[CmdletBinding(DefaultParameterSetName = 'Register')]
param(
  [Parameter(ParameterSetName = 'Status')]     [switch]$Status,
  [Parameter(ParameterSetName = 'Unregister')] [switch]$Unregister,
  [Parameter(ParameterSetName = 'Register')]   [int]$DelaySeconds = 75
)

$ErrorActionPreference = 'Stop'

$TaskName = 'agentmemory-tunnel'
$AM       = Join-Path $env:USERPROFILE '.agentmemory'
$Launcher = (Join-Path $PSScriptRoot 'start-tunnel.ps1')

function Get-TunnelTask {
  try { Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { $null }
}

if ($Status) {
  $task = Get-TunnelTask
  if (-not $task) { Write-Host "Not registered." -ForegroundColor Yellow; return }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host "Task       : $TaskName"
  Write-Host "State      : $($task.State)"
  Write-Host "Runs as    : $($task.Principal.UserId) (logon type $($task.Principal.LogonType))"
  Write-Host "Last run   : $($info.LastRunTime)"
  Write-Host "Last result: $($info.LastTaskResult)"
  return
}

if ($Unregister) {
  if (-not (Get-TunnelTask)) { Write-Host "Not registered -- nothing to do." -ForegroundColor Yellow; return }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  return
}

if (-not (Test-Path $Launcher)) {
  throw "Launcher not found at $Launcher -- refusing to register a task that would fail at every logon."
}

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$action = New-ScheduledTaskAction -Execute $psExe `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`"" `
  -WorkingDirectory $env:USERPROFILE

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = "PT${DelaySeconds}S"

$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

if (Get-TunnelTask) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Replacing existing '$TaskName' task."
}

Register-ScheduledTask -TaskName $TaskName `
  -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Starts the mem.inspekter.app Cloudflare Tunnel at logon, token injected from Windows Credential Manager.' | Out-Null

Write-Host "Registered '$TaskName' -- starts ${DelaySeconds}s after logon as $env:USERNAME." -ForegroundColor Green
Write-Host "  Check:  .\register-tunnel-autostart.ps1 -Status"
Write-Host "  Remove: .\register-tunnel-autostart.ps1 -Unregister"
Write-Host "  Logs:   $(Join-Path $AM 'tunnel.err.log')"
