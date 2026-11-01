$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$publicDir = Join-Path $projectRoot 'public'
$sourcePublic = Join-Path $PSScriptRoot '..\patch-source\public'
$files = @('labs.html', 'labs.js', 'labs.css')

if (-not (Test-Path -LiteralPath $publicDir)) { throw "Public folder not found: $publicDir" }
foreach ($file in $files) {
    $source = Join-Path $sourcePublic $file
    if (-not (Test-Path -LiteralPath $source)) { throw "Patch source not found: $source" }
    $target = Join-Path $publicDir $file
    if (Test-Path -LiteralPath $target) {
        $backup = "$target.bak-create-lab-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -LiteralPath $target -Destination $backup -Force
        Write-Host "Backup created: $backup" -ForegroundColor DarkGray
    }
    Copy-Item -LiteralPath $source -Destination $target -Force
    Write-Host "Updated public\$file" -ForegroundColor Cyan
}

Write-Host ''
Write-Host 'Create Lab form installed.' -ForegroundColor Green
Write-Host 'It uses the existing POST /api/v1/rooms endpoint and saves to dbo.Rooms.' -ForegroundColor Gray
Write-Host 'No SQL migration or backend route replacement is required.' -ForegroundColor Gray
