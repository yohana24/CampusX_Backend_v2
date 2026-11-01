$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$publicDir = Join-Path $projectRoot 'public'
$labsHtml = Join-Path $publicDir 'labs.html'
$sourceCss = Join-Path (Split-Path -Parent $PSScriptRoot) 'patch-source\public\labs-navbar.css'
$targetCss = Join-Path $publicDir 'labs-navbar.css'

if (-not (Test-Path -LiteralPath $labsHtml)) { throw "labs.html was not found: $labsHtml" }
if (-not (Test-Path -LiteralPath $sourceCss)) { throw "Patch CSS was not found: $sourceCss. Extract the complete ZIP before running this script." }

$backupDir = Join-Path $projectRoot 'backups\labs-navbar'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $labsHtml -Destination (Join-Path $backupDir "labs.html.$stamp.bak") -Force

# Copy the stylesheet from the extracted patch source into the live public folder.
Copy-Item -LiteralPath $sourceCss -Destination $targetCss -Force

$html = [System.IO.File]::ReadAllText($labsHtml)
$link = '<link rel="stylesheet" href="labs-navbar.css?v=20261031-nav2">'
if ($html -match 'labs-navbar\.css') {
    $html = [regex]::new('<link[^>]+labs-navbar\.css[^>]*>').Replace($html, $link, 1)
} elseif ($html -match '(?i)</head>') {
    if ($html -match '(?i)<link[^>]+labs\.css[^>]*>') {
        $html = [regex]::new('(?i)(<link[^>]+labs\.css[^>]*>)').Replace($html, ('$1' + "`r`n  " + $link), 1)
    } else {
        $html = [regex]::new('(?i)</head>').Replace($html, ("  " + $link + "`r`n</head>"), 1)
    }
} else {
    throw 'Could not find </head> in labs.html.'
}

# Mark Labs as the current page without altering the other navigation links.
$navLinkPattern = '(<a\b(?=[^>]*\bhref=["'']labs\.html["''])(?=[^>]*\bclass=["''][^"'']*\bactive\b[^"'']*["''])[^>]*)(>)'
$navLinkMatch = [regex]::Match($html, $navLinkPattern)
if ($navLinkMatch.Success -and $navLinkMatch.Groups[1].Value -notmatch '\baria-current=') {
    $html = [regex]::new($navLinkPattern).Replace($html, '$1 aria-current="page"$2', 1)
}
[System.IO.File]::WriteAllText($labsHtml, $html, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host 'CampusX Labs navbar updated.' -ForegroundColor Green
Write-Host "Backup: $backupDir\labs.html.$stamp.bak"
Write-Host 'Open /labs.html and press Ctrl + Shift + R.'
