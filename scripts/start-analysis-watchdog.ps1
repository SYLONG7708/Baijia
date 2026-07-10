Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$StorageDir = Join-Path $Root "storage"
$LogDir = Join-Path $Root "logs"
$ReportDir = Join-Path $Root "reports"
$PidFile = Join-Path $StorageDir "analysis-watchdog.pid"
$LatestReport = Join-Path $ReportDir "analysis-watchdog-latest.json"
$MaxReportAgeSeconds = if ($env:BAIJIA_ANALYSIS_REPORT_MAX_AGE_SECONDS) { [int]$env:BAIJIA_ANALYSIS_REPORT_MAX_AGE_SECONDS } else { 1200 }
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

function Test-ReportFresh($path, [int]$maxAgeSeconds) {
  if (-not (Test-Path $path)) {
    return @{ fresh = $false; exists = $false; ageSeconds = 0; maxAgeSeconds = $maxAgeSeconds; updatedAt = "" }
  }
  $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
  if (-not $item) {
    return @{ fresh = $false; exists = $false; ageSeconds = 0; maxAgeSeconds = $maxAgeSeconds; updatedAt = "" }
  }
  $ageSeconds = [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - ([DateTimeOffset]$item.LastWriteTimeUtc).ToUnixTimeMilliseconds()) / 1000)
  return @{
    fresh = $ageSeconds -ge 0 -and $ageSeconds -le $maxAgeSeconds
    exists = $true
    ageSeconds = $ageSeconds
    maxAgeSeconds = $maxAgeSeconds
    updatedAt = $item.LastWriteTimeUtc.ToString("o")
  }
}

if (Test-Path $PidFile) {
  $existingRaw = Get-Content -Path $PidFile -ErrorAction SilentlyContinue
  $existingPid = 0
  if ($existingRaw -and [int]::TryParse($existingRaw.Trim(), [ref]$existingPid) -and $existingPid -gt 0) {
    $commandLine = (Get-ProcessCommandLine $existingPid).ToLowerInvariant()
    if ($commandLine.Contains("node") -and $commandLine.Contains("run-analysis-watchdog.mjs")) {
      $process = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
      $runnerMtime = (Get-Item -LiteralPath $MyInvocation.MyCommand.Path).LastWriteTime
      $watchdogMtime = (Get-Item -LiteralPath (Join-Path $Root "scripts\run-analysis-watchdog.mjs")).LastWriteTime
      $reportFresh = Test-ReportFresh $LatestReport $MaxReportAgeSeconds
      $processAgeSeconds = if ($process) { [int]((Get-Date) - $process.StartTime).TotalSeconds } else { 999999 }
      $isFreshStarting = (-not $reportFresh.exists) -and $processAgeSeconds -le 180
      $isStale = $process -and (
        $process.StartTime -lt $runnerMtime -or
        $process.StartTime -lt $watchdogMtime -or
        ((-not $reportFresh.fresh) -and (-not $isFreshStarting))
      )
      if (-not $isStale) {
        [pscustomobject]@{
          ok = $true
          alreadyRunning = $true
          pid = $existingPid
          reportFresh = $reportFresh
          processAgeSeconds = $processAgeSeconds
          latestReport = (Join-Path $ReportDir "analysis-watchdog-latest.json")
        } | ConvertTo-Json -Depth 4
        exit 0
      }
      Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
    }
  }
}

$env:BAIJIA_WATCH_ANALYZE_ALL_LIMIT = "7200"
$env:BAIJIA_WATCH_ANALYZE_TABLE_LIMIT = "1200"
$env:BAIJIA_WATCH_BACKTEST_HISTORY_LIMIT = "480"
$env:BAIJIA_WATCH_BACKTEST_MANUAL_HISTORY_LIMIT = "8"

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
