$ErrorActionPreference = 'Stop'
$safeLauncherPath = Join-Path $PSScriptRoot '..\windows\start-sns-studio.ps1'
if (-not (Test-Path -LiteralPath $safeLauncherPath)) {
    throw "SNS Studio safe launcher is missing: $safeLauncherPath"
}

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $safeLauncherPath
exit $LASTEXITCODE
