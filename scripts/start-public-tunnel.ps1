$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$StorageDir = Join-Path $ProjectRoot "storage"
$ToolDir = Join-Path $StorageDir "tools"
$LogDir = Join-Path $ProjectRoot "logs"
$Cloudflared = Join-Path $ToolDir "cloudflared.exe"
$TunnelPidFile = Join-Path $StorageDir "baijia-public-tunnel.pid"
$TunnelUrlFile = Join-Path $StorageDir "baijia-public-tunnel.url"
$TunnelLog = Join-Path $LogDir "public-tunnel.log"
$TunnelErr = Join-Path $LogDir "public-tunnel.err"
$Port = if ($env:PORT) { [int]$env:PORT } else { 4173 }
$TargetUrl = "http://127.0.0.1:$Port"

New-Item -ItemType Directory -Force -Path $StorageDir, $ToolDir, $LogDir | Out-Null

function Get-ProcessCommandLine($processId) {
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
    return [string]$process.CommandLine
  } catch {
    return ""
  }
}

if (Test-Path $TunnelPidFile) {
  $oldPidRaw = Get-Content -Path $TunnelPidFile -ErrorAction SilentlyContinue
  $oldPid = 0
  if ($oldPidRaw -and [int]::TryParse($oldPidRaw.Trim(), [ref]$oldPid) -and $oldPid -gt 0) {
    $commandLine = (Get-ProcessCommandLine $oldPid).ToLowerInvariant()
    if ($commandLine.Contains("cloudflared") -and $commandLine.Contains("tunnel")) {
      Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
    }
  }
}

if (-not (Test-Path $Cloudflared)) {
  $downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  Write-Output "Downloading cloudflared..."
  Invoke-WebRequest -Uri $downloadUrl -OutFile $Cloudflared -UseBasicParsing
}

Remove-Item -Path $TunnelLog, $TunnelErr, $TunnelUrlFile -ErrorAction SilentlyContinue

$process = Start-Process `
  -FilePath $Cloudflared `
  -ArgumentList @("tunnel", "--no-autoupdate", "--url", $TargetUrl) `
  -RedirectStandardOutput $TunnelLog `
  -RedirectStandardError $TunnelErr `
  -WindowStyle Hidden `
  -PassThru

Set-Content -Path $TunnelPidFile -Value $process.Id -Encoding ascii

$deadline = (Get-Date).AddSeconds(60)
$publicUrl = ""
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  $text = ""
  if (Test-Path $TunnelLog) { $text += Get-Content -Raw -Path $TunnelLog -ErrorAction SilentlyContinue }
  if (Test-Path $TunnelErr) { $text += "`n" + (Get-Content -Raw -Path $TunnelErr -ErrorAction SilentlyContinue) }
  $match = [regex]::Match($text, "https://[a-zA-Z0-9-]+\.trycloudflare\.com")
  if ($match.Success) {
    $publicUrl = $match.Value
    break
  }
  if ($process.HasExited) {
    throw "cloudflared exited early. See $TunnelErr"
  }
}

if (-not $publicUrl) {
  throw "Timed out waiting for public tunnel URL. See $TunnelLog and $TunnelErr"
}

Set-Content -Path $TunnelUrlFile -Value $publicUrl -Encoding ascii
Write-Output "Baijia public URL: $publicUrl"
Write-Output "Tunnel PID: $($process.Id)"
