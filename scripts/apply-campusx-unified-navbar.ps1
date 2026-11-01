$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$publicDir = Join-Path $projectRoot 'public'
$globalCss = Join-Path $publicDir 'dashboard-ui-refresh.css'

if (-not (Test-Path -LiteralPath $publicDir)) {
    throw "Public folder not found: $publicDir"
}
if (-not (Test-Path -LiteralPath $globalCss)) {
    throw "dashboard-ui-refresh.css was not found. Install the CampusX Dashboard Style Upgrade first."
}

# Every authenticated page receives exactly the same navigation, in the same order.
$pages = @(
    @{ File = 'index.html';           Label = 'Dashboard';       Icon = 'layout-dashboard' },
    @{ File = 'labs.html';            Label = 'Labs';            Icon = 'building-2' },
    @{ File = 'devices.html';         Label = 'Devices';         Icon = 'cpu' },
    @{ File = 'alerts.html';          Label = 'Alerts';          Icon = 'bell' },
    @{ File = 'control-panel.html';   Label = 'Control Panel';   Icon = 'sliders-horizontal' },
    @{ File = 'command-history.html'; Label = 'Command History'; Icon = 'history' },
    @{ File = 'settings.html';        Label = 'Settings';        Icon = 'settings' }
)

$backupDir = Join-Path $projectRoot 'backups\unified-navbar'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$navPattern = '(?is)(<nav\b(?=[^>]*\bclass="[^"]*\bsidebar-nav\b[^"]*")[^>]*>).*?(\s*)(</nav>)'
$updated = 0

foreach ($page in $pages) {
    $path = Join-Path $publicDir $page.File
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Warning "Page not found; skipped: $($page.File)"
        continue
    }

    $html = [System.IO.File]::ReadAllText($path)
    $navMatches = [regex]::Matches($html, $navPattern)
    if ($navMatches.Count -ne 1) {
        throw "Expected exactly one sidebar-nav in $($page.File), found $($navMatches.Count). No changes were written to this file."
    }

    $links = foreach ($item in $pages) {
        $isActive = $item.File -eq $page.File
        $className = if ($isActive) { 'nav-item active' } else { 'nav-item' }
        $ariaCurrent = if ($isActive) { ' aria-current="page"' } else { '' }
        '        <a class="{0}" href="{1}"{2}><i data-lucide="{3}"></i><span>{4}</span></a>' -f `
            $className, $item.File, $ariaCurrent, $item.Icon, $item.Label
    }

    $match = $navMatches[0]
    $newNav = $match.Groups[1].Value + "`r`n" + ($links -join "`r`n") + $match.Groups[2].Value + $match.Groups[3].Value
    $updatedHtml = $html.Remove($match.Index, $match.Length).Insert($match.Index, $newNav)

    # Labs used to load a page-only navbar override. Remove it so every page
    # uses the same shared dashboard-ui-refresh.css rules.
    if ($page.File -eq 'labs.html') {
        $updatedHtml = [regex]::Replace(
            $updatedHtml,
            '(?im)^[\t ]*<link\b(?=[^>]*labs-navbar\.css)[^>]*>\s*',
            '',
            1
        )
    }

    # Ensure the shared visual layer is present on every page.
    if ($updatedHtml -notmatch 'dashboard-ui-refresh\.css') {
        $sharedLink = '  <link rel="stylesheet" href="dashboard-ui-refresh.css?v=20261031-unified-nav">' + "`r`n"
        if ($updatedHtml -match '(?i)</head>') {
            $updatedHtml = [regex]::Replace($updatedHtml, '(?i)</head>', ($sharedLink + '</head>'), 1)
        } else {
            throw "Could not find </head> in $($page.File)."
        }
    }

    $backupPath = Join-Path $backupDir ("{0}.{1}.bak" -f $page.File, $stamp)
    Copy-Item -LiteralPath $path -Destination $backupPath -Force
    [System.IO.File]::WriteAllText($path, $updatedHtml, [System.Text.UTF8Encoding]::new($false))

    Write-Host "Updated navigation: $($page.File)" -ForegroundColor Green
    Write-Host "  Backup: $backupPath" -ForegroundColor DarkGray
    $updated++
}

Write-Host ''
Write-Host "CampusX unified navbar applied. Pages updated: $updated" -ForegroundColor Cyan
Write-Host 'All pages now share: Dashboard, Labs, Devices, Alerts, Control Panel, Command History, Settings.' -ForegroundColor Gray
Write-Host 'No API, database, MQTT, authentication, or page business logic was changed.' -ForegroundColor Gray
