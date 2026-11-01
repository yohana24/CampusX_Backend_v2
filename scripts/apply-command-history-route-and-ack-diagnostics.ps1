$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$appPath = Join-Path $root 'src\app.js'
$mqttPath = Join-Path $root 'src\services\mqttService.js'
$historyPage = Join-Path $root 'public\command-history.html'
$historyScript = Join-Path $root 'public\command-history.js'

foreach ($required in @($appPath, $mqttPath, $historyPage, $historyScript)) {
  if (!(Test-Path $required)) {
    throw "Required file is missing: $required. Extract this ZIP directly into your CampusX_Backend_v2 project root first."
  }
}

# 1) Register the history page in the authenticated HTML page allow-list.
$app = [System.IO.File]::ReadAllText($appPath)
$hasHistoryRoute = $app.Contains("'/command-history.html'") -or $app.Contains('"/command-history.html"')
if (!$hasHistoryRoute) {
  $anchor = "  ['/control-panel.html', 'control-panel.html'],"
  if ([regex]::Matches($app, [regex]::Escape($anchor)).Count -ne 1) {
    throw "Could not find exactly one Control Panel entry in src/app.js pageFiles. No app.js changes were made."
  }
  $insert = $anchor + "`r`n  ['/command-history.html', 'command-history.html'],"
  $updatedApp = $app.Replace($anchor, $insert)
  $appBackup = "$appPath.command-history-route.bak"
  Copy-Item $appPath $appBackup -Force
  [System.IO.File]::WriteAllText($appPath, $updatedApp, [System.Text.UTF8Encoding]::new($false))
  Write-Host "Registered /command-history.html as an authenticated dashboard page. Backup: $appBackup" -ForegroundColor Green
} else {
  Write-Host '/command-history.html is already registered in src/app.js.' -ForegroundColor Yellow
}

# 2) Log the exact incoming ACK and use either camelCase or SQL-style result keys.
$mqtt = [System.IO.File]::ReadAllText($mqttPath)
if ($mqtt -notmatch 'Command response received on') {
  $normalized = $mqtt.Replace("`r`n", "`n")
  $start = '      if (/^smart-campus\/devices\/[^/]+\/command-response$/.test(topic)) {'
  $startIndex = $normalized.IndexOf($start, [System.StringComparison]::Ordinal)
  if ($startIndex -lt 0) {
    throw "Could not find the command-response handler in src/services/mqttService.js. app.js may already be updated; inspect mqttService.js before retrying."
  }
  $endMarker = "`n      }"
  $endIndex = $normalized.IndexOf($endMarker, $startIndex, [System.StringComparison]::Ordinal)
  if ($endIndex -lt 0) {
    throw "Could not find the end of the command-response handler in mqttService.js. No mqttService.js changes were made."
  }
  $endIndex += $endMarker.Length
  $oldBlock = $normalized.Substring($startIndex, $endIndex - $startIndex)
  $newBlock = @'
      if (/^smart-campus\/devices\/[^/]+\/command-response$/.test(topic)) {
        const rawResponse = message.toString('utf8');
        console.log(`[MQTT] Command response received on ${topic}: ${rawResponse}`);
        const result = await processCommandResponse(topic, message);
        if (result) {
          const commandId = result.commandId ?? result.CommandId ?? result.command_id ?? 'unknown';
          const status = result.status ?? result.Status ?? 'unknown';
          console.log(`[Command] ${commandId} -> ${status}`);
        } else {
          console.warn(`[Command] Response ignored on ${topic}`);
        }
      }
'@
  $newBlock = $newBlock.TrimEnd("`r", "`n")
  $updatedMqtt = $normalized.Replace($oldBlock, $newBlock)
  $mqttBackup = "$mqttPath.command-ack-diagnostics.bak"
  Copy-Item $mqttPath $mqttBackup -Force
  [System.IO.File]::WriteAllText($mqttPath, $updatedMqtt, [System.Text.UTF8Encoding]::new($false))
  Write-Host "Added incoming MQTT ACK diagnostics and normalized command result logging. Backup: $mqttBackup" -ForegroundColor Green
} else {
  Write-Host 'MQTT ACK diagnostics are already installed.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Now run:' -ForegroundColor Cyan
Write-Host 'node --check .\src\app.js'
Write-Host 'node --check .\src\services\mqttService.js'
Write-Host 'node --check .\public\command-history.js'
Write-Host 'node --check .\public\control-panel-live.js'
Write-Host 'Then restart npm start.' -ForegroundColor Cyan
