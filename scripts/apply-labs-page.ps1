$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$publicDir = Join-Path $projectRoot 'public'
$appPath = Join-Path $projectRoot 'src\app.js'
$sourcePublic = Join-Path $PSScriptRoot '..\patch-source\public'

foreach ($path in @($publicDir, $appPath, (Join-Path $sourcePublic 'labs.html'), (Join-Path $sourcePublic 'labs.css'), (Join-Path $sourcePublic 'labs.js'))) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Required path not found: $path" }
}

$utf8 = [System.Text.UTF8Encoding]::new($false)
$app = [System.IO.File]::ReadAllText($appPath)
$pages = @('index.html','devices.html','alerts.html','control-panel.html','settings.html','command-history.html')
$navLink = @'
<a class="nav-item" href="labs.html">
 <i data-lucide="building-2"></i>
 <span>Labs</span>
</a>
'@

# Ensure the protected page allow-list includes Labs. Do not bypass Dashboard auth.
if ($app -notmatch '/labs\.html') {
    $routePattern = '(?m)(\[[^\r\n]*devices\.html[^\r\n]*\],)'
    if (-not [regex]::IsMatch($app, $routePattern)) {
        throw 'Could not locate the authenticated pageFiles entry for devices.html in src/app.js. No changes were written.'
    }
    $app = [regex]::Replace($app, $routePattern, '$1' + "`r`n  ['/labs.html', 'labs.html'],", 1)
}

# Add Labs to each existing navigation bar, preserving all other links and active states.
$changedPages = @()
foreach ($page in $pages) {
    $path = Join-Path $publicDir $page
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $html = [System.IO.File]::ReadAllText($path)
    if ($html -match 'href=["'']labs\.html["'']') { continue }
    $deviceLinkPattern = '(?s)(<a\b[^>]*href=["'']devices\.html["''][^>]*>.*?</a>)'
    if ([regex]::IsMatch($html, $deviceLinkPattern)) {
        $html = [regex]::Replace($html, $deviceLinkPattern, ('$1' + "`r`n" + $navLink.Trim()), 1)
        $backup = "$path.bak-labs-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -LiteralPath $path -Destination $backup
        [System.IO.File]::WriteAllText($path, $html, $utf8)
        $changedPages += $page
    }
}

# Install the new page assets without overwriting existing files unless they are the Labs files themselves.
foreach ($file in @('labs.html','labs.css','labs.js')) {
    $source = Join-Path $sourcePublic $file
    $target = Join-Path $publicDir $file
    if (Test-Path -LiteralPath $target) {
        $backup = "$target.bak-labs-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -LiteralPath $target -Destination $backup
    }
    Copy-Item -LiteralPath $source -Destination $target -Force
}

$appBackup = "$appPath.bak-labs-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $appPath -Destination $appBackup
[System.IO.File]::WriteAllText($appPath, $app, $utf8)

Write-Host 'CampusX Labs page installed.' -ForegroundColor Green
Write-Host 'Authenticated route added: /labs.html' -ForegroundColor Cyan
Write-Host "Navigation updated on: $($changedPages -join ', ')" -ForegroundColor Cyan
Write-Host 'New page uses existing /api/v1/rooms, devices, telemetry/latest, alerts and /api/v1/health endpoints.' -ForegroundColor Gray
Write-Host 'No database schema, MQTT topics, commands, or device-control logic was changed.' -ForegroundColor Gray
