param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$composeFile = Join-Path $repoRoot 'docker-compose.yaml'
$safeComposeFile = Join-Path $repoRoot 'docker-compose.sns-studio-local-safe.yaml'
$containerStartupScript = Join-Path $repoRoot 'scripts\sns-studio\start-local-safe.sh'
$launcherScript = Join-Path $PSScriptRoot 'start-sns-studio.ps1'
$envFile = Join-Path $repoRoot '.env'
$dockerDesktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
$projectName = 'sns-studio-v1'
$studioUrl = 'http://localhost:4007/sns-studio'
$loginUrl = 'http://localhost:4007/auth/login'
$apiSelfUrl = 'http://localhost:4007/api/user/self'
$localStateDirectory = Join-Path $env:LOCALAPPDATA 'SNSStudio'
$safetyMarkerPath = Join-Path $localStateDirectory 'safe-launcher-v1.json'
$startupTimeoutSeconds = 300
$serviceTimeoutSeconds = 600

function Write-Stage([int]$Number, [string]$Text) {
    Write-Host "[$Number/8] $Text" -ForegroundColor Cyan
}

function Invoke-DockerQuiet([string[]]$Arguments) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& docker @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    catch {
        $output = @()
        $exitCode = 1
    }
    finally { $ErrorActionPreference = $previousPreference }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

function Test-DockerEngine {
    $result = Invoke-DockerQuiet -Arguments @('info')
    return ($result.ExitCode -eq 0)
}

function Get-ConfigurationFingerprint {
    $paths = @($composeFile, $safeComposeFile, $containerStartupScript, $launcherScript)
    $parts = foreach ($path in $paths) {
        if (-not (Test-Path -LiteralPath $path)) { throw "Required launcher file is missing: $path" }
        (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    }
    $combined = [string]::Join(':', $parts)
    $bytes = [Text.Encoding]::UTF8.GetBytes($combined)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '') }
    finally { $sha.Dispose() }
}

function Test-SafeStartupMarker {
    if (-not (Test-Path -LiteralPath $safetyMarkerPath)) { return $false }
    try {
        $marker = Get-Content -LiteralPath $safetyMarkerPath -Raw | ConvertFrom-Json
        return ([string]$marker.configurationFingerprint -eq (Get-ConfigurationFingerprint))
    }
    catch { return $false }
}

function Invoke-Compose([string[]]$Arguments, [string]$FailureMessage) {
    $composeArguments = @(
        'compose',
        '--project-directory', $repoRoot,
        '--project-name', $projectName,
        '-f', $composeFile,
        '-f', $safeComposeFile
    ) + $Arguments
    $result = Invoke-DockerQuiet -Arguments $composeArguments
    if ($result.ExitCode -ne 0) { throw $FailureMessage }
}

function Get-DockerVolumeNames {
    $result = Invoke-DockerQuiet -Arguments @('volume', 'ls', '--format', '{{.Name}}')
    if ($result.ExitCode -ne 0) { throw 'Docker volume inventory could not be read safely.' }
    return @($result.Output | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
}

function Wait-ContainerCommand([string]$Container, [string[]]$Command, [int]$TimeoutSeconds, [string]$Description) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $result = Invoke-DockerQuiet -Arguments (@('exec', $Container) + $Command)
        if ($result.ExitCode -eq 0) { return }
        Start-Sleep -Seconds 3
    } until ((Get-Date) -ge $deadline)
    throw "$Description did not become ready within $TimeoutSeconds seconds (container: $Container)."
}

function Test-TcpPort([string]$HostName, [int]$Port, [int]$TimeoutMilliseconds = 1200) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.ConnectAsync($HostName, $Port)
        return ($connect.Wait($TimeoutMilliseconds) -and $client.Connected)
    }
    catch { return $false }
    finally { $client.Dispose() }
}

function Wait-TcpPort([string]$HostName, [int]$Port, [int]$TimeoutSeconds, [string]$Description) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (Test-TcpPort -HostName $HostName -Port $Port) { return }
        Start-Sleep -Seconds 3
    } until ((Get-Date) -ge $deadline)
    throw "$Description was not ready within $TimeoutSeconds seconds (TCP $HostName`:$Port)."
}

