$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$state = Join-Path $root '.run'

# One small WMI scan (python.exe only) shared by both scripts. The old version
# scanned all processes once per script and again for every PID.
$all = @(Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue)

function Stop-ManagedProcess([string]$PidFile, [string]$ScriptName, [string]$Label) {
    $ids = @()
    if (Test-Path $PidFile) {
        $raw = (Get-Content $PidFile -Raw).Trim()
        $id = 0
        if ([int]::TryParse($raw, [ref]$id) -and $id -gt 0) { $ids += $id }
    }

    # Also find a manually started instance of the exact CampusX script so the
    # Dashboard Stop button works even if the process was started in a terminal.
    $matches = @($all | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($ScriptName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    foreach ($match in $matches) { $ids += [int]$match.ProcessId }

    $ids = @($ids | Sort-Object -Unique)
    $stopped = 0
    foreach ($id in $ids) {
        $match = @($all | Where-Object {
            [int]$_.ProcessId -eq $id -and $_.CommandLine -and
            $_.CommandLine.IndexOf($ScriptName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        } | Select-Object -First 1)
        if ($match.Count -gt 0) {
            Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
            Write-Host "$Label stopped (PID $id)." -ForegroundColor Green
            $stopped++
        }
    }

    if ($stopped -eq 0) { Write-Host "$Label is not running." -ForegroundColor Yellow }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Stop-ManagedProcess -PidFile (Join-Path $state 'bridge.pid') -ScriptName 'mqtt_bridge.py' -Label 'MQTT Bridge'
Stop-ManagedProcess -PidFile (Join-Path $state 'camera.pid') -ScriptName 'web_count3.py' -Label 'Computer Vision'
Write-Host 'CV stop command completed. Backend (npm start) and Mosquitto were not stopped.'
