$ErrorActionPreference = 'Stop'
$target = Join-Path $PSScriptRoot 'public\dashboard-app.js'
if (-not (Test-Path $target)) {
    throw "Cannot find $target. Run this script from the CampusX_Backend_v2 project root."
}
$content = [System.IO.File]::ReadAllText($target)
$pattern = "(?m)^(\s*)else if \(file === 'settings\.html'\) await loadSettings\(\);"
if ($content -notmatch $pattern) {
    if ($content -match "settings\.html.*loadSettings") {
        Write-Host 'A Settings loadSettings branch is present but has a different format. Please inspect refreshCurrentPage() manually.' -ForegroundColor Yellow
        exit 2
    }
    Write-Host 'No legacy Settings loadSettings branch found; no change needed.' -ForegroundColor Green
    exit 0
}
$backup = "$target.before-settings-live.bak"
Copy-Item $target $backup -Force
$replacement = '${1}else if (file === ''settings.html'') { /* Settings page is managed by settings-account.js (live account/system APIs). */ }'
$updated = [regex]::Replace($content, $pattern, $replacement, 1)
[System.IO.File]::WriteAllText($target, $updated, [System.Text.UTF8Encoding]::new($false))
Write-Host 'Patched dashboard-app.js successfully.' -ForegroundColor Green
Write-Host "Backup: $backup"
