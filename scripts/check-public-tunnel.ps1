$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$StorageDir = Join-Path $ProjectRoot "storage"
$ReportDir = Join-Path $ProjectRoot "reports"
$LogDir = Join-Path $ProjectRoot "logs"
$TunnelUrlFile = Join-Path $StorageDir "baijia-public-tunnel.url"
$TunnelPidFile = Join-Path $StorageDir "baijia-public-tunnel.pid"
$DaemonPidFile = Join-Path $StorageDir "baijia-daemon.pid"
$DaemonHeartbeatFile = Join-Path $StorageDir "baijia-daemon.heartbeat"
$DaemonLockFile = Join-Path $StorageDir "baijia-run-daemon.ps1.lock"
$TunnelRunner = Join-Path $ProjectRoot "scripts\start-public-tunnel.ps1"
$DaemonRunner = Join-Path $ProjectRoot "scripts\run-daemon.ps1"
$AnalysisRunner = Join-Path $ProjectRoot "scripts\start-analysis-watchdog.ps1"
$AnalysisPidFile = Join-Path $StorageDir "analysis-watchdog.pid"
$AnalysisLatestReport = Join-Path $ReportDir "analysis-watchdog-latest.json"
$LatestReport = Join-Path $ReportDir "public-tunnel-watchdog-latest.json"
$ReportLog = Join-Path $ReportDir "public-tunnel-watchdog.ndjson"
$Port = if ($env:PORT) { [int]$env:PORT } else { 4173 }
$LocalBaseUrl = "http://127.0.0.1:$Port"
$MonitorTaskName = "BaijiaMonitor24H"
$AnalysisTaskName = "BaijiaAnalysisWatchdog"
$AnalysisReportMaxAgeSeconds = if ($env:BAIJIA_ANALYSIS_REPORT_MAX_AGE_SECONDS) { [int]$env:BAIJIA_ANALYSIS_REPORT_MAX_AGE_SECONDS } else { 1200 }

New-Item -ItemType Directory -Force -Path $StorageDir, $ReportDir, $LogDir | Out-Null
Set-Location $ProjectRoot

function Get-ProcessCommandLine($processId) {
  if (-not $processId) { return "" }
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
    return [string]$process.CommandLine
  } catch {
    return ""
  }
}

function Remove-StalePidFile($path, [string[]]$needles) {
  if (-not (Test-Path $path)) {
    return @{ removed = $false; pid = 0; reason = "missing" }
  }
  $storage = Resolve-Path $StorageDir
  $target = Resolve-Path $path
  if (-not $target.Path.StartsWith($storage.Path)) {
    throw "Refuse to touch pid file outside storage: $($target.Path)"
  }
  $raw = (Get-Content -Raw -Path $target.Path -ErrorAction SilentlyContinue).Trim()
  $pidValue = 0
  if (-not [int]::TryParse($raw, [ref]$pidValue) -or $pidValue -le 0) {
    Remove-Item -LiteralPath $target.Path -Force -ErrorAction SilentlyContinue
    return @{ removed = $true; pid = 0; reason = "invalid" }
  }
  $commandLine = (Get-ProcessCommandLine $pidValue).ToLowerInvariant()
  if (-not $commandLine) {
    Remove-Item -LiteralPath $target.Path -Force -ErrorAction SilentlyContinue
    return @{ removed = $true; pid = $pidValue; reason = "dead" }
  }
  foreach ($needle in $needles) {
    if (-not $commandLine.Contains($needle.ToLowerInvariant())) {
      Remove-Item -LiteralPath $target.Path -Force -ErrorAction SilentlyContinue
      return @{ removed = $true; pid = $pidValue; reason = "wrong-process" }
    }
  }
  return @{ removed = $false; pid = $pidValue; reason = "alive" }
}