function Get-HttpStatus([string]$Uri) {
    try {
        $response = Invoke-WebRequest -Uri $Uri -Method Get -MaximumRedirection 5 -TimeoutSec 8 -UseBasicParsing
        return [int]$response.StatusCode
    }
    catch {
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            return [int]$_.Exception.Response.StatusCode
        }
        return 0
    }
}

function Wait-HttpStatus([string]$Uri, [scriptblock]$IsExpected, [int]$TimeoutSeconds, [string]$Description) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $status = Get-HttpStatus -Uri $Uri
        if (& $IsExpected $status) { return $status }
        Start-Sleep -Seconds 3
    } until ((Get-Date) -ge $deadline)
    throw "$Description did not return an expected HTTP status within $TimeoutSeconds seconds. URL: $Uri"
}

function Test-PostizContainerConfiguration {
    $composePs = Invoke-DockerQuiet -Arguments @('compose', '--project-directory', $repoRoot, '--project-name', $projectName, '-f', $composeFile, '-f', $safeComposeFile, 'ps', '-q', 'postiz')
    $id = [string]::Join("`n", @($composePs.Output)).Trim()
    if ($composePs.ExitCode -ne 0 -or -not $id) { throw 'Postiz container ID could not be resolved.' }

    $commandResult = Invoke-DockerQuiet -Arguments @('inspect', '--format', '{{json .Config.Cmd}}', $id)
    $commandJson = [string]::Join("`n", @($commandResult.Output))
    if ($commandResult.ExitCode -ne 0) { throw 'Postiz container command could not be inspected.' }
    if (-not $commandJson.Contains('/app/scripts/sns-studio/start-local-safe.sh')) {
        throw 'Postiz is not running with the safe local startup command; safe-start marker was not written.'
    }

    $restartResult = Invoke-DockerQuiet -Arguments @('inspect', '--format', '{{.HostConfig.RestartPolicy.Name}}', $id)
    $restartPolicy = [string]::Join("`n", @($restartResult.Output)).Trim()
    if ($restartResult.ExitCode -ne 0 -or $restartPolicy -ne 'unless-stopped') {
        throw 'Postiz restart policy is not the verified safe local policy; safe-start marker was not written.'
    }

    $networksResult = Invoke-DockerQuiet -Arguments @('inspect', '--format', '{{json .NetworkSettings.Networks}}', $id)
    $networksJson = [string]::Join("`n", @($networksResult.Output))
    if ($networksResult.ExitCode -ne 0) { throw 'Postiz network attachments could not be inspected.' }
    $networks = $networksJson | ConvertFrom-Json
    $networkNames = @($networks.PSObject.Properties.Name)
    foreach ($expected in @("${projectName}_postiz-network", 'temporal-network')) {
        if ($networkNames -notcontains $expected) { throw "Postiz is missing required Compose network: $expected" }
    }
}

function Save-SafeStartupMarker {
    New-Item -ItemType Directory -Path $localStateDirectory -Force | Out-Null
    $marker = [ordered]@{
        configurationFingerprint = Get-ConfigurationFingerprint
        verifiedAt = (Get-Date).ToUniversalTime().ToString('o')
        composeProject = $projectName
    }
    $marker | ConvertTo-Json | Set-Content -LiteralPath $safetyMarkerPath -Encoding UTF8
}

