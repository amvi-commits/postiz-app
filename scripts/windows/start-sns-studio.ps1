param(
    [switch]$NoBrowser,
    [string]$IntegrationRuntimeDirectory
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$composeFile = Join-Path $repoRoot 'docker-compose.yaml'
$safeComposeFile = Join-Path $repoRoot 'docker-compose.sns-studio-local-safe.yaml'
$mediaComposeFile = Join-Path $repoRoot 'docker-compose.sns-studio-integration-media.yaml'
$containerStartupScript = Join-Path $repoRoot 'scripts\sns-studio\start-local-safe.sh'
$launcherScript = Join-Path $PSScriptRoot 'start-sns-studio.ps1'
$runtimeDirectory = if ($IntegrationRuntimeDirectory) { [IO.Path]::GetFullPath($IntegrationRuntimeDirectory) } else { Join-Path $repoRoot '.sns-studio-data\integration-runtime' }
$runtimeComposeFile = Join-Path $runtimeDirectory 'compose.integration-4017.yaml'
$runtimeStartupScript = Join-Path $runtimeDirectory 'start-local-safe.lf.sh'
$envFile = Join-Path $runtimeDirectory '.env.integration'
$dockerDesktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
$projectName = 'sns-studio-integration-4017'
$postizService = 'postiz-integration'
$studioUrl = 'http://localhost:4017/sns-studio'
$loginUrl = 'http://localhost:4017/auth/login'
$apiSelfUrl = 'http://localhost:4017/api/user/self'
$localStateDirectory = Join-Path $env:LOCALAPPDATA 'SNSStudio'
$safetyMarkerPath = Join-Path $localStateDirectory 'safe-launcher-4017.json'
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

# Runtime identity SSOT: image tags and the canonical uploads volume are read
# only from the dedicated runtime's .env.integration (the same file Compose
# receives via --env-file). No literal fallback exists in this launcher.
$runtimeIdentityKeys = [ordered]@{
    IntegrationImage = 'SNS_STUDIO_INTEGRATION_IMAGE'
    MediaWorkerImage = 'SNS_STUDIO_MEDIA_WORKER_IMAGE'
    UploadsVolume    = 'SNS_STUDIO_UPLOADS_VOLUME'
}

function Get-RuntimeIdentity {
    $values = @{}
    foreach ($line in (Get-Content -LiteralPath $envFile)) {
        if ($line -match '^\s*(SNS_STUDIO_INTEGRATION_IMAGE|SNS_STUDIO_MEDIA_WORKER_IMAGE|SNS_STUDIO_UPLOADS_VOLUME)\s*=\s*(.*?)\s*$') {
            $values[$Matches[1]] = $Matches[2].Trim('"').Trim("'")
        }
    }
    $identity = [ordered]@{}
    foreach ($entry in $runtimeIdentityKeys.GetEnumerator()) {
        $value = [string]$values[$entry.Value]
        if (-not $value) { throw "Runtime identity SSOT is incomplete: $($entry.Value) is not set in .env.integration. See scripts/windows/integration-runtime-identity.example.env. No fallback value is used." }
        $identity[$entry.Key] = $value
    }
    foreach ($key in @('IntegrationImage', 'MediaWorkerImage')) {
        if ($identity[$key] -notmatch '^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+$') { throw "Runtime identity SSOT has an invalid image reference for $($runtimeIdentityKeys[$key])." }
    }
    if ($identity.UploadsVolume -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$') { throw 'Runtime identity SSOT has an invalid SNS_STUDIO_UPLOADS_VOLUME.' }
    return [pscustomobject]$identity
}

function Test-RuntimeIdentityPrerequisites {
    $volumes = Get-DockerVolumeNames
    if ($volumes -notcontains $runtimeIdentity.UploadsVolume) {
        throw "Canonical uploads volume missing: $($runtimeIdentity.UploadsVolume). No volume was created and no legacy volume was used. Restore the canonical volume or correct SNS_STUDIO_UPLOADS_VOLUME in .env.integration."
    }
    foreach ($image in @($runtimeIdentity.IntegrationImage, $runtimeIdentity.MediaWorkerImage)) {
        $inspection = Invoke-DockerQuiet -Arguments @('image', 'inspect', '--format', '{{.Id}}', $image)
        if ($inspection.ExitCode -ne 0) {
            throw "Canonical image missing: $image. No older tag was substituted. Build/tag the image for the current Integration HEAD and update the runtime identity SSOT (see scripts/windows/integration-runtime-identity.example.env)."
        }
    }
}

function Get-ContainerInspection([string]$Name) {
    $inspection = Invoke-DockerQuiet -Arguments @('inspect', $Name)
    if ($inspection.ExitCode -ne 0) { throw "Required existing container is missing: $Name. No replacement was created." }
    return ([string]::Join("`n", @($inspection.Output)) | ConvertFrom-Json)[0]
}

function Test-UploadsMount($Container, [string]$Name) {
    $mounts = @($Container.Mounts | Where-Object { $_.Destination.TrimEnd('/') -eq '/uploads' })
    if ($mounts.Count -ne 1 -or $mounts[0].Type -ne 'volume' -or $mounts[0].Name -ne $runtimeIdentity.UploadsVolume) {
        throw "Running container $Name does not mount the canonical uploads volume at /uploads (expected the SSOT volume)."
    }
}

function Test-WorkerContainerIdentity {
    $mediaWorker = Get-ContainerInspection -Name 'sns-media-worker'
    if ($mediaWorker.Config.Image -ne $runtimeIdentity.MediaWorkerImage) {
        throw 'STALE media worker: sns-media-worker runs an image that differs from SNS_STUDIO_MEDIA_WORKER_IMAGE. Recreate it from the SSOT image in a controlled step; the launcher does not substitute images.'
    }
    Test-UploadsMount -Container $mediaWorker -Name 'sns-media-worker'
    $instagramWorker = Get-ContainerInspection -Name 'sns-instagram-worker'
    Test-UploadsMount -Container $instagramWorker -Name 'sns-instagram-worker'
}

function Get-ConfigurationFingerprint {
    $paths = @($composeFile, $safeComposeFile, $mediaComposeFile, $containerStartupScript, $launcherScript, $runtimeComposeFile, $runtimeStartupScript)
    $parts = foreach ($path in $paths) {
        if (-not (Test-Path -LiteralPath $path)) { throw "Required launcher file is missing: $path" }
        (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    }
    $identityParts = foreach ($entry in $runtimeIdentityKeys.GetEnumerator()) { "$($entry.Value)=$($runtimeIdentity.($entry.Key))" }
    $combined = [string]::Join(':', @($parts) + @($identityParts))
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

function Get-ComposeArguments {
    return @(
        'compose',
        '--project-directory', $runtimeDirectory,
        '--project-name', $projectName,
        '--env-file', $envFile,
        '-f', $composeFile,
        '-f', $safeComposeFile,
        '-f', $runtimeComposeFile,
        '-f', $mediaComposeFile
    )
}

function Invoke-Compose([string[]]$Arguments, [string]$FailureMessage) {
    $result = Invoke-DockerQuiet -Arguments ((Get-ComposeArguments) + $Arguments)
    if ($result.ExitCode -ne 0) { throw $FailureMessage }
}

function Start-ExistingContainers([string[]]$Names) {
    foreach ($name in $Names) {
        $inspection = Invoke-DockerQuiet -Arguments @('inspect', '--format', '{{.State.Running}}', $name)
        if ($inspection.ExitCode -ne 0) { throw "Required existing container is missing: $name. No replacement was created." }
        if ([string]::Join('', @($inspection.Output)).Trim() -ne 'true') {
            $started = Invoke-DockerQuiet -Arguments @('start', $name)
            if ($started.ExitCode -ne 0) { throw "Existing container could not be started: $name" }
        }
    }
}

function Test-IntegrationComposeConfiguration {
    $result = Invoke-DockerQuiet -Arguments ((Get-ComposeArguments) + @('config', '--format', 'json'))
    if ($result.ExitCode -ne 0) { throw '4017 Compose configuration could not be resolved. Configuration output was withheld.' }
    $configuration = ([string]::Join("`n", @($result.Output))) | ConvertFrom-Json
    $service = $configuration.services.$postizService
    if (-not $service -or $service.container_name -ne 'sns-studio-integration-4017' -or $service.restart -ne 'unless-stopped') { throw '4017 runtime service identity or restart policy is incorrect.' }
    if ([string]::Join(' ', @($service.command)) -ne '/bin/sh /app/scripts/sns-studio/start-local-safe.sh') { throw '4017 runtime does not use the safe startup command.' }
    $binding = @($service.ports | Where-Object { $_.target -eq 5000 -and $_.published -eq '4017' -and $_.host_ip -eq '127.0.0.1' })
    if ($binding.Count -ne 1 -or @($service.ports).Count -ne 1) { throw '4017 host port contract is incorrect.' }
    foreach ($key in @('MAIN_URL', 'FRONTEND_URL', 'NEXT_PUBLIC_BACKEND_URL')) {
        $expected = if ($key -eq 'NEXT_PUBLIC_BACKEND_URL') { 'http://localhost:4017/api' } else { 'http://localhost:4017' }
        if ($service.environment.$key -ne $expected) { throw "4017 runtime URL is incorrect: $key" }
    }
    if ($service.image -ne $runtimeIdentity.IntegrationImage) { throw "4017 runtime Compose must resolve to the verified integration image ($($runtimeIdentity.IntegrationImage))." }
    $mediaConf = $configuration.services.'sns-media-worker'
    if ($mediaConf -and $mediaConf.image -ne $runtimeIdentity.MediaWorkerImage) { throw "4017 runtime Compose must resolve to the verified media worker image ($($runtimeIdentity.MediaWorkerImage))." }
    foreach ($name in @($postizService, 'sns-media-worker', 'sns-instagram-worker')) {
        $uploadMount = @($configuration.services.$name.volumes | Where-Object { $_.target.TrimEnd('/') -eq '/uploads' })
        if ($uploadMount.Count -ne 1 -or $uploadMount[0].type -ne 'volume') { throw "Shared uploads mount is incorrect: $name" }
        $uploadVolume = $configuration.volumes.($uploadMount[0].source)
        if (-not $uploadVolume.external -or $uploadVolume.name -ne $runtimeIdentity.UploadsVolume) { throw "Existing canonical shared uploads volume ($($runtimeIdentity.UploadsVolume)) is required: $name" }
    }
    $sourceStartup = (Get-Content -LiteralPath $containerStartupScript -Raw).Replace("`r`n", "`n")
    $runtimeStartup = (Get-Content -LiteralPath $runtimeStartupScript -Raw).Replace("`r`n", "`n")
    if ($sourceStartup -cne $runtimeStartup) { throw 'The runtime safe startup script differs from the Integration source.' }
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
    $composePs = Invoke-DockerQuiet -Arguments ((Get-ComposeArguments) + @('ps', '--all', '-q', $postizService))
    $id = [string]::Join("`n", @($composePs.Output)).Trim()
    if ($composePs.ExitCode -ne 0 -or -not $id) { throw 'Postiz container ID could not be resolved.' }

    $commandResult = Invoke-DockerQuiet -Arguments @('inspect', '--format', '{{json .Config.Cmd}}', $id)
    $commandJson = [string]::Join("`n", @($commandResult.Output))
    if ($commandResult.ExitCode -ne 0) { throw 'Postiz container command could not be inspected.' }
    if ([string]::Join(' ', @($commandJson | ConvertFrom-Json)) -ne '/bin/sh /app/scripts/sns-studio/start-local-safe.sh') {
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
    foreach ($expected in @('sns-studio-v1_postiz-network', 'temporal-network')) {
        if ($networkNames -notcontains $expected) { throw "Postiz is missing required Compose network: $expected" }
    }
    $inspection = Invoke-DockerQuiet -Arguments @('inspect', $id)
    if ($inspection.ExitCode -ne 0) { throw '4017 runtime identity could not be inspected.' }
    $container = ([string]::Join("`n", @($inspection.Output)) | ConvertFrom-Json)[0]
    if ($container.Name -ne '/sns-studio-integration-4017' -or $container.Config.Labels.'com.docker.compose.project' -ne $projectName) { throw 'Resolved container is not the dedicated 4017 runtime.' }
    if ($container.Config.Image -ne $runtimeIdentity.IntegrationImage) { throw "4017 Postiz container image does not match the runtime identity SSOT image ($($runtimeIdentity.IntegrationImage))." }
    $port = @($container.HostConfig.PortBindings.'5000/tcp')
    if ($port.Count -ne 1 -or $port[0].HostPort -ne '4017' -or $port[0].HostIp -ne '127.0.0.1') { throw 'Existing runtime host binding is incorrect.' }
    $mountedVolumes = @($container.Mounts | Where-Object { $_.Type -eq 'volume' } | ForEach-Object { $_.Name })
    foreach ($volume in @('sns-studio-integration-4017-config', 'sns-studio-integration-4017-data', $runtimeIdentity.UploadsVolume)) {
        if ($mountedVolumes -notcontains $volume) { throw "Dedicated 4017 volume is missing: $volume" }
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
    if (-not (Test-Path -LiteralPath $composeFile) -or -not (Test-Path -LiteralPath $safeComposeFile) -or -not (Test-Path -LiteralPath $mediaComposeFile)) {
        throw 'SNS Studio Compose files are missing from the current repository.'
    }
    if (-not (Test-Path -LiteralPath $containerStartupScript)) {
        throw 'SNS Studio safe container startup script is missing.'
    }
    if (-not (Test-Path -LiteralPath $envFile)) {
        throw 'The dedicated .env.integration is missing. Configure -IntegrationRuntimeDirectory; the old 4007 environment was not used.'
    }
    if (-not (Test-Path -LiteralPath $runtimeComposeFile) -or -not (Test-Path -LiteralPath $runtimeStartupScript)) { throw 'The dedicated 4017 runtime configuration is missing.' }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker CLI is unavailable. Install or repair Docker Desktop before starting SNS Studio.'
    }

    $runtimeIdentity = Get-RuntimeIdentity

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
        Start-Process -FilePath $dockerDesktop -WindowStyle Hidden | Out-Null
        $engineDeadline = (Get-Date).AddSeconds($startupTimeoutSeconds)
        do {
            Start-Sleep -Seconds 3
            $engineWasReady = Test-DockerEngine
        } until ($engineWasReady -or (Get-Date) -ge $engineDeadline)
        if (-not $engineWasReady) { throw "Docker Engine did not become ready within $startupTimeoutSeconds seconds. Check Docker Desktop." }
    }

    $volumesBefore = Get-DockerVolumeNames
    Test-RuntimeIdentityPrerequisites
    Test-IntegrationComposeConfiguration
    Test-PostizContainerConfiguration
    Test-WorkerContainerIdentity

    Write-Stage 2 'Infrastructure起動'
    Start-ExistingContainers -Names @('postiz-postgres', 'sns-studio-voicevox', 'sns-instagram-worker', 'sns-media-worker')
    Invoke-Compose -Arguments @('start', 'integration-redis') -FailureMessage 'Existing Integration Redis could not be started.'

    Write-Stage 3 'Temporal待機'
    Start-ExistingContainers -Names @('temporal-postgresql', 'temporal-elasticsearch')
    Wait-ContainerCommand -Container 'temporal-postgresql' -Command @('pg_isready', '-U', 'temporal', '-d', 'temporal') -TimeoutSeconds $serviceTimeoutSeconds -Description 'Temporal PostgreSQL'
    Wait-ContainerCommand -Container 'temporal-elasticsearch' -Command @('curl', '-fsS', '-o', '/dev/null', 'http://127.0.0.1:9200/_cluster/health') -TimeoutSeconds $serviceTimeoutSeconds -Description 'Temporal Elasticsearch'
    Start-ExistingContainers -Names @('temporal', 'temporal-admin-tools', 'temporal-ui')
    Wait-TcpPort -HostName '127.0.0.1' -Port 7233 -TimeoutSeconds $serviceTimeoutSeconds -Description 'Temporal gRPC listener'

    Write-Stage 4 'Postiz起動'
    Invoke-Compose -Arguments @('start', $postizService) -FailureMessage 'Existing 4017 Postiz runtime could not be started. No replacement or database push was performed.'

    Write-Stage 5 'Backend確認'
    $backendProbe = 'const s=require(''net'').connect(3000,''127.0.0.1'');s.setTimeout(1000,()=>{s.destroy();process.exit(1)});s.once(''connect'',()=>{s.end();process.exit(0)});s.once(''error'',()=>process.exit(1));'
    $deadline = (Get-Date).AddSeconds($serviceTimeoutSeconds)
    $backendReady = $false
    $containerCommand = @('exec', '-T', $postizService, 'node', '-e', $backendProbe)
    do {
        $probeResult = Invoke-DockerQuiet -Arguments ((Get-ComposeArguments) + $containerCommand)
        $backendReady = ($probeResult.ExitCode -eq 0)
        if (-not $backendReady) { Start-Sleep -Seconds 3 }
    } until ($backendReady -or (Get-Date) -ge $deadline)
    if (-not $backendReady) { throw 'Backend port 3000 did not become ready in Postiz. Check the postiz container and backend PM2 process.' }

    $backendLogsArgs = (Get-ComposeArguments) + @('exec', '-T', $postizService, 'pm2', 'logs', 'backend', '--nostream', '--lines', '200')
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
        $probeResult = Invoke-DockerQuiet -Arguments ((Get-ComposeArguments) + @('exec', '-T', $postizService, 'node', '-e', $frontendProbe))
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
