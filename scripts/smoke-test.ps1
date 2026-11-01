$ErrorActionPreference = 'Stop'
$base = if ($env:CAMPUSX_BASE_URL) { $env:CAMPUSX_BASE_URL.TrimEnd('/') } else { 'http://127.0.0.1:3000' }
$headers = @{}
if ($env:API_KEY) { $headers['X-API-Key'] = $env:API_KEY }

$checks = @(
  @{ Name = 'API health'; Path = '/api/v1/health' },
  @{ Name = 'SQL Server health'; Path = '/api/v1/sqlserver/health' },
  @{ Name = 'Metrics'; Path = '/api/v1/metrics' },
  @{ Name = 'Devices'; Path = '/api/v1/devices' },
  @{ Name = 'Latest telemetry'; Path = '/api/v1/telemetry/latest' },
  @{ Name = 'Alerts'; Path = '/api/v1/alerts?limit=5' }
)

foreach ($check in $checks) {
  try {
    $result = Invoke-RestMethod -Method Get -Uri ($base + $check.Path) -Headers $headers
    Write-Host "PASS $($check.Name)" -ForegroundColor Green
  } catch {
    Write-Host "FAIL $($check.Name): $($_.Exception.Message)" -ForegroundColor Red
    exit 1
  }
}
Write-Host 'Smoke tests passed.' -ForegroundColor Green
