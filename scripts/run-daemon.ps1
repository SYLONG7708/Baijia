$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogDir = Join-Path $ProjectRoot "logs"
$StorageDir = Join-Path $ProjectRoot "storage"
$ScriptLockFile = Join-Path $StorageDir "baijia-run-daemon.ps1.lock"
$DaemonPidFile = Join-Path $StorageDir "baijia-daemon.pid"
$DaemonHeartbeatFile = Join-Path $StorageDir "baijia-daemon.heartbeat"
$WrapperLogFile = Join-Path $LogDir "run-daemon-wrapper.log"
New-Item -ItemType Directory -Force -Path $LogDir, $StorageDir | Out-Null

Set-Location $ProjectRoot
$env:NODE_ENV = "production"

function Write-WrapperLog([string]$message) {
  $line = "{0} pid={1} {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $PID, $message
  Add-Content -Path $WrapperLogFile -Value $line -Encoding UTF8
  Write-Host $message
}

function Load-EnvFile($path) {
  if (-not (Test-Path $path)) {
    return
  }
  Get-Content -Path $path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      return
    }
    $separator = $line.IndexOf("=")
    if ($separator -lt 0) {
      return
    }
    $key = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim().Trim('"', "'")
    if (-not $key) { return }
    if (-not (Get-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue)) {
      Set-Item -LiteralPath "Env:$key" -Value $value
    }
  }
}

function Get-ProcessCommandLine($processId) {
  if (-not $processId) { return "" }
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
    return [string]$process.CommandLine
  } catch {
    return ""
  }
}

function Test-ProcessCommandLineContains($processId, [string[]]$needles) {
  $commandLine = (Get-ProcessCommandLine $processId).ToLowerInvariant()
  if (-not $commandLine) { return $false }
  foreach ($needle in $needles) {
    if (-not $commandLine.Contains($needle.ToLowerInvariant())) {
      return $false
    }
  }
  return $true
}

function Stop-ManagedDaemonProcesses([string]$reason) {
  $runnerPath = (Join-Path $ProjectRoot "src\daemon.js").ToLowerInvariant()
  $runnerPathAlt = $runnerPath.Replace("\", "/")
  $workerPath = (Join-Path $ProjectRoot "src\collector-worker.js").ToLowerInvariant()
  $workerPathAlt = $workerPath.Replace("\", "/")
  $candidatePids = New-Object System.Collections.Generic.HashSet[int]

  if (Test-Path $DaemonPidFile) {
    $daemonPidRaw = Get-Content -Path $DaemonPidFile -ErrorAction SilentlyContinue
    if ($daemonPidRaw) {
      $daemonPid = 0
      if ([int]::TryParse($daemonPidRaw.Trim(), [ref]$daemonPid) -and $daemonPid -gt 0) {
        [void]$candidatePids.Add($daemonPid)
      }
    }
  }

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
    $commandLine = ([string]$_.CommandLine).ToLowerInvariant()
    $isManagedProcess = $false
    if ($commandLine) {
      $isManagedProcess = (
        $commandLine.Contains($runnerPath) `
        -or $commandLine.Contains($runnerPathAlt) `
        -or $commandLine.Contains($workerPath) `
        -or $commandLine.Contains($workerPathAlt)
      )
    }
    if ($_.ProcessId -ne $PID -and $isManagedProcess) {
      [void]$candidatePids.Add([int]$_.ProcessId)
    }
  }

  foreach ($candidatePid in $candidatePids) {
    if ($candidatePid -le 0 -or $candidatePid -eq $PID) {
      continue
    }
    $commandLine = Get-ProcessCommandLine $candidatePid
    if (-not $commandLine) {
      continue
    }
    Write-WrapperLog "Stopping existing baijia daemon pid=$candidatePid before managed start. reason=$reason"
    Stop-Process -Id $candidatePid -Force -ErrorAction SilentlyContinue
  }

  if ($candidatePids.Count -gt 0) {
    Start-Sleep -Seconds 2
  }
  Remove-Item -Path $DaemonPidFile, $DaemonHeartbeatFile -Force -ErrorAction SilentlyContinue
}

Write-WrapperLog "wrapper starting. root=$ProjectRoot"

if (Test-Path $ScriptLockFile) {
  $scriptPidRaw = Get-Content -Path $ScriptLockFile -ErrorAction SilentlyContinue
  if ($scriptPidRaw) {
    $scriptPid = [int]$scriptPidRaw.Trim()
    if (Test-ProcessCommandLineContains $scriptPid @("powershell", "run-daemon.ps1")) {
      Write-WrapperLog "run-daemon is already active. pid=$scriptPid"
      exit 0
    }
  }
  Write-WrapperLog "Removing stale wrapper lock."
  Remove-Item -Path $ScriptLockFile -Force -ErrorAction SilentlyContinue
}

Set-Content -Path $ScriptLockFile -Value $PID -Encoding ascii
Stop-ManagedDaemonProcesses "wrapper-start"

Load-EnvFile (Join-Path $ProjectRoot ".env")
Load-EnvFile (Join-Path $ProjectRoot ".env.local")

$env:GOODWIN_ENABLE_COLLECTOR = "true"
$env:GOODWIN_HEADLESS = "true"
$env:BAIJIA_DAEMON_ONLY = "false"
if (-not (Get-Item Env:BAIJIA_HOST -ErrorAction SilentlyContinue)) {
  $env:BAIJIA_HOST = "0.0.0.0"
}
if (-not (Get-Item Env:BAIJIA_PUBLIC_VIEW -ErrorAction SilentlyContinue)) {
  $env:BAIJIA_PUBLIC_VIEW = "true"
}
if (-not (Get-Item Env:PORT -ErrorAction SilentlyContinue)) {
  $env:PORT = "4173"
}
$MinimumRunTimeoutMs = 600000
$CurrentRunTimeoutMs = 0
[void][int]::TryParse([string]$env:COLLECT_RUN_TIMEOUT_MS, [ref]$CurrentRunTimeoutMs)
if ($CurrentRunTimeoutMs -lt $MinimumRunTimeoutMs) {
  $env:COLLECT_RUN_TIMEOUT_MS = [string]$MinimumRunTimeoutMs
}

$LogFile = Join-Path $LogDir "daemon-task.log"
$ErrFile = Join-Path $LogDir "daemon-task.err"
$Runner = Join-Path $ProjectRoot "src\daemon.js"
$NodeExe = ""
try {
  $NodeExe = (Get-Command node -ErrorAction Stop).Source
  Write-WrapperLog "Resolved node executable: $NodeExe"
} catch {
  Write-WrapperLog "Node executable was not found in scheduled-task environment: $($_.Exception.Message)"
  throw
}

try {
  while ($true) {
    Write-WrapperLog "Starting baijia daemon: $Runner"
    & $NodeExe $Runner 1>> $LogFile 2>> $ErrFile
    $code = $LASTEXITCODE
    if ($code -eq 0) {
      Write-WrapperLog "Daemon exited normally. Restart in 5 seconds."
      Start-Sleep -Seconds 5
    } else {
      Write-WrapperLog "Daemon exited unexpectedly with code $code. Restart in 10 seconds."
      Start-Sleep -Seconds 10
    }
  }
} finally {
  Write-WrapperLog "wrapper exiting; removing lock."
  Remove-Item -Path $ScriptLockFile -Force -ErrorAction SilentlyContinue
}