function Stop-MonitorProcesses([string]$reason) {
  $candidatePids = New-Object System.Collections.Generic.HashSet[int]
  foreach ($path in @($DaemonPidFile, $DaemonLockFile)) {
    if (-not (Test-Path $path)) { continue }
    $raw = (Get-Content -Raw -Path $path -ErrorAction SilentlyContinue).Trim()
    $pidValue = 0
    if ([int]::TryParse($raw, [ref]$pidValue) -and $pidValue -gt 0 -and $pidValue -ne $PID) {
      [void]$candidatePids.Add($pidValue)
    }
  }

  $daemonPath = (Join-Path $ProjectRoot "src\daemon.js").ToLowerInvariant()
  $daemonPathAlt = $daemonPath.Replace("\", "/")
  $workerPath = (Join-Path $ProjectRoot "src\collector-worker.js").ToLowerInvariant()
  $workerPathAlt = $workerPath.Replace("\", "/")
  $runnerPath = (Join-Path $ProjectRoot "scripts\run-daemon.ps1").ToLowerInvariant()
  $runnerPathAlt = $runnerPath.Replace("\", "/")
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
    $commandLine = ([string]$_.CommandLine).ToLowerInvariant()
    if ($_.ProcessId -eq $PID -or -not $commandLine) { return }
    if ($commandLine.Contains($daemonPath) -or $commandLine.Contains($daemonPathAlt) -or $commandLine.Contains($workerPath) -or $commandLine.Contains($workerPathAlt) -or $commandLine.Contains($runnerPath) -or $commandLine.Contains($runnerPathAlt)) {
      [void]$candidatePids.Add([int]$_.ProcessId)
    }
  }

  foreach ($candidatePid in $candidatePids) {
    try {
      Stop-Process -Id $candidatePid -Force -ErrorAction Stop
    } catch {}
  }

  if ($candidatePids.Count -gt 0) {
    Start-Sleep -Seconds 2
  }
  Remove-Item -Path $DaemonPidFile, $DaemonHeartbeatFile, $DaemonLockFile -Force -ErrorAction SilentlyContinue
  return @{ stopped = $candidatePids.Count; reason = $reason }
}

function Test-CollectorStale($endpointResult) {
  $collector = $endpointResult.summary.collector
  if (-not $collector) {
    return @{ stale = $false; reason = "no-collector"; ageSeconds = 0; thresholdSeconds = 0 }
  }

  $thresholdMs = 900000
  $configuredTimeoutMs = 0
  if ([int]::TryParse([string]$env:COLLECT_RUN_TIMEOUT_MS, [ref]$configuredTimeoutMs) -and $configuredTimeoutMs -gt 0) {
    $thresholdMs = [Math]::Max($thresholdMs, $configuredTimeoutMs + 180000)
  }

  $startedAtMs = 0
  $parsedStartedAt = [DateTimeOffset]::MinValue
  if ($collector.runInProgress -eq $true -and [DateTimeOffset]::TryParse([string]$collector.runStartedAt, [ref]$parsedStartedAt)) {
    $startedAtMs = $parsedStartedAt.ToUnixTimeMilliseconds()
  }
  if ($startedAtMs -gt 0) {
    $ageMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $startedAtMs
    if ($ageMs -gt $thresholdMs) {
      return @{
        stale = $true
        reason = "collector-run-stale"
        ageSeconds = [int]($ageMs / 1000)
        thresholdSeconds = [int]($thresholdMs / 1000)
      }
    }
    return @{
      stale = $false
      reason = "fresh-running"
      ageSeconds = [int]($ageMs / 1000)
      thresholdSeconds = [int]($thresholdMs / 1000)
    }
  }

  return @{ stale = $false; reason = "fresh"; ageSeconds = 0; thresholdSeconds = [int]($thresholdMs / 1000) }
}

function Test-DaemonHeartbeat([int]$maxAgeSeconds = 180) {
  if (-not (Test-Path $DaemonHeartbeatFile)) {
    return @{ fresh = $false; exists = $false; ageSeconds = 0; maxAgeSeconds = $maxAgeSeconds; updatedAt = "" }
  }
  $raw = (Get-Content -Raw -Path $DaemonHeartbeatFile -ErrorAction SilentlyContinue).Trim()
  $parsed = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse($raw, [ref]$parsed)) {
    return @{ fresh = $false; exists = $true; ageSeconds = 0; maxAgeSeconds = $maxAgeSeconds; updatedAt = $raw }
  }
  $ageSeconds = [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $parsed.ToUnixTimeMilliseconds()) / 1000)
  return @{
    fresh = $ageSeconds -ge 0 -and $ageSeconds -le $maxAgeSeconds
    exists = $true
    ageSeconds = $ageSeconds
    maxAgeSeconds = $maxAgeSeconds
    updatedAt = $parsed.ToUniversalTime().ToString("o")
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

function Stop-ScheduledTaskInstance([string]$taskName, [string]$reason) {
  try {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ($task.State -eq "Running") {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
      return @{ stopped = $true; taskName = $taskName; reason = $reason }
    }
    return @{ stopped = $false; taskName = $taskName; state = [string]$task.State; reason = "not-running" }
  } catch {
    return @{ stopped = $false; taskName = $taskName; reason = "task-missing"; error = $_.Exception.Message }
  }
}

function Test-JsonEndpoint($url) {
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20
    $text = [string]$response.Content
    $json = $null
    try { $json = $text | ConvertFrom-Json -ErrorAction Stop } catch {}
    $summary = $null
    if ($json) {
      $summary = [ordered]@{
        ok = [bool]$json.ok
        publicView = [bool]$json.publicView
        tables = $json.tables
        allbetTables = $json.allbetTables
        rounds = $json.rounds
        snapshots = $json.snapshots
        updatedAt = $json.updatedAt
      }
      if ($json.collector) {
        $summary["collector"] = [ordered]@{
          enabled = $json.collector.enabled
          lastRunAt = $json.collector.lastRunAt
          lastOkAt = $json.collector.lastOkAt
          lastSuccessAt = $json.collector.lastSuccessAt
          runStartedAt = $json.collector.runStartedAt
          lastMessage = $json.collector.lastMessage
          lastError = $json.collector.lastError
          streakFailures = $json.collector.streakFailures
          runInProgress = $json.collector.runInProgress
          runIntervalMs = $json.collector.runIntervalMs
          expectedBaccaratTables = $json.collector.expectedBaccaratTables
          detectedBaccaratTables = $json.collector.detectedBaccaratTables
          detailCapturedTables = $json.collector.detailCapturedTables
          missingBaccaratTables = $json.collector.missingBaccaratTables
        }
      }
    }
    return @{
      ok = ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300 -and $json -and $json.ok -eq $true)
      status = [int]$response.StatusCode
      error = ""
      summary = $summary
      bytes = [Text.Encoding]::UTF8.GetByteCount($text)
    }
  } catch {
    $status = 0
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $status = [int]$_.Exception.Response.StatusCode
    }
    return @{
      ok = $false
      status = $status
      error = $_.Exception.Message
      summary = $null
      bytes = 0
    }
  }
}

