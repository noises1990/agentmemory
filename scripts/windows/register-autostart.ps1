# Register (or remove) a per-user Scheduled Task that starts agentmemory
# at logon.
#
# Why a logon task and not a Windows service:
#
# The Cloudflare token lives in Windows Credential Manager, encrypted at
# rest by DPAPI under this user account. DPAPI decryption needs the
# user's own logon session, so the task MUST run as the interactive user.
# A service under SYSTEM, or a task set to "run whether user is logged on
# or not", cannot read the credential -- the daemon would start with no
# provider and silently degrade to zero-LLM rather than failing loudly.
#
# No elevation required: a task scoped to the current user registers
# without admin rights, and no password is ever stored.
#
# Usage:
#   .\register-autostart.ps1              # register / refresh the task
#   .\register-autostart.ps1 -Status      # show task state and last result
#   .\register-autostart.ps1 -Unregister  # remove the task

[CmdletBinding(DefaultParameterSetName = 'Register')]
param(
  [Parameter(ParameterSetName = 'Status')]     [switch]$Status,
  [Parameter(ParameterSetName = 'Unregister')] [switch]$Unregister,

  # Seconds to wait after logon before starting. The engine binds four
  # ports and opens the vector index; starting it inside the logon storm
  # makes it compete with everything else for disk.
  [Parameter(ParameterSetName = 'Register')]
  [int]$DelaySeconds = 45
)

$ErrorActionPreference = 'Stop'

$TaskName = 'agentmemory'
$AM       = Join-Path $env:USERPROFILE '.agentmemory'

# The launcher sitting next to this script. Resolved to an absolute path
# because Task Scheduler runs with its own working directory -- a
# relative path here would register a task that fails at every logon.
$Launcher = (Join-Path $PSScriptRoot 'start-agentmemory.ps1')

function Get-AgentMemoryTask {
  try { Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { $null }
}

if ($Status) {
  $task = Get-AgentMemoryTask
  if (-not $task) { Write-Host "Not registered." -ForegroundColor Yellow; return }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host "Task       : $TaskName"
  Write-Host "State      : $($task.State)"
  Write-Host "Runs as    : $($task.Principal.UserId) (logon type $($task.Principal.LogonType))"
  Write-Host "Last run   : $($info.LastRunTime)"
  # 0 = last run succeeded. 267011 = has not run yet.
  Write-Host "Last result: $($info.LastTaskResult)"
  return
}

if ($Unregister) {
  if (-not (Get-AgentMemoryTask)) {
    Write-Host "Not registered -- nothing to do." -ForegroundColor Yellow
    return
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  Write-Host "agentmemory will no longer start at logon. Start it manually with start-agentmemory.ps1."
  return
}

if (-not (Test-Path $Launcher)) {
  throw "Launcher not found at $Launcher -- refusing to register a task that would fail at every logon."
}

# Windows PowerShell 5.1 rather than pwsh: 5.1 ships with every Windows
# install, so the task keeps working if pwsh is moved or uninstalled. The
# launcher is ASCII-only and parses under both.
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$action = New-ScheduledTaskAction -Execute $psExe `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`"" `
  -WorkingDirectory $env:USERPROFILE

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = "PT${DelaySeconds}S"

# Interactive: run inside the logged-on session so DPAPI can decrypt the
# credential vault. RunLevel Limited: no elevation, nothing here needs it.
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

# ExecutionTimeLimit of zero means no limit. The launcher exits once the
# daemon answers /livez, but Task Scheduler's default 3-day cap would
# otherwise apply to the whole action.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

if (Get-AgentMemoryTask) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Replacing existing '$TaskName' task."
}

Register-ScheduledTask -TaskName $TaskName `
  -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Starts the agentmemory daemon at logon, with API tokens injected from Windows Credential Manager.' | Out-Null

Write-Host "Registered '$TaskName' -- starts ${DelaySeconds}s after logon as $env:USERNAME." -ForegroundColor Green
Write-Host "  Check:  .\register-autostart.ps1 -Status"
Write-Host "  Remove: .\register-autostart.ps1 -Unregister"
Write-Host "  Logs:   $(Join-Path $AM 'daemon.log')"
