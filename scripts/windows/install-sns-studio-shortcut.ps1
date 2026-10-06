param(
    [Parameter(Mandatory = $true)][string]$IntegrationRuntimeDirectory,
    [string]$PreviousLauncherPath
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$launcherPath = Join-Path $PSScriptRoot 'start-sns-studio.ps1'
if (-not (Test-Path -LiteralPath $launcherPath)) { throw "SNS Studio launcher is missing: $launcherPath" }
$runtimeDirectory = (Resolve-Path -LiteralPath $IntegrationRuntimeDirectory).Path
foreach ($requiredFile in @('compose.integration-4017.yaml', '.env.integration', 'start-local-safe.lf.sh')) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtimeDirectory $requiredFile))) { throw "4017 runtime file is missing: $requiredFile" }
}

$desktopPath = [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)
if (-not $desktopPath -or -not (Test-Path -LiteralPath $desktopPath)) { throw 'Windows Desktop folder could not be resolved.' }

$shortcutPath = Join-Path $desktopPath 'SNS Studio.lnk'
$sameNameFiles = @(Get-ChildItem -LiteralPath $desktopPath -Force -ErrorAction Stop | Where-Object { $_.BaseName -eq 'SNS Studio' })
$shell = New-Object -ComObject WScript.Shell

foreach ($file in $sameNameFiles) {
    if ($file.FullName -eq $shortcutPath) {
        $existing = $shell.CreateShortcut($file.FullName)
        $existingTarget = [string]$existing.TargetPath
        $existingArguments = [string]$existing.Arguments
        $pointsToThisLauncher = ($existingTarget -match 'powershell(\.exe)?$' -and $existingArguments.Contains($launcherPath))
        $pointsToVerifiedPrevious = ($PreviousLauncherPath -and $existingTarget -match 'powershell(\.exe)?$' -and $existingArguments.Contains($PreviousLauncherPath))
        if (-not $pointsToThisLauncher -and -not $pointsToVerifiedPrevious) {
            throw "An existing 'SNS Studio' shortcut points elsewhere. It was not replaced: $shortcutPath"
        }
    }
    else {
        throw "An existing Desktop item already uses the name 'SNS Studio'. It was not changed: $($file.FullName)"
    }
}

$powerShellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powerShellExe
$shortcut.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$launcherPath`" -IntegrationRuntimeDirectory `"$runtimeDirectory`""
$shortcut.WorkingDirectory = $repoRoot
$shortcut.Description = 'Start SNS Studio using the safe local Docker Compose configuration.'
$shortcut.Save()

$check = $shell.CreateShortcut($shortcutPath)
if ($check.TargetPath -ne $powerShellExe -or $check.WorkingDirectory -ne $repoRoot -or -not $check.Arguments.Contains($launcherPath) -or -not $check.Arguments.Contains($runtimeDirectory)) {
    throw 'SNS Studio shortcut verification failed.'
}

$legacyPathFragment = '2026-09-27\referenced-chatgpt-conversation-this-is-an\outputs\sns-studio-v1\scripts\sns-studio\Toggle-SNSStudio.ps1'
$oneDriveRoots = @($env:OneDrive, $env:OneDriveConsumer) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
$oneDriveDesktopPaths = foreach ($root in $oneDriveRoots) {
    foreach ($folderName in @('Desktop', 'デスクトップ')) {
        Join-Path $root $folderName
    }
}
foreach ($oneDriveDesktop in $oneDriveDesktopPaths) {
    $legacyShortcutPath = Join-Path $oneDriveDesktop 'SNS Studio.lnk'
    if ($legacyShortcutPath -eq $shortcutPath -or -not (Test-Path -LiteralPath $legacyShortcutPath)) { continue }

    $legacyShortcut = $shell.CreateShortcut($legacyShortcutPath)
    $legacyTarget = [string]$legacyShortcut.TargetPath
    $legacyArguments = [string]$legacyShortcut.Arguments
    $alreadySafe = ($legacyTarget -match 'powershell(\.exe)?$' -and $legacyArguments.Contains($launcherPath))
    $verifiedOldLauncher = ($legacyTarget -match 'powershell(\.exe)?$' -and $legacyArguments.Contains($legacyPathFragment))
    $verifiedPreviousLauncher = ($PreviousLauncherPath -and $legacyTarget -match 'powershell(\.exe)?$' -and $legacyArguments.Contains($PreviousLauncherPath))
    if (-not $alreadySafe -and -not $verifiedOldLauncher -and -not $verifiedPreviousLauncher) {
        throw "An existing OneDrive Desktop item named 'SNS Studio' points elsewhere. It was not changed: $legacyShortcutPath"
    }

    $legacyShortcut.TargetPath = $powerShellExe
    $legacyShortcut.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$launcherPath`" -IntegrationRuntimeDirectory `"$runtimeDirectory`""
    $legacyShortcut.WorkingDirectory = $repoRoot
    $legacyShortcut.Description = 'Start SNS Studio using the safe local Docker Compose configuration.'
    $legacyShortcut.Save()

    $legacyCheck = $shell.CreateShortcut($legacyShortcutPath)
    if ($legacyCheck.TargetPath -ne $powerShellExe -or $legacyCheck.WorkingDirectory -ne $repoRoot -or -not $legacyCheck.Arguments.Contains($launcherPath) -or -not $legacyCheck.Arguments.Contains($runtimeDirectory)) {
        throw "OneDrive Desktop shortcut verification failed: $legacyShortcutPath"
    }
    Write-Host "Updated verified SNS Studio shortcut: $legacyShortcutPath"
}

Write-Host "Created or verified shortcut: $shortcutPath"
Write-Host "Target: $($check.TargetPath)"
Write-Host "Start in: $($check.WorkingDirectory)"
