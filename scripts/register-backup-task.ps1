<#
.SYNOPSIS
  Register (or remove) the Windows Scheduled Task that runs the daily Firestore backup.

.DESCRIPTION
  Creates a task that runs scripts\daily-backup.ps1 every day at 04:00, writing a
  single overwritten backup file into OneDrive.

  The task runs as the current user with "run only when logged on", because
  OneDrive only syncs while that user is signed in. StartWhenAvailable means a run
  missed while the machine was off/asleep fires as soon as it is available again.

.EXAMPLE
  .\scripts\register-backup-task.ps1

.EXAMPLE
  .\scripts\register-backup-task.ps1 -At 03:30 -Database test

.EXAMPLE
  .\scripts\register-backup-task.ps1 -Remove
#>
[CmdletBinding()]
param(
    [string]   $TaskName = 'Attendance-Web-App Firestore Daily Backup',
    [datetime] $At       = (Get-Date -Hour 4 -Minute 0 -Second 0 -Millisecond 0),
    [string]   $Database = '(default)',
    [string]   $Dest,
    [switch]   $Remove
)

$ErrorActionPreference = 'Stop'

$ProjectRoot  = Split-Path -Parent $PSScriptRoot
$BackupScript = Join-Path $ProjectRoot 'scripts\daily-backup.ps1'

if ($Remove) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Removed scheduled task: $TaskName"
    } else {
        Write-Output "No scheduled task named '$TaskName' found - nothing to remove."
    }
    return
}

if (-not (Test-Path $BackupScript)) { throw "Not found: $BackupScript" }

$psArgs = @(
    '-NoProfile'
    '-NonInteractive'
    '-ExecutionPolicy', 'Bypass'
    '-WindowStyle', 'Hidden'
    '-File', ('"{0}"' -f $BackupScript)
    '-Database', ('"{0}"' -f $Database)
)
if ($Dest) { $psArgs += @('-Dest', ('"{0}"' -f $Dest)) }

$action = New-ScheduledTaskAction `
    -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Argument ($psArgs -join ' ') `
    -WorkingDirectory $ProjectRoot

$trigger = New-ScheduledTaskTrigger -Daily -At $At

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -WakeToRun `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)

$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

# Re-registering with the same name replaces the previous definition.
Register-ScheduledTask `
    -TaskName    $TaskName `
    -Description 'Backs up the Firestore (default) database to OneDrive, overwriting the previous copy. See scripts/daily-backup.ps1.' `
    -Action      $action `
    -Trigger     $trigger `
    -Settings    $settings `
    -Principal   $principal `
    -Force | Out-Null

$info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
Write-Output "Registered scheduled task: $TaskName"
Write-Output ("  Daily at:  {0}" -f $At.ToString('HH:mm'))
Write-Output ("  Next run:  {0}" -f $info.NextRunTime)
Write-Output ("  Runs:      powershell -File {0} -Database {1}" -f $BackupScript, $Database)
Write-Output ''
Write-Output "Run it now with:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Output "Remove it with:   .\scripts\register-backup-task.ps1 -Remove"
