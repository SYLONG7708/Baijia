$ErrorActionPreference = "Stop"

$TaskName = "BaijiaAnalysisWatchdog"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Runner = Join-Path $ProjectRoot "scripts\start-analysis-watchdog.ps1"
$UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path $Runner)) {
  throw "Analysis watchdog runner not found: $Runner"
}

$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Runner`""
$Triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn),
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 15) `
    -RepetitionDuration (New-TimeSpan -Days 3650))
)
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -Hidden `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Days 365) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 2)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Triggers `
  -Principal $Principal `
  -Settings $Settings `
  -Description "Baijia analysis API watchdog and speed monitor" `
  -Force | Out-Null

Write-Host "Created task: $TaskName"
Write-Host "Runs at startup, logon, and every 15 minutes as a self-start guard."
Write-Host "Start manually: Start-ScheduledTask -TaskName $TaskName"
