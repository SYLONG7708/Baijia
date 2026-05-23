param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
$daemon = Join-Path $ProjectRoot "src\daemon.js"
$node = (Get-Command node -ErrorAction Stop).Source

$existing = Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -and
    $_.CommandLine -like "*$daemon*" -and
    $_.ProcessId -ne $PID
  }

if ($existing) {
  exit 0
}

Start-Process -FilePath $node `
  -ArgumentList "`"$daemon`"" `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden
