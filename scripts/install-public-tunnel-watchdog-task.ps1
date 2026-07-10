$ErrorActionPreference = "Stop"

$TaskName = "BaijiaPublicTunnelWatchdog"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Runner = Join-Path $ProjectRoot "scripts\check-public-tunnel.ps1"
$UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path $Runner)) {
  throw "Public tunnel watchdog runner not found: $Runner"
}

$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Runner`""

$Triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn),
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650))
)

$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -Hidden `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Triggers `
  -Principal $Principal `
  -Settings $Settings `
  -Description "Checks Baijia localhost, analysis watchdog, and public Cloudflare tunnel every 5 minutes; restarts unhealthy parts." `
  -Force | Out-Null

Write-Host "Created task: $TaskName"
Write-Host "Runs at startup, logon, and every 5 minutes."
Write-Host "Start manually: Start-ScheduledTask -TaskName $TaskName"
