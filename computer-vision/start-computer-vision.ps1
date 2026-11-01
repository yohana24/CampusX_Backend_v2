$ErrorActionPreference = 'Stop'

# Starts the original Headcount camera service and the CampusX MQTT bridge.
# Existing matching processes are adopted to avoid duplicate camera/bridge workers.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $root '.venv\Scripts\python.exe'
$cameraScript = Join-Path $root 'web_count_campusx.py'
$bridgeScript = Join-Path $root 'mqtt_bridge.py'
$logs = Join-Path $root 'logs'
$state = Join-Path $root '.run'

New-Item -ItemType Directory -Force -Path $logs, $state | Out-Null

foreach ($required in @($python, $cameraScript, $bridgeScript)) {
    if (-not (Test-Path $required)) {
        throw "Required file not found: $required"
    }
}

function Find-ExistingScriptProcess([string]$ScriptName) {
    return Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and $_.CommandLine.IndexOf($ScriptName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        } |
        Select-Object -First 1
}

function Get-ManagedProcess([string]$PidFile, [string]$ScriptName) {
    if (-not (Test-Path $PidFile)) { return $null }
    $raw = (Get-Content $PidFile -Raw).Trim()
    $id = 0
    if (-not [int]::TryParse($raw, [ref]$id)) {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        return $null
    }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
    if ($proc -and $proc.CommandLine -and $proc.CommandLine.IndexOf($ScriptName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $id
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return $null
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
    if ($found) {
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
    Start-Sleep -Seconds 2
    $stillRunning = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if (-not $stillRunning) {
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
try {
    $null = Invoke-RestMethod -Uri 'http://127.0.0.1:5000/json' -TimeoutSec 2
    $cameraReady = $true
    $cameraExisting = Find-ExistingScriptProcess -ScriptName 'web_count_campusx.py'
    if ($cameraExisting) {
        Set-Content -Path (Join-Path $state 'camera.pid') -Value $cameraExisting.ProcessId -Encoding ascii
        Write-Host "Computer Vision is already responding; adopted PID $($cameraExisting.ProcessId)." -ForegroundColor Yellow
    } else {
        Write-Host 'Computer Vision is already responding at 127.0.0.1:5000; reusing external service.' -ForegroundColor Yellow
    }
} catch {
    $cameraPid = Start-ManagedProcess -Name 'Computer Vision' -ScriptPath $cameraScript `
        -OutLog (Join-Path $logs 'camera.out.log') `
        -ErrLog (Join-Path $logs 'camera.err.log') `
        -PidFile (Join-Path $state 'camera.pid')

    Write-Host 'Waiting for the camera service at http://127.0.0.1:5000/json ...'
    for ($i = 0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 1
        try {
            $null = Invoke-RestMethod -Uri 'http://127.0.0.1:5000/json' -TimeoutSec 2
            $cameraReady = $true
            break
        } catch { }
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
Write-Host 'Camera preview: http://127.0.0.1:5000/'
Write-Host "Logs: $logs"
Write-Host 'The dashboard Stop button stops only these two matching Python scripts.'
