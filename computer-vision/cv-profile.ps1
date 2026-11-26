<#
.SYNOPSIS
  Switch CampusX Computer Vision between the laptop webcam and the ESP32-CAM.

.DESCRIPTION
  Rewrites computer-vision\.env with a clean profile. web_count3.py loads that
  file itself (override=True), so no Node backend restart is needed: just press
  Stop then Start in the dashboard (or run start-computer-vision.ps1).

.EXAMPLE
  .\cv-profile.ps1 laptop

.EXAMPLE
  .\cv-profile.ps1 esp32 -Esp32Url http://192.168.1.50/stream
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('laptop', 'esp32')]
    [string]$Mode,

    [string]$Esp32Url = 'http://192.168.1.50/stream'
)

$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '.env'

if ($Mode -eq 'esp32' -and $Esp32Url -notmatch '/stream$') {
    throw "Esp32Url must end with /stream (MJPEG). Got: $Esp32Url"
}

# Keep operator-owned values (device id, broker, log paths) from the old file.
$existing = @{}
if (Test-Path $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $parts = $line -split '=', 2
        $existing[$parts[0].Trim()] = $parts[1]
    }
}
function Pick([string]$Key, [string]$Default) {
    if ($existing.ContainsKey($Key) -and $existing[$Key] -ne '') { return $existing[$Key] }
    return $Default
}

if ($Mode -eq 'laptop') {
    $detector = 'person'
    $model = 'yolov8n.pt'
    $source = '0'
    $simulate = 'false'
    $confKeep = '0.30'
    $confNew = '0.45'
    $minHits = '3'
    $smooth = '3'
    $grace = '4'
    $minArea = '0.02'
    $maxArea = '0.90'
    $minRatio = '0.3'
    $maxRatio = '4.0'
    $angle = 'Front / side view - full-body person detector'
} else {
    $detector = 'head'
    $model = 'head240.pt'
    $source = $Esp32Url
    $simulate = 'true'
    $confKeep = '0.25'
    $confNew = '0.45'
    $minHits = '3'
    $smooth = '5'
    $grace = '6'
    $minArea = '0.0002'
    $maxArea = '0.10'
    $minRatio = '0.5'
    $maxRatio = '2.5'
    $angle = 'Overhead / top-down view - head detector (head240.pt)'
}

$content = @"
# ---------------------------------------------------------------------------
# CampusX Computer Vision - ACTIVE PROFILE: $($Mode.ToUpper())
# Camera: $angle
# Switch: .\cv-profile.ps1 laptop   |   .\cv-profile.ps1 esp32 -Esp32Url http://IP/stream
# ---------------------------------------------------------------------------

DEVICE_ID=$(Pick 'DEVICE_ID' 'people-counter-lab-01')

# Detector
CV_DETECTOR=$detector
CV_MODEL_PATH=$model
CV_SOURCE=$source
CV_SIMULATE_240=$simulate
CV_CONF_KEEP=$confKeep
CV_CONF_NEW=$confNew
CV_MIN_HITS=$minHits
CV_SMOOTH=$smooth
CV_GRACE=$grace
CV_IMGSZ=640
CV_TARGET_FPS=5
CV_ALWAYS=true
CV_ACTIVE_FROM=9
CV_ACTIVE_TO=15
CV_CLASS_FILTER=0

# Fallbacks stay off: the active detector is authoritative.
CV_FACE_FALLBACK=false
CV_PERSON_FALLBACK=false
CV_PERSON_MODEL=$(Pick 'CV_PERSON_MODEL' 'yolov8n.pt')
CV_PERSON_CONF=$(Pick 'CV_PERSON_CONF' '0.25')

CV_MIN_AREA=$minArea
CV_MAX_AREA=$maxArea
CV_MIN_RATIO=$minRatio
CV_MAX_RATIO=$maxRatio

CV_WEB_HOST=$(Pick 'CV_WEB_HOST' '127.0.0.1')
CV_WEB_PORT=$(Pick 'CV_WEB_PORT' '5000')
CV_ZONES_FILE=$(Pick 'CV_ZONES_FILE' 'ignore_zones.json')
CV_CALIBRATE_SECONDS=$(Pick 'CV_CALIBRATE_SECONDS' '30')
CV_LOG_FILE=$(Pick 'CV_LOG_FILE' 'counts.csv')
CV_LOG_EVERY=$(Pick 'CV_LOG_EVERY' '60')

# MQTT bridge
CV_JSON_URL=$(Pick 'CV_JSON_URL' 'http://127.0.0.1:5000/json')
CV_HTTP_TIMEOUT_SECONDS=$(Pick 'CV_HTTP_TIMEOUT_SECONDS' '3')
PUBLISH_INTERVAL_SECONDS=$(Pick 'PUBLISH_INTERVAL_SECONDS' '2')
MQTT_HOST=$(Pick 'MQTT_HOST' '127.0.0.1')
MQTT_PORT=$(Pick 'MQTT_PORT' '1883')
MQTT_TOPIC=$(Pick 'MQTT_TOPIC' 'smart-campus/telemetry')
MQTT_USERNAME=$(Pick 'MQTT_USERNAME' '')
MQTT_PASSWORD=$(Pick 'MQTT_PASSWORD' '')
MQTT_KEEPALIVE=$(Pick 'MQTT_KEEPALIVE' '30')
MQTT_QOS=$(Pick 'MQTT_QOS' '1')
LOG_LEVEL=$(Pick 'LOG_LEVEL' 'INFO')
"@

Set-Content -LiteralPath $envFile -Value $content -Encoding UTF8

Write-Host "CV profile set to '$Mode'." -ForegroundColor Green
Write-Host "  detector=$detector  model=$model  source=$source" -ForegroundColor Gray
Write-Host ''
Write-Host 'Next: Stop then Start Computer Vision (dashboard or start-computer-vision.ps1).' -ForegroundColor Yellow
Write-Host 'No backend restart is needed: web_count3.py reads this file directly.' -ForegroundColor DarkGray
