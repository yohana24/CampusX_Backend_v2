$ErrorActionPreference = 'Stop'
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (!(Test-Path $python)) {
    throw "Virtual environment Python not found: $python"
}
& $python (Join-Path $PSScriptRoot 'mqtt_bridge.py')
