[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://localhost:4007'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$composeFile = Join-Path $repoRoot 'docker-compose.yaml'

function Assert-CommandSuccess([string]$Description) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed (exit code $LASTEXITCODE). Check Docker Desktop and run docker compose logs."
  }
  Write-Host "PASS $Description" -ForegroundColor Green
}

function Test-WorkerHealth([string]$Service, [int]$Port) {
  $pythonCode = "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:$Port/health', timeout=5).read().decode())"
  docker compose -f $composeFile exec -T $Service python -c $pythonCode | Out-Null
  Assert-CommandSuccess "$Service health endpoint responds"
}

Push-Location $repoRoot
try {
  docker compose version | Out-Null
  Assert-CommandSuccess 'Docker Compose is available'

  $services = @(docker compose -f $composeFile ps --status running --services)
  Assert-CommandSuccess 'Compose stack is readable'
  $requiredServices = @('postiz', 'postiz-postgres', 'postiz-redis', 'sns-instagram-worker', 'sns-media-worker')
  foreach ($service in $requiredServices) {
    if ($services -notcontains $service) {
      throw "Required service '$service' is not running. Start the stack with: docker compose up -d --build"
    }
    Write-Host "PASS service $service is running" -ForegroundColor Green
  }

  docker compose -f $composeFile exec -T postiz-postgres pg_isready -U postiz-user -d postiz-db-local | Out-Null
  Assert-CommandSuccess 'Postgres is ready'

  $redisReply = docker compose -f $composeFile exec -T postiz-redis redis-cli ping
  Assert-CommandSuccess 'Redis is reachable'
  if (($redisReply -join '').Trim() -ne 'PONG') {
    throw "Redis returned an unexpected response: $($redisReply -join ' ')"
  }

  Test-WorkerHealth -Service 'sns-instagram-worker' -Port 8000
  Test-WorkerHealth -Service 'sns-media-worker' -Port 8001

  Add-Type -AssemblyName System.Net.Http
  $httpClient = [System.Net.Http.HttpClient]::new()
  $httpClient.Timeout = [TimeSpan]::FromSeconds(20)
  try {
    foreach ($route in @('/', '/sns-studio')) {
      $uri = $BaseUrl.TrimEnd('/') + $route
      $response = $httpClient.GetAsync($uri).GetAwaiter().GetResult()
      $statusCode = [int]$response.StatusCode
      if ($statusCode -lt 200 -or $statusCode -ge 400) {
        throw "UI route $uri returned HTTP $statusCode."
      }
      Write-Host "PASS UI route $uri returned HTTP $statusCode" -ForegroundColor Green
    }
  }
  finally {
    $httpClient.Dispose()
  }

  Write-Host 'SNS Studio local smoke check completed. No Instagram login or post was attempted.' -ForegroundColor Cyan
}
finally {
  Pop-Location
}
