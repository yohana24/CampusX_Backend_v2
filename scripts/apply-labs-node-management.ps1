$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$publicDir = Join-Path $projectRoot 'public'
$sourcePublic = Join-Path $PSScriptRoot '..\patch-source\public'
$htmlPath = Join-Path $publicDir 'labs.html'
$jsPath = Join-Path $publicDir 'labs.js'

foreach ($path in @($publicDir, $htmlPath, $jsPath)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Required project file not found: $path" }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($file in @('labs.html', 'labs.js')) {
    $target = Join-Path $publicDir $file
    Copy-Item -LiteralPath $target -Destination "$target.bak-add-nodes-$stamp" -Force
    Write-Host "Backup created: public\$file.bak-add-nodes-$stamp" -ForegroundColor DarkGray
}

foreach ($file in @('labs-nodes.js', 'labs-nodes.css')) {
    $source = Join-Path $sourcePublic $file
    if (-not (Test-Path -LiteralPath $source)) { throw "Patch asset not found: $source" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $publicDir $file) -Force
    Write-Host "Installed public\$file" -ForegroundColor Cyan
}

$html = Get-Content -LiteralPath $htmlPath -Raw
if ($html -notmatch 'labs-nodes\.css') {
    $cssTag = '  <link rel="stylesheet" href="labs-nodes.css?v=20261031-nodes1">' + [Environment]::NewLine
    if ($html -notmatch '</head>') { throw 'Could not find </head> in public\labs.html' }
    $html = $html.Replace('</head>', "$cssTag</head>")
}
if ($html -notmatch 'labs-nodes\.js') {
    $jsTag = '  <script src="labs-nodes.js?v=20261031-nodes1"></script>' + [Environment]::NewLine
    if ($html -notmatch '</body>') { throw 'Could not find </body> in public\labs.html' }
    $html = $html.Replace('</body>', "$jsTag</body>")
}

$js = Get-Content -LiteralPath $jsPath -Raw
$old = 'host.innerHTML = `<section class="labs-detail-panel">'
$new = 'host.innerHTML = `<section class="labs-detail-panel" data-room-id="${id}">'
if ($js.Contains($old)) {
    $js = $js.Replace($old, $new)
} elseif ($js -notmatch 'labs-detail-panel" data-room-id="\$\{id\}') {
    throw 'Could not find the Labs detail panel template in public\labs.js. No JS changes were written; share your current labs.js so the patch can be adapted safely.'
}

Set-Content -LiteralPath $htmlPath -Value $html -Encoding UTF8
Set-Content -LiteralPath $jsPath -Value $js -Encoding UTF8
Write-Host ''
Write-Host 'Labs Node Management installed.' -ForegroundColor Green
Write-Host 'The selected lab now displays its registered Nodes and an Add Node form.' -ForegroundColor Gray
Write-Host 'Uses GET /api/v1/nodes, GET /api/v1/node-types, GET /api/v1/devices and POST /api/v1/nodes.' -ForegroundColor Gray
Write-Host 'New Nodes are saved in dbo.Nodes with the selected RoomId; no SQL migration is required.' -ForegroundColor Gray
