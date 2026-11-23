$ErrorActionPreference = 'Stop'

# Starts the original Headcount camera service and the CampusX MQTT bridge.
# Existing matching processes are adopted to avoid duplicate camera/bridge workers.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $root '.venv\Scripts\python.exe'
$cameraScript = Join-Path $root 'web_count3.py'
$bridgeScript = Join-Path $root 'mqtt_bridge.py'
$logs = Join-Path $root 'logs'
$state = Join-Path $root '.run'
$cvHost = if ($env:CV_WEB_HOST) { $env:CV_WEB_HOST } else { '127.0.0.1' }
$cvPort = if ($env:CV_WEB_PORT) { $env:CV_WEB_PORT } else { '5000' }
$healthUrl = "http://${cvHost}:${cvPort}/json"
$probeUrl = "http://${cvHost}:${cvPort}/health"

New-Item -ItemType Directory -Force -Path $logs, $state | Out-Null

foreach ($required in @($python, $cameraScript, $bridgeScript)) {
    if (-not (Test-Path $required)) {
        throw "Required file not found: $required"
    }
}

# One small WMI snapshot (python.exe only) reused by every adoption check.
# This replaces the repeated full Win32_Process scans that made start slow.
$script:procCache = $null
$script:procCacheAt = [datetime]::MinValue
function Get-ProcessSnapshot {
    if ($null -eq $script:procCache -or ((Get-Date) - $script:procCacheAt).TotalSeconds -gt 5) {
        $script:procCache = @(Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue)
        $script:procCacheAt = Get-Date
    }
    return $script:procCache
}
function Find-ExistingScriptProcess([string]$ScriptName) {
    $match = @(Get-ProcessSnapshot | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($ScriptName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    } | Select-Object -First 1)
    if ($match.Count -gt 0) { return $match[0] }
    return $null
}
function Get-ManagedProcess([string]$PidFile, [string]$ScriptName) {
    if (-not (Test-Path $PidFile)) { return $null }
    $raw = (Get-Content $PidFile -Raw).Trim()
    $id = 0
    if (-not [int]::TryParse($raw, [ref]$id)) {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        return $null
    }
    $match = @(Get-ProcessSnapshot | Where-Object { [int]$_.ProcessId -eq $id } | Select-Object -First 1)
    if ($match.Count -gt 0 -and $match[0].CommandLine -and
        $match[0].CommandLine.IndexOf($ScriptName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $id
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return $null
}
function Test-Health {
    try {
        # /health is a lightweight endpoint; /json can lag while YOLO is busy.
        $null = Invoke-RestMethod -Uri $probeUrl -TimeoutSec 3
        return $true
    } catch {
        return $false
    }
}

function Start-ManagedProcess(
    [string]$Name,
    [string]$ScriptPath,
    [string]$OutLog,
    [string]$ErrLog,
    [string]$PidFile
) {
    $scriptName = [IO.Path]::GetFileName($ScriptPath)
    $existing = Get-ManagedProcess -PidFile $PidFile -ScriptName $scriptName
    if ($existing) {
        Write-Host "$Name is already running (PID $existing)." -ForegroundColor Yellow
        return $existing
    }

    # Adopt a manually launched process of this exact script instead of starting a duplicate.
    $found = Find-ExistingScriptProcess -ScriptName $scriptName
    if ($null -ne $found) {
        Set-Content -Path $PidFile -Value $found.ProcessId -Encoding ascii
        Write-Host "$Name is already running; adopted PID $($found.ProcessId)." -ForegroundColor Yellow
        return [int]$found.ProcessId
    }

    $argument = '"' + $ScriptPath + '"'
    $proc = Start-Process -FilePath $python `
        -ArgumentList @('-u', $argument) `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $OutLog `
        -RedirectStandardError $ErrLog `
        -PassThru

    Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii
    # Short verify loop instead of a blind 2 second sleep.
    $started = $false
    for ($i = 0; $i -lt 12; $i++) {
        Start-Sleep -Milliseconds 250
        if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) { $started = $true; break }
    }
    if (-not $started) {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        $details = ''
        if (Test-Path $ErrLog) { $details = (Get-Content $ErrLog -Tail 30) -join "`n" }
        throw "$Name exited during startup. Check $ErrLog`n$details"
    }
    Write-Host "$Name started (PID $($proc.Id))." -ForegroundColor Green
    return $proc.Id
}

# Reuse the teammate's camera process if its JSON endpoint is already healthy.
$cameraReady = $false
if (Test-Health) {
    $cameraReady = $true
    $cameraExisting = Find-ExistingScriptProcess -ScriptName 'web_count3.py'
    if ($null -ne $cameraExisting) {
        Set-Content -Path (Join-Path $state 'camera.pid') -Value $cameraExisting.ProcessId -Encoding ascii
        Write-Host "Computer Vision is already responding; adopted PID $($cameraExisting.ProcessId)." -ForegroundColor Yellow
    } else {
        Write-Host "Computer Vision is already responding at $healthUrl; reusing external service." -ForegroundColor Yellow
    }
} else {
    $cameraPid = Start-ManagedProcess -Name 'Computer Vision' -ScriptPath $cameraScript `
        -OutLog (Join-Path $logs 'camera.out.log') `
        -ErrLog (Join-Path $logs 'camera.err.log') `
        -PidFile (Join-Path $state 'camera.pid')

    Write-Host "Waiting for the camera service at $healthUrl ..."
    # Poll fast (300 ms) so we return as soon as YOLO + camera are ready, but
    # cap the whole wait by wall-clock time so a stuck service cannot stretch
    # the dashboard Start request to the backend timeout.
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
        if (Test-Health) { $cameraReady = $true; break }
        if (-not (Get-Process -Id $cameraPid -ErrorAction SilentlyContinue)) { break }
    }
}

if (-not $cameraReady) {
    $err = Join-Path $logs 'camera.err.log'
    $details = if (Test-Path $err) { (Get-Content $err -Tail 40) -join "`n" } else { 'No camera error log exists.' }
    throw "Computer Vision did not become ready at /json. Check $err`n$details"
}

$null = Start-ManagedProcess -Name 'MQTT Bridge' -ScriptPath $bridgeScript `
    -OutLog (Join-Path $logs 'bridge.out.log') `
    -ErrLog (Join-Path $logs 'bridge.err.log') `
    -PidFile (Join-Path $state 'bridge.pid')

Write-Host ''
Write-Host 'CampusX Computer Vision is running.' -ForegroundColor Green
Write-Host "Camera preview: http://${cvHost}:${cvPort}/"
Write-Host "Logs: $logs"
Write-Host 'The dashboard Stop button stops only these two matching Python scripts.'
