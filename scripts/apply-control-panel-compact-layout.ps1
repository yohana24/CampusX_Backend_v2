$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$publicDir = Join-Path $projectRoot 'public'
$pagePath = Join-Path $publicDir 'control-panel.html'
$cssPath = Join-Path $publicDir 'control-panel-compact.css'

if (-not (Test-Path $pagePath)) { throw "control-panel.html not found in $publicDir" }
if (-not (Test-Path $cssPath)) { throw "control-panel-compact.css not found in $publicDir" }

$content = [System.IO.File]::ReadAllText($pagePath)
$link = '<link rel="stylesheet" href="control-panel-compact.css?v=20261031-compact1">'
if ($content.Contains('control-panel-compact.css')) {
    Write-Host 'Control Panel compact stylesheet is already linked.' -ForegroundColor DarkYellow
    exit 0
}
if ($content -notmatch '(?i)</head>') { throw 'Could not find </head> in control-panel.html' }

$backup = "$pagePath.bak-compact-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $pagePath -Destination $backup
$content = [regex]::Replace($content, '(?i)</head>', "  $link`r`n</head>", 1)
[System.IO.File]::WriteAllText($pagePath, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host "Updated Control Panel stylesheet link. Backup: $backup" -ForegroundColor Green
Write-Host 'Visual-only change: no JavaScript, API, database, MQTT, or authentication files changed.' -ForegroundColor Cyan
