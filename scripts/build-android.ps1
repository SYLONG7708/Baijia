$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $ProjectRoot

$LocalJdk = Join-Path $ProjectRoot "tools\jdk-21"
if (Test-Path (Join-Path $LocalJdk "bin\java.exe")) {
  $env:JAVA_HOME = $LocalJdk
  $env:Path = (Join-Path $LocalJdk "bin") + ";" + $env:Path
}

$LocalSdk = "C:\Users\Administrator\Desktop\codex-test\tools\android-sdk"
if (-not $env:ANDROID_HOME -and (Test-Path $LocalSdk)) {
  $env:ANDROID_HOME = $LocalSdk
  $env:ANDROID_SDK_ROOT = $LocalSdk
}

npm run build:web
node scripts\ensure-android.js
npx cap sync android

Set-Location (Join-Path $ProjectRoot "android")
.\gradlew.bat assembleDebug

$apk = Join-Path $ProjectRoot "android\app\build\outputs\apk\debug\app-debug.apk"
if (Test-Path $apk) {
  Write-Host "APK built: $apk"
} else {
  throw "APK was not created."
}