function Test-LocalMonitorHealthy {
  $pingResult = Test-JsonEndpoint "$LocalBaseUrl/api/ping"
  $statusResult = Test-JsonEndpoint "$LocalBaseUrl/api/status"
  return @{
    ok = [bool]($pingResult.ok -and $statusResult.ok)
    ping = $pingResult
    status = $statusResult
  }
}

function Wait-LocalMonitorHealthy([int]$seconds = 70) {
  $last = Test-LocalMonitorHealthy
  if ($last.ok) { return $last }
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $last = Test-LocalMonitorHealthy
    if ($last.ok) { break }
  }
  return $last
}

function Start-MonitorRunnerDirect([string]$reason) {
  if (-not (Test-Path $DaemonRunner)) {
    return @{ started = $false; action = "runner-missing"; pid = 0; reason = $reason }
  }
  try {
    $process = Start-Process -FilePath "powershell.exe" `
      -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $DaemonRunner) `
      -WorkingDirectory $ProjectRoot `
      -WindowStyle Hidden `
      -PassThru
    return @{ started = $true; action = "direct-runner"; pid = $process.Id; reason = $reason }
  } catch {
    return @{ started = $false; action = "direct-runner-failed"; pid = 0; reason = $reason; error = $_.Exception.Message }
  }
}

