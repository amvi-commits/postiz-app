$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$composeFile = Join-Path $repoRoot 'docker-compose.yaml'

try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker CLIが見つかりません。'
    }

    & docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Docker Engineは起動していません。停止するものはありません。'
        Read-Host 'Enterキーを押すと閉じます'
        exit 0
    }

    Write-Host 'このSNS Studioリポジトリのcomposeサービスを停止しています...'
    & docker compose --project-directory $repoRoot -f $composeFile stop
    if ($LASTEXITCODE -ne 0) {
        throw 'SNS Studioのcomposeサービスを停止できませんでした。'
    }

    Write-Host 'SNS Studioを停止しました。保存データはそのままです。' -ForegroundColor Green
}
catch {
    Write-Host "停止できませんでした: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host 'Enterキーを押すと閉じます'
    exit 1
}

Read-Host 'Enterキーを押すと閉じます'
