$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$state = Join-Path $root '.run'

function Stop-ManagedProcess([string]$PidFile, [string]$ScriptName, [string]$Label) {
    $ids = @()
    if (Test-Path $PidFile) {
        $raw = (Get-Content $PidFile -Raw).Trim()
        $id = 0
        if ([int]::TryParse($raw, [ref]$id) -and $id -gt 0) { $ids += $id }
    }

    # Also find a manually started instance of the exact CampusX script so the
    # Dashboard Stop button works even if the process was started in a terminal.
    $matches = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and $_.CommandLine.IndexOf($ScriptName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        }
    foreach ($match in $matches) { $ids += [int]$match.ProcessId }

    $ids = @($ids | Sort-Object -Unique)
    foreach ($id in $ids) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
        if ($proc -and $proc.CommandLine -and $proc.CommandLine.IndexOf($ScriptName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
            Write-Host "$Label stopped (PID $id)." -ForegroundColor Green
        }
    }

    if ($ids.Count -eq 0) { Write-Host "$Label is not running." -ForegroundColor Yellow }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Stop-ManagedProcess -PidFile (Join-Path $state 'bridge.pid') -ScriptName 'mqtt_bridge.py' -Label 'MQTT Bridge'
Stop-ManagedProcess -PidFile (Join-Path $state 'camera.pid') -ScriptName 'web_count_campusx.py' -Label 'Computer Vision'
Write-Host 'CV stop command completed. Backend (npm start) and Mosquitto were not stopped.'
