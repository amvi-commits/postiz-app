$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$composeFile = Join-Path $repoRoot 'docker-compose.yaml'
$dockerDesktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
$startupTimeoutSeconds = 300
$webTimeoutSeconds = 600

function Get-SnsStudioUrl {
    $configJson = & docker compose --project-directory $repoRoot -f $composeFile config --format json
    if ($LASTEXITCODE -ne 0) {
        throw 'docker-compose.yaml の有効な設定を読み取れませんでした。'
    }

    $config = ($configJson -join [Environment]::NewLine) | ConvertFrom-Json
    $ports = @($config.services.postiz.ports)
    $webPort = $null
    $webHost = 'localhost'
    foreach ($port in $ports) {
        if ($port.target -eq 5000 -and $port.published) {
            $webPort = [string]$port.published
            if ($port.host_ip -and $port.host_ip -ne '0.0.0.0') {
                $webHost = [string]$port.host_ip
            }
            break
        }
    }

    if (-not $webPort) {
        throw 'compose設定からPostiz Web UIの公開ポートを特定できませんでした。'
    }

    return "http://${webHost}:$webPort"
}

try {
    if (-not (Test-Path -LiteralPath $composeFile)) {
        throw "composeファイルが見つかりません: $composeFile"
    }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker CLIが見つかりません。Docker Desktopをインストールしてください。'
    }

    $studioUrl = Get-SnsStudioUrl

    $engineReady = $false
    & docker info *> $null
    if ($LASTEXITCODE -eq 0) {
        $engineReady = $true
    }
    elseif (Test-Path -LiteralPath $dockerDesktop) {
        Write-Host 'Docker Desktopを起動しています...'
        Start-Process -FilePath $dockerDesktop
    }
    else {
        throw "Docker Desktopが見つかりません: $dockerDesktop"
    }

    $dockerEngineWasReady = $engineReady

    if (-not $engineReady) {
        Write-Host 'Docker Engineの起動を待っています...'
        $deadline = (Get-Date).AddSeconds($startupTimeoutSeconds)
        do {
            Start-Sleep -Seconds 3
            & docker info *> $null
            $engineReady = ($LASTEXITCODE -eq 0)
        } until ($engineReady -or (Get-Date) -ge $deadline)

        if (-not $engineReady) {
            throw "Docker Engineが $startupTimeoutSeconds 秒以内に起動しませんでした。Docker Desktopの状態を確認してください。"
        }
    }

    Write-Host 'SNS Studioの起動状態を確認しています...'
    Push-Location $repoRoot
    try {
        $runningServices = @()
        if ($dockerEngineWasReady) {
            $runningServices = @(& docker compose --project-directory $repoRoot -f $composeFile ps --services --filter status=running)
            if ($LASTEXITCODE -ne 0) {
                throw 'SNS Studioの起動状態を確認できませんでした。'
            }
            $runningServices = @($runningServices | Where-Object { $_ -and $_.Trim() })
        }

        if ($runningServices.Count -gt 0) {
            $existingUiReady = $false
            try {
                $existingResponse = Invoke-WebRequest -Uri $studioUrl -Method Get -MaximumRedirection 5 -TimeoutSec 8
                $existingUiReady = ($existingResponse.StatusCode -ge 200 -and $existingResponse.StatusCode -lt 400)
            }
            catch {
                $existingUiReady = $false
            }

            if ($existingUiReady) {
                Write-Host "SNS Studioは起動済みです。管理画面を開きます: $studioUrl"
                Start-Process -FilePath $studioUrl
                $stopChoice = Read-Host '停止する場合は S を入力して Enter。管理画面を開いたまま閉じる場合は Enter'
                if ($stopChoice -match '^(s|stop)$') {
                    Write-Host 'SNS Studioのcomposeサービスを停止しています...'
                    & docker compose --project-directory $repoRoot -f $composeFile stop
                    if ($LASTEXITCODE -ne 0) {
                        throw 'SNS Studioのcomposeサービスを停止できませんでした。'
                    }
                    Write-Host 'SNS Studioを停止しました。保存データはそのままです。' -ForegroundColor Green
                    Read-Host 'Enterキーを押すと閉じます'
                }
                exit 0
            }
        }

        Write-Host 'SNS Studioのcomposeサービスを起動しています...'
        & docker compose --project-directory $repoRoot -f $composeFile up -d
        if ($LASTEXITCODE -ne 0) {
            throw 'docker compose up -d が失敗しました。'
        }
    }
    finally {
        Pop-Location
    }

    Write-Host "Web UI ($studioUrl) の応答を待っています..."
    $deadline = (Get-Date).AddSeconds($webTimeoutSeconds)
    $webReady = $false
    do {
        try {
            $response = Invoke-WebRequest -Uri $studioUrl -Method Get -MaximumRedirection 5 -TimeoutSec 8
            $webReady = ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
        }
        catch {
            $webReady = $false
        }

        if (-not $webReady) {
            Start-Sleep -Seconds 4
        }
    } until ($webReady -or (Get-Date) -ge $deadline)

    if (-not $webReady) {
        throw "Web UIが $webTimeoutSeconds 秒以内に応答しませんでした。Docker Desktopでコンテナの状態を確認してください。"
    }

    Write-Host "SNS Studioを開きます: $studioUrl"
    Start-Process $studioUrl
}
catch {
    Write-Host "SNS Studioを操作できませんでした: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host 'Enterキーを押すと閉じます'
    exit 1
}
