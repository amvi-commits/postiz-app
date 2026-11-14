[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DeploymentManifest,
    [switch]$OpenBrowser,
    [switch]$NoOpen,
    [ValidateRange(10, 600)][int]$TimeoutSeconds = 120
)
$ErrorActionPreference = 'Stop'
# Starts audited, pre-created containers only. Never creates, rebuilds, stops,
# recreates, seeds, migrates, or updates a database or the legacy launcher marker.
$names = @('sns-live-redis', 'sns-live-temporal', 'sns-studio-management-live', 'sns-live-gateway')
function DockerRead([string[]]$Arguments) {
    $out = @(& docker @Arguments 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'Docker inspection/start failed. No fallback performed.' }
    return ($out -join "`n")
}
function Inspect([string]$Name) {
    $objects = @(ConvertFrom-Json (DockerRead @('inspect', $Name)))
    if ($objects.Count -ne 1) { throw "Expected exactly one existing container: $Name" }
    return $objects[0]
}
function SameJson($A, $B) {
    return ((ConvertTo-Json -InputObject @($A) -Compress -Depth 20) -ceq (ConvertTo-Json -InputObject @($B) -Compress -Depth 20))
}
function CheckFile($File) {
    if (-not $File.path -or [string]$File.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'Invalid required-file specification.' }
    if (-not [IO.Path]::IsPathRooted([string]$File.path) -or -not (Test-Path -LiteralPath $File.path -PathType Leaf)) { throw 'Required safety file unavailable.' }
    if ((Get-FileHash -LiteralPath $File.path -Algorithm SHA256).Hash -ine $File.sha256) { throw 'Required safety file hash mismatch. Do not regenerate the manifest to bypass this check.' }
}
if (-not (Test-Path -LiteralPath $DeploymentManifest -PathType Leaf)) { throw 'Approved deployment manifest is required; no defaults are inferred.' }
$m = Get-Content -LiteralPath $DeploymentManifest -Raw | ConvertFrom-Json
if ($m.schemaVersion -ne 1 -or $m.mode -cne 'new-only-held-backlog' -or $m.baseUrl -cne 'http://localhost:4017') { throw 'Unsupported deployment manifest.' }
if (-not (SameJson @($m.containers | ForEach-Object { $_.name }) $names)) { throw 'Manifest must specify exactly the four new containers in startup order.' }
if (-not $m.holdsFile -or -not $m.guardFile) { throw 'Hold manifest and backend guard are mandatory.' }
CheckFile $m.holdsFile
CheckFile $m.guardFile
foreach ($f in @($m.requiredFiles)) { CheckFile $f }
$holds = Get-Content -LiteralPath $m.holdsFile.path -Raw | ConvertFrom-Json
$holdCounts = @{deliveryIds=15;contentIds=15;postIds=1;recipeIds=1;pipelineIds=1;publishRecordIds=1}
if (@($holds.PSObject.Properties).Count -ne 6) { throw 'Unexpected hold-set schema.' }
foreach ($key in $holdCounts.Keys) {
    $ids = @($holds.$key)
    if ($ids.Count -ne $holdCounts[$key] -or @($ids | Sort-Object -Unique).Count -ne $ids.Count -or @($ids | Where-Object { $_ -isnot [string] -or -not $_.Trim() }).Count) { throw "Invalid protected set: $key" }
}
function CheckLiveEnvironment {
    CheckFile $m.envFile
    $result = @(& node (Join-Path $PSScriptRoot 'inspect-sns-live-env.cjs') $m.envFile.path 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'A local Node version with util.parseEnv is required. No approximate dotenv parsing is used.' }
    $e = ($result -join "`n") | ConvertFrom-Json
    if ($null -eq $e.RUN_CRON -or $e.RUN_CRON -cne '' -or $e.TEMPORAL_ADDRESS -cne 'sns-live-temporal:7233' -or $e.TEMPORAL_NAMESPACE -cne 'default' -or $e.SNS_HELD_IDS_FILE -cne '/app/original-hold-ids.json' -or $e.SNS_STUDIO_READ_ONLY -cne '1') { throw 'Unsafe live environment keys. No startup performed.' }
}
CheckLiveEnvironment
foreach ($legacy in @('postiz','sns-studio-integration-4017','sns-studio-review-app')) {
    if ((Inspect $legacy).State.Running) { throw "Legacy app is running: $legacy. This launcher will not stop it." }
}
function VerifyContainer($Spec) {
    $c = Inspect $Spec.name
    if ([string]$Spec.imageId -notmatch '^sha256:[0-9a-f]{64}$' -or $c.Image -cne $Spec.imageId) { throw "Image identity mismatch: $($Spec.name)" }
    if (-not $Spec.imageRef -or $c.Config.Image -cne $Spec.imageRef) { throw "Image reference mismatch: $($Spec.name)" }
    if ($Spec.name -eq 'sns-studio-management-live') {
        $sourceCommit = [string]$m.videoInputsDeployment.appSourceCommit
        if ($sourceCommit -cnotmatch '^[0-9a-f]{40}$' -or $Spec.imageRef -cne "sns-studio/integration-4017:video-inputs-$($sourceCommit.Substring(0, 8))") { throw 'Unapproved application source/image reference.' }
        $revision = (DockerRead @('image', 'inspect', '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}', $c.Image)).Trim()
        if ($revision -cne $sourceCommit) { throw 'Application image source revision mismatch.' }
    }
    if (-not $Spec.PSObject.Properties['command'] -or -not $Spec.PSObject.Properties['entrypoint']) { throw 'Explicit command and entrypoint are required.' }
    if (-not (SameJson $c.Config.Cmd $Spec.command) -or -not (SameJson $c.Config.Entrypoint $Spec.entrypoint)) { throw "Command mismatch: $($Spec.name)" }
    $actualMounts = @($c.Mounts | Sort-Object Destination | ForEach-Object { [ordered]@{type=$_.Type;source=$_.Source;destination=$_.Destination;readOnly=(-not $_.RW)} })
    $expectedMounts = @($Spec.mounts | Sort-Object destination | ForEach-Object { [ordered]@{type=$_.type;source=$_.source;destination=$_.destination;readOnly=[bool]$_.readOnly} })
    if (-not (SameJson $actualMounts $expectedMounts)) { throw "Mount mismatch: $($Spec.name)" }
    $actualNetworks = @($c.NetworkSettings.Networks.PSObject.Properties.Name | Sort-Object)
    if (-not (SameJson $actualNetworks @($Spec.networks | Sort-Object))) { throw "Network mismatch: $($Spec.name)" }
    if ($c.HostConfig.Privileged -or $c.HostConfig.NetworkMode -eq 'host') { throw 'Privileged/host-network containers are not permitted.' }
    if (-not $Spec.PSObject.Properties['portBindings'] -or (ConvertTo-Json $c.HostConfig.PortBindings -Compress -Depth 10) -cne (ConvertTo-Json $Spec.portBindings -Compress -Depth 10)) { throw "Port binding mismatch: $($Spec.name)" }
    if ($Spec.name -eq 'sns-studio-management-live') {
        foreach ($f in @($m.holdsFile,$m.guardFile)) {
            $match = @($c.Mounts | Where-Object { $_.Type -eq 'bind' -and $_.Source -ieq $f.path -and $_.Destination -ceq $f.containerPath -and -not $_.RW })
            if ($match.Count -ne 1) { throw 'Application must mount the exact hold and guard files read-only.' }
        }
    }
    return $c
}
foreach ($spec in $m.containers) { $null = VerifyContainer $spec }
foreach ($spec in $m.containers) {
    CheckFile $m.holdsFile; CheckFile $m.guardFile; CheckLiveEnvironment
    $c = VerifyContainer $spec
    if (-not $c.State.Running) { $null = DockerRead @('start', $spec.name) }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $c = Inspect $spec.name
        if ($c.State.Running -and (-not $c.State.Health -or $c.State.Health.Status -eq 'healthy')) { break }
        if ($c.State.Health.Status -eq 'unhealthy' -or [DateTime]::UtcNow -ge $deadline) { throw "Readiness failed: $($spec.name). Already-started containers were not stopped automatically." }
        Start-Sleep -Seconds 2
    } while ($true)
}
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
    try { $code = [int](Invoke-WebRequest -Uri 'http://localhost:4017/auth/login' -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 5).StatusCode } catch {}
    if ($code -eq 200) { break }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Management login page did not become ready; no publishing test was performed.' }
    Start-Sleep -Seconds 2
} while ($true)
if ((DockerRead @('exec','sns-live-redis','redis-cli','ping')).Trim() -cne 'PONG') { throw 'Dedicated Redis is not ready.' }
if ((DockerRead @('exec','sns-live-temporal','temporal','operator','cluster','health','--address','127.0.0.1:7233')).Trim() -cne 'SERVING') { throw 'Dedicated Temporal is not ready.' }
$api = Invoke-WebRequest -Uri 'http://localhost:4017/api/auth/can-register' -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 10
if ([int]$api.StatusCode -ne 200 -or -not (($api.Content | ConvertFrom-Json).PSObject.Properties['register'])) { throw 'Backend authentication readiness check failed.' }
Write-Output 'Management login, backend, dedicated Redis and Temporal are ready. This is not proof of posting delivery success.'
if ($OpenBrowser -and -not $NoOpen) { Start-Process 'http://localhost:4017/sns-studio' }
