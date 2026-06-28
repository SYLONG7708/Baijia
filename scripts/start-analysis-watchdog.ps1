Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$StorageDir = Join-Path $Root "storage"
$LogDir = Join-Path $Root "logs"
$ReportDir = Join-Path $Root "reports"
$PidFile = Join-Path $StorageDir "analysis-watchdog.pid"
New-Item -ItemType Directory -Force -Path $StorageDir, $LogDir, $ReportDir | Out-Null

function Get-ProcessCommandLine($processId) {
  if (-not $processId) { return "" }
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
    return [string]$process.CommandLine
  } catch {
    return ""
  }
}

if (Test-Path $PidFile) {
  $existingRaw = Get-Content -Path $PidFile -ErrorAction SilentlyContinue
  $existingPid = 0
  if ($existingRaw -and [int]::TryParse($existingRaw.Trim(), [ref]$existingPid) -and $existingPid -gt 0) {
    $commandLine = (Get-ProcessCommandLine $existingPid).ToLowerInvariant()
    if ($commandLine.Contains("node") -and $commandLine.Contains("run-analysis-watchdog.mjs")) {
      [pscustomobject]@{
        ok = $true
        alreadyRunning = $true
        pid = $existingPid
        latestReport = (Join-Path $ReportDir "analysis-watchdog-latest.json")
      } | ConvertTo-Json -Depth 4
      exit 0
    }
  }
}

$stdout = Join-Path $LogDir "analysis-watchdog.log"
$stderr = Join-Path $LogDir "analysis-watchdog.err.log"
$process = Start-Process `
  -FilePath "node" `
  -ArgumentList @("scripts/run-analysis-watchdog.mjs") `
  -WorkingDirectory $Root `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -WindowStyle Hidden `
  -PassThru

Set-Content -Path $PidFile -Value $process.Id -Encoding UTF8
[pscustomobject]@{
  ok = $true
  pid = $process.Id
  stdout = $stdout
  stderr = $stderr
  latestReport = (Join-Path $ReportDir "analysis-watchdog-latest.json")
} | ConvertTo-Json -Depth 4