function Start-MonitorIfNeeded {
  $ping = Test-JsonEndpoint "$LocalBaseUrl/api/ping"
  $first = Test-JsonEndpoint "$LocalBaseUrl/api/status"
  $collectorStale = if ($first.ok) { Test-CollectorStale $first } else { @{ stale = $false; reason = "local-down"; ageSeconds = 0; thresholdSeconds = 0 } }
  if ($first.ok -and $ping.ok -and -not $collectorStale.stale) {
    return @{ ok = $true; started = $false; ping = $ping; first = $first; final = $first; action = "already-up"; collectorStale = $collectorStale }
  }

  $daemonHeartbeat = Test-DaemonHeartbeat 180
  $retry = $null
  if (-not $first.ok -and $daemonHeartbeat.fresh) {
    Start-Sleep -Seconds 10
    $retry = Test-JsonEndpoint "$LocalBaseUrl/api/status"
    if ($retry.ok) {
      return @{
        ok = $true
        started = $false
        ping = $ping
        first = $first
        final = $retry
        action = "transient-local-timeout"
        collectorStale = Test-CollectorStale $retry
        daemonHeartbeat = $daemonHeartbeat
      }
    }
  }

  $restartCleanup = $null
  $taskCleanup = $null
  $restartReason = ""
  if (-not $first.ok) {
    $restartReason = if ($ping.ok) { "local-status-unresponsive" } else { "local-http-unresponsive" }
  } elseif (-not $ping.ok) {
    $restartReason = "local-ping-unhealthy"
  } elseif ($collectorStale.stale) {
    $restartReason = $collectorStale.reason
  }
  if ($restartReason) {
    $taskCleanup = Stop-ScheduledTaskInstance $MonitorTaskName $restartReason
    $restartCleanup = Stop-MonitorProcesses $restartReason
  }

  $daemonPidCleanup = Remove-StalePidFile $DaemonPidFile @("node", "src\daemon.js")
  $daemonLockCleanup = Remove-StalePidFile $DaemonLockFile @("powershell", "run-daemon.ps1")
  $started = $false
  $action = "none"
  $directStart = $null
  $scheduledFinal = $null
  $fallbackCleanup = $null
  $fallbackTaskCleanup = $null

  try {
    Start-ScheduledTask -TaskName $MonitorTaskName -ErrorAction Stop
    $started = $true
    $action = "scheduled-task"
  } catch {
    $directStart = Start-MonitorRunnerDirect "scheduled-task-unavailable"
    $started = [bool]$directStart.started
    $action = $directStart.action
  }

  $health = Wait-LocalMonitorHealthy 70
  if (-not $health.ok -and $action -eq "scheduled-task") {
    $scheduledFinal = $health
    $fallbackTaskCleanup = Stop-ScheduledTaskInstance $MonitorTaskName "scheduled-task-start-failed"
    $fallbackCleanup = Stop-MonitorProcesses "scheduled-task-start-failed"
    $daemonPidCleanup = Remove-StalePidFile $DaemonPidFile @("node", "src\daemon.js")
    $daemonLockCleanup = Remove-StalePidFile $DaemonLockFile @("powershell", "run-daemon.ps1")
    $directStart = Start-MonitorRunnerDirect "scheduled-task-start-failed"
    if ($directStart.started) {
      $started = $true
      $action = "scheduled-task->direct-runner"
      $health = Wait-LocalMonitorHealthy 90
    } else {
      $action = "scheduled-task->direct-runner-failed"
    }
  }

  return @{
    ok = $health.ok
    started = $started
    action = $action
    first = $first
    retry = $retry
    final = $health.status
    finalPing = $health.ping
    collectorStale = $collectorStale
    daemonHeartbeat = $daemonHeartbeat
    ping = $ping
    taskCleanup = $taskCleanup
    restartCleanup = $restartCleanup
    scheduledFinal = $scheduledFinal
    fallbackTaskCleanup = $fallbackTaskCleanup
    fallbackCleanup = $fallbackCleanup
    directStart = $directStart
    daemonPidCleanup = $daemonPidCleanup
    daemonLockCleanup = $daemonLockCleanup
  }
}

function Get-PublicUrl {
  if (-not (Test-Path $TunnelUrlFile)) { return "" }
  return (Get-Content -Raw -Path $TunnelUrlFile -ErrorAction SilentlyContinue).Trim()
}

function Ensure-PublicTunnel {
  $initialUrl = Get-PublicUrl
  $initial = if ($initialUrl) { Test-JsonEndpoint "$initialUrl/api/status" } else { @{ ok = $false; status = 0; error = "missing url"; bytes = 0 } }
  if ($initial.ok) {
    return @{ ok = $true; restarted = $false; url = $initialUrl; initial = $initial; final = $initial; action = "already-up" }
  }

  $tunnelPidCleanup = Remove-StalePidFile $TunnelPidFile @("cloudflared", "tunnel")
  if (-not (Test-Path $TunnelRunner)) {
    return @{ ok = $false; restarted = $false; url = $initialUrl; initial = $initial; final = $initial; action = "runner-missing"; tunnelPidCleanup = $tunnelPidCleanup }
  }

  $output = ""
  $restartError = ""
  try {
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $TunnelRunner 2>&1 | Out-String
  } catch {
    $restartError = $_.Exception.Message
  }

  $finalUrl = Get-PublicUrl
  $final = if ($finalUrl) { Test-JsonEndpoint "$finalUrl/api/status" } else { @{ ok = $false; status = 0; error = "missing url after restart"; bytes = 0 } }
  return @{
    ok = $final.ok
    restarted = $true
    url = $finalUrl
    initial = $initial
    final = $final
    action = "restart-tunnel"
    tunnelPidCleanup = $tunnelPidCleanup
    output = $output.Trim()
    restartError = $restartError
  }
}