try {
    if (-not (Test-Path -LiteralPath $composeFile) -or -not (Test-Path -LiteralPath $safeComposeFile)) {
        throw 'SNS Studio Compose files are missing from the current repository.'
    }
    if (-not (Test-Path -LiteralPath $containerStartupScript)) {
        throw 'SNS Studio safe container startup script is missing.'
    }
    if (-not (Test-Path -LiteralPath $envFile)) {
        throw '.env is missing. Create the local environment file before starting SNS Studio; its contents were not read.'
    }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker CLI is unavailable. Install or repair Docker Desktop before starting SNS Studio.'
    }

    Set-Location -LiteralPath $repoRoot

    Write-Stage 1 'Docker確認'
    $engineWasReady = Test-DockerEngine
    if (-not $engineWasReady) {
        if (-not (Test-SafeStartupMarker)) {
            throw 'Safety hold: Docker Engine is stopped and no verified safe Postiz container is recorded. The stored container may auto-run the old Compose command as soon as Docker Desktop starts, before this safe override can be applied. To protect the existing database, this launcher did not start Docker Desktop. A controlled first-time Docker bootstrap is required; once the Postiz container is verified with the safe command and restart policy, this launcher can start Docker Desktop on later runs.'
        }
        if (-not (Test-Path -LiteralPath $dockerDesktop)) {
            throw "Docker Desktop was not found at the expected installation path: $dockerDesktop"
        }
        Write-Host 'Docker Desktopを起動しています。' -ForegroundColor Yellow
        Start-Process -FilePath $dockerDesktop | Out-Null
        $engineDeadline = (Get-Date).AddSeconds($startupTimeoutSeconds)
        do {
            Start-Sleep -Seconds 3
            $engineWasReady = Test-DockerEngine
        } until ($engineWasReady -or (Get-Date) -ge $engineDeadline)
        if (-not $engineWasReady) { throw "Docker Engine did not become ready within $startupTimeoutSeconds seconds. Check Docker Desktop." }
    }

    $volumesBefore = Get-DockerVolumeNames

    Write-Stage 2 'Infrastructure起動'
    Invoke-Compose -Arguments @('up', '-d', 'postiz-postgres', 'postiz-redis', 'voicevox', 'sns-instagram-worker', 'sns-media-worker') -FailureMessage 'Infrastructure startup failed. Check the Postiz PostgreSQL, Redis, Voicevox, Instagram worker, and media worker containers.'

    Write-Stage 3 'Temporal待機'
    Invoke-Compose -Arguments @('up', '-d', 'temporal-postgresql', 'temporal-elasticsearch') -FailureMessage 'Temporal dependency startup failed. Check temporal-postgresql and temporal-elasticsearch.'
    Wait-ContainerCommand -Container 'temporal-postgresql' -Command @('pg_isready', '-U', 'temporal', '-d', 'temporal') -TimeoutSeconds $serviceTimeoutSeconds -Description 'Temporal PostgreSQL'
    Wait-ContainerCommand -Container 'temporal-elasticsearch' -Command @('curl', '-fsS', '-o', '/dev/null', 'http://127.0.0.1:9200/_cluster/health') -TimeoutSeconds $serviceTimeoutSeconds -Description 'Temporal Elasticsearch'
    Invoke-Compose -Arguments @('up', '-d', 'temporal', 'temporal-admin-tools', 'temporal-ui') -FailureMessage 'Temporal startup failed. Check temporal, temporal-admin-tools, and temporal-ui.'
    Wait-TcpPort -HostName '127.0.0.1' -Port 7233 -TimeoutSeconds $serviceTimeoutSeconds -Description 'Temporal gRPC listener'

    Write-Stage 4 'Postiz起動'
    Invoke-Compose -Arguments @('up', '-d', 'postiz') -FailureMessage 'Postiz startup failed. The safe local Compose override was used; no database push is part of this launcher.'

    Write-Stage 5 'Backend確認'
    $backendProbe = 'const s=require(''net'').connect(3000,''127.0.0.1'');s.setTimeout(1000,()=>{s.destroy();process.exit(1)});s.once(''connect'',()=>{s.end();process.exit(0)});s.once(''error'',()=>process.exit(1));'
    $deadline = (Get-Date).AddSeconds($serviceTimeoutSeconds)
    $backendReady = $false
    $containerCommand = @('exec', '-T', 'postiz', 'node', '-e', $backendProbe)
    do {
        $probeResult = Invoke-DockerQuiet -Arguments (@('compose', '--project-directory', $repoRoot, '--project-name', $projectName, '-f', $composeFile, '-f', $safeComposeFile) + $containerCommand)
        $backendReady = ($probeResult.ExitCode -eq 0)
        if (-not $backendReady) { Start-Sleep -Seconds 3 }
    } until ($backendReady -or (Get-Date) -ge $deadline)
    if (-not $backendReady) { throw 'Backend port 3000 did not become ready in Postiz. Check the postiz container and backend PM2 process.' }

    $backendLogsArgs = @('compose', '--project-directory', $repoRoot, '--project-name', $projectName, '-f', $composeFile, '-f', $safeComposeFile, 'exec', '-T', 'postiz', 'pm2', 'logs', 'backend', '--nostream', '--lines', '200')
    $backendLogResult = Invoke-DockerQuiet -Arguments $backendLogsArgs
    $backendLogLines = @($backendLogResult.Output)
    if ($backendLogLines -match 'EADDRINUSE.*3000|EADDRINUSE :::3000') {
        throw 'Backend reports EADDRINUSE on port 3000. Startup stopped; inspect only the backend process before retrying.'
    }
    if ($backendLogLines -match 'Backend started successfully on port 3000') {
        Write-Host 'Backend started successfully on port 3000.' -ForegroundColor Green
    }
    else {
        Write-Host 'Backend port 3000 is accepting connections; startup log marker was not found in the last 200 lines.' -ForegroundColor Yellow
    }

    Write-Stage 6 'Frontend確認'
    $frontendProbe = 'const s=require(''net'').connect(4200,''127.0.0.1'');s.setTimeout(1000,()=>{s.destroy();process.exit(1)});s.once(''connect'',()=>{s.end();process.exit(0)});s.once(''error'',()=>process.exit(1));'
    $deadline = (Get-Date).AddSeconds($serviceTimeoutSeconds)
    $frontendReady = $false
    do {
        $probeResult = Invoke-DockerQuiet -Arguments @('compose', '--project-directory', $repoRoot, '--project-name', $projectName, '-f', $composeFile, '-f', $safeComposeFile, 'exec', '-T', 'postiz', 'node', '-e', $frontendProbe)
        $frontendReady = ($probeResult.ExitCode -eq 0)
        if (-not $frontendReady) { Start-Sleep -Seconds 3 }
    } until ($frontendReady -or (Get-Date) -ge $deadline)
    if (-not $frontendReady) { throw 'Frontend port 4200 did not become ready in the postiz container.' }

    Write-Stage 7 'SNS Studio確認'
    $loginStatus = Wait-HttpStatus -Uri $loginUrl -IsExpected { param($status) $status -eq 200 } -TimeoutSeconds $serviceTimeoutSeconds -Description '/auth/login'
    $selfStatus = Wait-HttpStatus -Uri $apiSelfUrl -IsExpected { param($status) ($status -eq 200 -or $status -eq 401) } -TimeoutSeconds 90 -Description '/api/user/self'
    $studioStatus = Wait-HttpStatus -Uri $studioUrl -IsExpected { param($status) ($status -ge 200 -and $status -lt 400) } -TimeoutSeconds $serviceTimeoutSeconds -Description '/sns-studio'
    Write-Host "/auth/login HTTP $loginStatus; /api/user/self HTTP $selfStatus; /sns-studio HTTP $studioStatus."

    Test-PostizContainerConfiguration
    $volumesAfter = Get-DockerVolumeNames
    $removedVolumes = @($volumesBefore | Where-Object { $volumesAfter -notcontains $_ })
    if ($removedVolumes.Count -gt 0) { throw 'A pre-existing Docker volume is missing after startup. The safe-start marker was not updated; stop and inspect before retrying.' }
    Save-SafeStartupMarker

    Write-Stage 8 'Browser起動'
    if (-not $NoBrowser) { Start-Process -FilePath $studioUrl | Out-Null }
    Write-Host "SNS Studio is ready: $studioUrl" -ForegroundColor Green
}
catch {
    Write-Host "SNS Studio startup stopped: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'No volume-removal or database-reset command is used by this launcher. Check the named stage/container before retrying.' -ForegroundColor Yellow
    Read-Host 'Press Enter to close this window' | Out-Null
    exit 1
}
