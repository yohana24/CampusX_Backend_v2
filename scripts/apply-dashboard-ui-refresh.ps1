$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$publicDir = Join-Path $projectRoot 'public'
$cssPath = Join-Path $publicDir 'dashboard-ui-refresh.css'

if (-not (Test-Path $cssPath)) {
    throw "Missing dashboard-ui-refresh.css in $publicDir. Extract the ZIP into the project root first."
}

$pages = @(
    'index.html',
    'devices.html',
    'alerts.html',
    'control-panel.html',
    'settings.html',
    'command-history.html'
)

$link = '<link rel="stylesheet" href="dashboard-ui-refresh.css?v=20261031">'
$updated = 0
$skipped = 0

foreach ($page in $pages) {
    $path = Join-Path $publicDir $page
    if (-not (Test-Path $path)) {
        Write-Warning "Page not found; skipped: $page"
        $skipped++
        continue
    }

    $content = [System.IO.File]::ReadAllText($path)
    if ($content.Contains('dashboard-ui-refresh.css')) {
        Write-Host "Already configured: $page" -ForegroundColor DarkYellow
        continue
    }

    if ($content -notmatch '(?i)</head>') {
        Write-Warning "No </head> tag found; skipped: $page"
        $skipped++
        continue
    }

    $backup = "$path.bak-ui-refresh-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $path -Destination $backup
    $content = [regex]::Replace($content, '(?i)</head>', "  $link`r`n</head>", 1)
    [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Updated: $page (backup: $(Split-Path -Leaf $backup))" -ForegroundColor Green
    $updated++
}

Write-Host "`nDashboard UI refresh linked. Updated: $updated; skipped: $skipped." -ForegroundColor Cyan
Write-Host 'No API, database, authentication, or JavaScript behavior was changed.' -ForegroundColor Gray