function Ensure-AnalysisWatchdog {
  $pidCleanup = Remove-StalePidFile $AnalysisPidFile @("node", "run-analysis-watchdog.mjs")
  $reportFresh = Test-ReportFresh $AnalysisLatestReport $AnalysisReportMaxAgeSeconds
  if ($pidCleanup.reason -eq "alive") {
    $processAgeSeconds = 999999
    try {
      $process = Get-Process -Id $pidCleanup.pid -ErrorAction Stop
      $processAgeSeconds = [int]((Get-Date) - $process.StartTime).TotalSeconds
    } catch {}
    if ($reportFresh.fresh -or ((-not $reportFresh.exists) -and $processAgeSeconds -le 180)) {
      return @{ ok = $true; started = $false; action = "already-up"; pid = $pidCleanup.pid; pidCleanup = $pidCleanup; reportFresh = $reportFresh; processAgeSeconds = $processAgeSeconds }
    }
    try {
      Stop-Process -Id $pidCleanup.pid -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
    } catch {}
    Remove-Item -LiteralPath $AnalysisPidFile -Force -ErrorAction SilentlyContinue
    $pidCleanup = @{ removed = $true; pid = $pidCleanup.pid; reason = "stale-report" }
  }

  if (-not (Test-Path $AnalysisRunner)) {
    return @{ ok = $false; started = $false; action = "runner-missing"; pid = 0; pidCleanup = $pidCleanup; reportFresh = $reportFresh }
  }

  $started = $false
  $action = "none"
  try {
    Start-ScheduledTask -TaskName $AnalysisTaskName -ErrorAction Stop
    $started = $true
    $action = "scheduled-task"
  } catch {
    try {
      Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $AnalysisRunner) -WindowStyle Hidden | Out-Null
      $started = $true
      $action = "direct-runner"
    } catch {
      return @{ ok = $false; started = $false; action = "start-failed"; pid = 0; error = $_.Exception.Message; pidCleanup = $pidCleanup }
    }
  }

  $finalPid = 0
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (Test-Path $AnalysisPidFile) {
      $raw = (Get-Content -Raw -Path $AnalysisPidFile -ErrorAction SilentlyContinue).Trim()
      [void][int]::TryParse($raw, [ref]$finalPid)
      if ($finalPid -gt 0) {
        $commandLine = (Get-ProcessCommandLine $finalPid).ToLowerInvariant()
        if ($commandLine.Contains("node") -and $commandLine.Contains("run-analysis-watchdog.mjs")) {
          return @{ ok = $true; started = $started; action = $action; pid = $finalPid; pidCleanup = $pidCleanup; reportFresh = $reportFresh }
        }
      }
    }
  }

  return @{ ok = $false; started = $started; action = "$action-timeout"; pid = $finalPid; pidCleanup = $pidCleanup; reportFresh = $reportFresh }
}

$startedAt = Get-Date
$local = Start-MonitorIfNeeded
$analysis = Ensure-AnalysisWatchdog
$public = if ($local.ok) { Ensure-PublicTunnel } else { @{ ok = $false; restarted = $false; url = Get-PublicUrl; action = "skipped-local-down"; final = @{ ok = $false; status = 0; error = "local monitor down" } } }
$ok = [bool]($local.ok -and $analysis.ok -and $public.ok)

$report = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  ok = $ok
  elapsedMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
  local = $local
  analysis = $analysis
  public = $public
}

$json = $report | ConvertTo-Json -Depth 12
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($LatestReport, $json, $Utf8NoBom)
[System.IO.File]::AppendAllText($ReportLog, (($json -replace "`r?`n", "") + [Environment]::NewLine), $Utf8NoBom)
Write-Output $json

if (-not $ok) {
  exit 2
}
