# Register (or remove) the per-user `agentmemory-watchdog` task: runs
# watchdog.ps1 every 5 minutes while this user is logged on.
#
# Same principal rules as register-autostart.ps1 -- interactive logon
# type, no elevation -- because both launchers read Windows Credential
# Manager, which DPAPI only opens inside the user's own session.
#
# Usage:
#   .\register-watchdog.ps1
#   .\register-watchdog.ps1 -Status
#   .\register-watchdog.ps1 -Unregister

[CmdletBinding(DefaultParameterSetName = 'Register')]
param(
  [Parameter(ParameterSetName = 'Status')]     [switch]$Status,
  [Parameter(ParameterSetName = 'Unregister')] [switch]$Unregister,
  [Parameter(ParameterSetName = 'Register')]   [int]$EveryMinutes = 5
)

$ErrorActionPreference = 'Stop'
$TaskName = 'agentmemory-watchdog'
$Script   = Join-Path $PSScriptRoot 'watchdog.ps1'

function Get-WatchdogTask { try { Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { $null } }

if ($Status) {
  $task = Get-WatchdogTask
  if (-not $task) { Write-Host "Not registered." -ForegroundColor Yellow; return }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host "Task       : $TaskName"
  Write-Host "State      : $($task.State)"
  Write-Host "Runs as    : $($task.Principal.UserId) (logon type $($task.Principal.LogonType))"
  Write-Host "Last run   : $($info.LastRunTime)"
  Write-Host "Last result: $($info.LastTaskResult)"
  Write-Host "Next run   : $($info.NextRunTime)"
  return
}

if ($Unregister) {
  if (-not (Get-WatchdogTask)) { Write-Host "Not registered -- nothing to do." -ForegroundColor Yellow; return }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  return
}

if (-not (Test-Path $Script)) { throw "watchdog.ps1 not found at $Script." }

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $psExe `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`"" `
  -WorkingDirectory $env:USERPROFILE

# Start shortly after logon, then repeat. RepetitionDuration left unset = indefinitely.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)

$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$logon.Delay = 'PT45S'

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 4)

if (Get-WatchdogTask) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Replacing existing '$TaskName' task."
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $trigger) -Principal $principal -Settings $settings `
  -Description 'Every few minutes: restart agentmemory only if :3111 is silent; start the mem.inspekter.app tunnel if its /ready is not 200.' | Out-Null

Write-Host "Registered '$TaskName' -- every $EveryMinutes min as $env:USERNAME." -ForegroundColor Green
Write-Host "  Check:  .\register-watchdog.ps1 -Status"
Write-Host "  Log:    $(Join-Path (Join-Path $env:USERPROFILE '.agentmemory') 'watchdog.log') (actions only)"
