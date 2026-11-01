$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$publicDir = Join-Path $projectRoot 'public'
$srcDir = Join-Path $projectRoot 'src'
$cvDir = Join-Path $projectRoot 'computer-vision'
$htmlPath = Join-Path $publicDir 'control-panel.html'
$jsPath = Join-Path $publicDir 'control-panel-live.js'
$appPath = Join-Path $srcDir 'app.js'
$automationServicePath = Join-Path $srcDir 'services\occupancyAutomationService.js'
$mqttPath = Join-Path $srcDir 'services\mqttService.js'
$responseServicePath = Join-Path $srcDir 'services\commandResponseService.js'
$automationCssPath = Join-Path $publicDir 'control-panel-automation.css'
$automationRoutePath = Join-Path $srcDir 'routes\occupancyAutomation.js'
$cvRoutePath = Join-Path $srcDir 'routes\computerVision.js'
$cvManagerPath = Join-Path $srcDir 'services\computerVisionManager.js'
$cvControlCssPath = Join-Path $publicDir 'control-panel-cv-control.css'
$occupancyCssPath = Join-Path $publicDir 'control-panel-occupancy.css'

$required = @($htmlPath, $jsPath, $appPath, $automationServicePath, $mqttPath, $automationRoutePath, $automationCssPath)
foreach ($path in $required) { if (-not (Test-Path -LiteralPath $path)) { throw "Required file missing: $path. Install Occupancy Automation first." } }

$packageRoot = Split-Path -Parent $PSScriptRoot
$utf8 = [System.Text.UTF8Encoding]::new($false)

# Keep the existing Home Dashboard CV process manager. Copy its modules only if missing.
$routeSource = Join-Path $packageRoot 'src\routes\computerVision.js'
$managerSource = Join-Path $packageRoot 'src\services\computerVisionManager.js'
$startSource = Join-Path $packageRoot 'computer-vision\start-computer-vision.ps1'
$stopSource = Join-Path $packageRoot 'computer-vision\stop-computer-vision.ps1'
foreach ($source in @($routeSource, $managerSource, $startSource, $stopSource)) {
    if (-not (Test-Path -LiteralPath $source)) { throw "Patch package is incomplete: $source" }
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cvRoutePath), (Split-Path -Parent $cvManagerPath), $cvDir | Out-Null
if (-not (Test-Path -LiteralPath $cvRoutePath)) { Copy-Item -LiteralPath $routeSource -Destination $cvRoutePath }
if (-not (Test-Path -LiteralPath $cvManagerPath)) { Copy-Item -LiteralPath $managerSource -Destination $cvManagerPath }
if (-not (Test-Path -LiteralPath (Join-Path $cvDir 'start-computer-vision.ps1'))) { Copy-Item -LiteralPath $startSource -Destination (Join-Path $cvDir 'start-computer-vision.ps1') }
if (-not (Test-Path -LiteralPath (Join-Path $cvDir 'stop-computer-vision.ps1'))) { Copy-Item -LiteralPath $stopSource -Destination (Join-Path $cvDir 'stop-computer-vision.ps1') }

$app = [System.IO.File]::ReadAllText($appPath)
if ($app -notmatch 'app\.use\(''/api/v1/computer-vision''') {
    if ($app -notmatch 'requireDashboardApi') {
        throw "The shared Dashboard CV API route is not mounted and requireDashboardApi was not found in src/app.js. The Control Panel buttons were not installed."
    }
    if ($app -notmatch 'const\s+computerVisionRouter\s*=\s*require\(''\./routes/computerVision''\)') {
        $apiImportPattern = '(?m)^([ \t]*const\s+apiRouter\s*=\s*require\(''\./routes/api''\);[ \t]*)$'
        if ($app -notmatch $apiImportPattern) { throw "Could not safely locate the apiRouter import in src/app.js." }
        $app = [regex]::Replace($app, $apiImportPattern, '$1' + "`r`nconst computerVisionRouter = require('./routes/computerVision');", 1)
    }
    $mountPattern = '(?m)^([ \t]*app\.use\(''/api/v1'',\s*requireDashboardApi,\s*apiKeyGuard,\s*apiRouter\);[ \t]*)$'
    if ($app -notmatch $mountPattern) { throw "Could not safely locate the protected /api/v1 mount in src/app.js. Keep the existing app.js unchanged and confirm the Home Dashboard CV controls API is installed." }
    $app = [regex]::Replace($app, $mountPattern, "app.use('/api/v1/computer-vision', requireDashboardApi, apiKeyGuard, computerVisionRouter);`r`n`$1", 1)
}
$html = [System.IO.File]::ReadAllText($htmlPath)
$js = [System.IO.File]::ReadAllText($jsPath)
$service = [System.IO.File]::ReadAllText($automationServicePath)
$mqtt = [System.IO.File]::ReadAllText($mqttPath)
$responseService = if (Test-Path -LiteralPath $responseServicePath) { [System.IO.File]::ReadAllText($responseServicePath) } else { '' }

if ($html -notmatch 'control-occupancy-automation' -or $js -notmatch 'function renderOccupancyAutomation\(') {
    throw 'Occupancy Automation controls were not found. Install/fix the Occupancy Automation patch before this integration.'
}
if ($mqtt -notmatch 'evaluateOccupancyAutomation') {
    throw 'MQTT telemetry is not connected to Occupancy Automation. Reinstall the Occupancy Automation patch before enabling relay automation.'
}
if ($js -notmatch "function apiRequest\(" -or $js -notmatch "function renderOccupancy\(") {
    throw 'Unexpected control-panel-live.js version. No Control Panel files were changed.'
}

# Place a half-width CV process manager beside Temperature & Fan Control,
# then move the occupancy/automation card into its own full-width row.
$cvBlock = @'
     <!-- Computer Vision Service Control Card -->
     <div class="ctrl-card cv-manager-card" id="control-cv-manager">
      <div class="cv-manager-head">
       <div class="cv-manager-heading">
        <i data-lucide="scan-eye"></i>
        <div>
         <h3>Computer Vision Service</h3>
         <p>Start or stop the camera service and CampusX MQTT Bridge.</p>
        </div>
       </div>
       <span class="cv-manager-state is-checking" id="control-cv-manager-state" role="status" aria-live="polite">CHECKING</span>
      </div>
      <div class="cv-manager-status-grid">
       <div class="cv-manager-status-item"><span>Camera service</span><strong id="control-cv-camera-state">Checking…</strong></div>
       <div class="cv-manager-status-item"><span>MQTT Bridge</span><strong id="control-cv-bridge-state">Checking…</strong></div>
       <div class="cv-manager-status-item"><span>Live camera count</span><strong id="control-cv-live-count">—</strong></div>
       <div class="cv-manager-status-item"><span>YOLO inference</span><strong id="control-cv-inference">—</strong></div>
      </div>
      <div class="cv-manager-actions">
       <button class="btn-primary-sm" id="control-cv-start" type="button"><i data-lucide="play"></i>Start Computer Vision</button>
       <button class="btn-secondary-sm" id="control-cv-stop" type="button" disabled><i data-lucide="square"></i>Stop</button>
       <a class="btn-secondary-sm is-disabled" id="control-cv-preview" href="http://127.0.0.1:5000/" target="_blank" rel="noopener" aria-disabled="true"><i data-lucide="video"></i>Open Preview</a>
       <span class="cv-manager-updated" id="control-cv-checked">Status refreshes every 10 seconds</span>
      </div>
      <p class="cv-manager-note">Start runs web_count_campusx.py and mqtt_bridge.py on the CampusX host. Stop closes these two processes only; Node.js and Mosquitto stay running.</p>
     </div>
    </div>

    <!-- Computer Vision Occupancy + Automation Card -->
    <div class="ctrl-card cv-occupancy-card cv-occupancy-full" id="control-cv-card">
      <div class="card-header-bar cv-card-header">
       <div class="header-title-group">
        <i class="blue-text" data-lucide="users"></i>
        <div>
         <h3>Computer Vision · Room Occupancy</h3>
         <p>Latest detected people count and occupancy-based device automation</p>
        </div>
       </div>
       <span class="pill-badge-blue cv-live-badge" id="control-cv-state">● CHECKING CAMERA DATA</span>
      </div>
      <div class="cv-occupancy-layout">
       <section class="cv-count-panel" aria-label="Current people count">
        <div class="cv-count-label"><i data-lucide="users"></i><span>PEOPLE DETECTED NOW</span></div>
        <div class="headcount-num" id="control-current-count">—</div>
        <div class="cv-count-caption">Latest camera detection · not daily entries</div>
        <div class="cv-count-footnote" id="control-occupancy-footer">Waiting for the first camera reading.</div>
       </section>
       <section class="cv-occupancy-details" aria-label="Occupancy details">
        <div class="cv-info-tile"><span class="cv-tile-icon"><i data-lucide="map-pin"></i></span><div class="cv-tile-copy"><small>SELECTED ROOM</small><strong id="control-cv-room-code">—</strong><span id="control-cv-room-name">Room not selected</span></div></div>
        <div class="cv-info-tile"><span class="cv-tile-icon"><i data-lucide="users-round"></i></span><div class="cv-tile-copy"><small>ROOM CAPACITY</small><strong id="control-capacity-label">Not configured</strong><span>Maximum people</span></div></div>
        <div class="cv-info-tile"><span class="cv-tile-icon"><i data-lucide="chart-no-axes-column-increasing"></i></span><div class="cv-tile-copy"><small>CAPACITY USED</small><strong id="control-capacity-percent">—</strong><span>Based on configured room capacity</span></div></div>
        <div class="cv-info-tile"><span class="cv-tile-icon"><i data-lucide="armchair"></i></span><div class="cv-tile-copy"><small>AVAILABLE PLACES</small><strong id="control-cv-remaining">—</strong><span>Calculated from latest count</span></div></div>
       </section>
      </div>
      <div class="cv-capacity-section">
       <div class="cv-capacity-heading"><span>Room occupancy</span><span id="control-cv-capacity-summary">Capacity not configured</span></div>
       <div class="occupancy-progress-bar cv-progress-track"><div class="progress-fill" id="control-capacity-fill" style="width:0%"></div></div>
      </div>
      <div class="cv-card-footer">
       <div class="cv-source-meta">
        <span><i data-lucide="camera"></i><span id="control-cv-device-label">CV device</span></span>
        <span><i data-lucide="clock-3"></i>Last reading: <strong id="control-cv-last-seen">—</strong></span>
       </div>
       <div class="cv-card-actions">
        <button class="btn-secondary-xs" id="control-set-capacity" type="button"><i data-lucide="sliders"></i>Set Capacity</button>
        <a class="btn-secondary-xs" href="http://127.0.0.1:5000/" id="control-camera-preview" rel="noopener" target="_blank"><i data-lucide="external-link"></i>Camera Preview</a>
       </div>
      </div>

      <section class="cv-automation-panel" id="control-occupancy-automation" aria-label="Occupancy automation settings">
       <div class="cv-automation-head">
        <div class="cv-automation-headline">
         <i data-lucide="workflow"></i>
         <div>
          <h4 class="cv-automation-title">Occupancy Automation</h4>
          <p class="cv-automation-subtitle">Send ON/OFF commands to the selected real relay devices using fresh people_count telemetry.</p>
         </div>
        </div>
        <div class="cv-automation-status-line">
         <label class="cv-automation-toggle"><input id="control-occupancy-auto-enabled" type="checkbox"> Enable automation</label>
         <span class="cv-automation-state" id="control-occupancy-auto-state">DISABLED</span>
        </div>
       </div>
       <div class="cv-automation-grid">
        <label class="cv-automation-field">Turn OFF when people count is at or below
         <input id="control-occupancy-off-threshold" type="number" min="0" max="500" step="1" value="3">
        </label>
        <label class="cv-automation-field">Condition must stay true for (seconds)
         <input id="control-occupancy-off-delay" type="number" min="5" max="3600" step="5" value="30">
        </label>
        <label class="cv-automation-field">Fan output device
         <select id="control-occupancy-fan-device"><option value="">Loading actuator devices…</option></select>
        </label>
        <label class="cv-automation-field">Light output device
         <select id="control-occupancy-light-device"><option value="">Loading actuator devices…</option></select>
        </label>
       </div>
       <div class="cv-automation-output-states" aria-label="Confirmed actuator states stored in SQL Server">
        <div class="cv-output-state"><span>Fan relay · server-confirmed state</span><strong id="control-occupancy-fan-state">—</strong></div>
        <div class="cv-output-state"><span>Light relay · server-confirmed state</span><strong id="control-occupancy-light-state">—</strong></div>
       </div>
       <div class="cv-automation-actions">
        <label class="cv-automation-restore"><input id="control-occupancy-auto-restore" type="checkbox" checked> Turn devices ON again when people count rises above the threshold</label>
        <button class="cv-automation-save" id="control-occupancy-automation-save" type="button"><i data-lucide="save"></i>Save Automation</button>
       </div>
       <p class="cv-automation-message" id="control-occupancy-auto-help">Rule: 3 people or fewer for 30 seconds → OFF. More than 3 people → ON when automatic restore is enabled. Automation starts disabled.</p>
       <p class="cv-automation-message" id="control-occupancy-auto-last-action" aria-live="polite">No automation action has been recorded yet.</p>
      </section>
    </div>
'@

$cvPattern = '(?s)<!-- Computer Vision (?:\(Occupancy\) Card|Service Control Card) -->.*?(?=\s*<!-- Bottom Grid:)'
$cvMatches = [regex]::Matches($html, $cvPattern)
if ($cvMatches.Count -ne 1) {
    throw "Expected one installed Computer Vision card before Bottom Grid, found $($cvMatches.Count). Your current Control Panel HTML was not changed."
}
$html = [regex]::Replace($html, $cvPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $cvBlock }, 1)

# Add scoped CSS links exactly once.
if ($html -notmatch 'control-panel-cv-control\.css') {
    $html = [regex]::Replace($html, '(?i)</head>', '  <link rel="stylesheet" href="control-panel-cv-control.css?v=20261031-cvcontrol1">' + "`r`n</head>", 1)
}
if ($html -notmatch 'control-panel-occupancy\.css') {
    $html = [regex]::Replace($html, '(?i)</head>', '  <link rel="stylesheet" href="control-panel-occupancy.css?v=20261031-occupancy2">' + "`r`n</head>", 1)
}
$html = [regex]::Replace($html, 'control-panel-live\.js(?:\?v=[^"'']*)?', 'control-panel-live.js?v=20261031-cvrelay1')

# Install occupancy card CSS from its earlier UI package if absent; keep existing file otherwise.
$occupancyCssSource = Join-Path $packageRoot 'public\control-panel-occupancy.css'
if (-not (Test-Path -LiteralPath $occupancyCssPath)) {
    if (-not (Test-Path -LiteralPath $occupancyCssSource)) { throw 'Occupancy card stylesheet is missing from this patch package.' }
    Copy-Item -LiteralPath $occupancyCssSource -Destination $occupancyCssPath
}
$cvCssSource = Join-Path $packageRoot 'public\control-panel-cv-control.css'
if (-not (Test-Path -LiteralPath $cvCssSource)) { throw 'CV Control Panel stylesheet is missing from this patch package.' }
$cvCss = [System.IO.File]::ReadAllText($cvCssSource)

# Add state for process status polling.
if ($js -notmatch 'cvManagerBusy:') {
    if ($js -notmatch 'apiKeyPrompted:\s*false,') { throw 'Could not find Control Panel state insertion point.' }
    $js = [regex]::Replace($js, 'apiKeyPrompted:\s*false,', "apiKeyPrompted: false,`r`n    cvManagerBusy: false,`r`n    cvManagerPollTimer: null,", 1)
}

$cvJsFunctions = @'
  function renderComputerVisionControl(data) {
    const cameraRunning = Boolean(data?.camera?.running);
    const bridgeRunning = Boolean(data?.bridge?.running);
    const running = Boolean(data?.running || (cameraRunning && bridgeRunning));
    const partial = Boolean(data?.partiallyRunning || (cameraRunning !== bridgeRunning));
    const badge = $('#control-cv-manager-state');
    if (badge) {
      badge.textContent = running ? 'RUNNING' : partial ? 'PARTIAL' : 'STOPPED';
      badge.classList.toggle('is-running', running);
      badge.classList.toggle('is-partial', partial);
      badge.classList.toggle('is-stopped', !running && !partial);
      badge.classList.remove('is-checking');
    }
    setText('control-cv-camera-state', cameraRunning ? 'Online' : 'Offline');
    setText('control-cv-bridge-state', bridgeRunning ? 'Running' : 'Stopped');
    const cameraCount = data?.camera?.currentPeople;
    setText('control-cv-live-count', cameraCount === null || cameraCount === undefined || !Number.isFinite(Number(cameraCount))
      ? 'No live frame' : `${Math.round(Number(cameraCount))} people`);
    const inference = data?.camera?.inferenceMs;
    setText('control-cv-inference', inference === null || inference === undefined ? '—' : `${Number(inference).toFixed(0)} ms`);

    const startButton = $('#control-cv-start');
    const stopButton = $('#control-cv-stop');
    const preview = $('#control-cv-preview');
    if (startButton) startButton.disabled = state.cvManagerBusy || running || data?.configured === false;
    if (stopButton) stopButton.disabled = state.cvManagerBusy || (!cameraRunning && !bridgeRunning);
    if (preview) {
      preview.href = data?.previewUrl || 'http://127.0.0.1:5000/';
      preview.classList.toggle('is-disabled', !cameraRunning);
      preview.setAttribute('aria-disabled', cameraRunning ? 'false' : 'true');
    }
    setText('control-cv-checked', `Checked ${new Date().toLocaleTimeString()}`);
  }

  async function loadComputerVisionControl(silent = true) {
    if (!$('#control-cv-manager')) return;
    try {
      const response = await get('/computer-vision/status');
      renderComputerVisionControl(response?.data || {});
    } catch (error) {
      const badge = $('#control-cv-manager-state');
      if (badge) {
        badge.textContent = 'UNAVAILABLE';
        badge.classList.remove('is-running', 'is-partial', 'is-checking');
        badge.classList.add('is-stopped');
      }
      setText('control-cv-camera-state', 'Unknown');
      setText('control-cv-bridge-state', 'Unknown');
      if (!silent) toast(`Computer Vision status: ${error.message}`, 'error');
    }
  }

  async function controlComputerVision(action) {
    if (state.cvManagerBusy) return;
    state.cvManagerBusy = true;
    const startButton = $('#control-cv-start');
    const stopButton = $('#control-cv-stop');
    if (startButton) startButton.disabled = true;
    if (stopButton) stopButton.disabled = true;
    const badge = $('#control-cv-manager-state');
    if (badge) badge.textContent = action === 'start' ? 'STARTING…' : 'STOPPING…';
    try {
      const response = await post(`/computer-vision/${action}`, {});
      if (response?.data) renderComputerVisionControl(response.data);
      toast(response?.message || `Computer Vision ${action} request completed.`, 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      state.cvManagerBusy = false;
      await loadComputerVisionControl(true);
    }
  }

  function bindComputerVisionControl() {
    if (!$('#control-cv-manager')) return;
    $('#control-cv-start')?.addEventListener('click', () => void controlComputerVision('start'));
    $('#control-cv-stop')?.addEventListener('click', () => void controlComputerVision('stop'));
    void loadComputerVisionControl(false);
    if (state.cvManagerPollTimer) window.clearInterval(state.cvManagerPollTimer);
    state.cvManagerPollTimer = window.setInterval(() => void loadComputerVisionControl(true), 10000);
  }

'@
if ($js -notmatch 'function renderComputerVisionControl\(') {
    $jsPattern = '(?m)^  function parseJson\('
    if ($js -notmatch $jsPattern) { throw 'Could not find the Control Panel JavaScript insertion point before parseJson().' }
    $js = [regex]::Replace($js, $jsPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $cvJsFunctions + $m.Value }, 1)
}

# Keep the manual Temperature & Fan Control selector aligned with the server-saved
# fan output selected for occupancy automation.
if ($js -notmatch 'cvAutomationFanRelaySync') {
    $fanSync = @'
    // cvAutomationFanRelaySync: one selected fan actuator drives both views.
    const configuredFan = field(settings, 'fanDeviceCode');
    if (configuredFan && actuators.some((item) => String(field(item, 'deviceCode')) === String(configuredFan))) {
      state.selectedRelay = String(configuredFan);
      const manualRelaySelect = $('#control-relay-select');
      if (manualRelaySelect) manualRelaySelect.value = state.selectedRelay;
    }
    const fanOutputDevice = actuators.find((item) => String(field(item, 'deviceCode')) === String(configuredFan));
    const lightOutputCode = field(settings, 'lightDeviceCode');
    const lightOutputDevice = actuators.find((item) => String(field(item, 'deviceCode')) === String(lightOutputCode));
    const fanServerState = configuredFan && fanOutputDevice ? stateForDevice(fanOutputDevice) : 'not configured';
    const lightServerState = lightOutputCode && lightOutputDevice ? stateForDevice(lightOutputDevice) : 'not configured';
    setText('control-occupancy-fan-state', fanServerState === 'on' || fanServerState === 'off' ? fanServerState.toUpperCase() : fanServerState === 'not configured' ? 'NOT CONFIGURED' : 'AWAITING CONFIRMATION');
    setText('control-occupancy-light-state', lightServerState === 'on' || lightServerState === 'off' ? lightServerState.toUpperCase() : lightServerState === 'not configured' ? 'NOT CONFIGURED' : 'AWAITING CONFIRMATION');
'@
    $fanSyncPattern = "(?s)(fillSelect\(lightSelect,[\s\S]*?\);\s*)(const enabled = Boolean\(field\(settings, 'isEnabled'\)\);)"
    if ($js -notmatch $fanSyncPattern) { throw 'Could not locate the saved Fan output selector in renderOccupancyAutomation().' }
    $js = [regex]::Replace($js, $fanSyncPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $m.Groups[1].Value + $fanSync + $m.Groups[2].Value }, 1)
}
if ($js -notmatch 'bindComputerVisionControl\(\);') {
    $initPattern = '(?m)^\s*connectLiveStream\(\);'
    if ($js -notmatch $initPattern) { throw 'Could not find connectLiveStream() in Control Panel init().' }
    $js = [regex]::Replace($js, $initPattern, '$0' + "`r`n      bindComputerVisionControl();", 1)
}
if ($js -notmatch "'occupancy\.automation'") {
    $js = [regex]::Replace($js, "'telemetry', 'device\.status', 'device\.state', 'command', 'alert',", "'telemetry', 'device.status', 'device.state', 'command', 'alert', 'occupancy.automation',", 1)
}

# Ensure the server-side automation checks the latest confirmed state in Device_States
# before sending another identical command.
if ($service -notmatch 'confirmedStateResult') {
    $stateCheck = @'
  const confirmedStateResult = await pool.request()
    .input('deviceId', sql.Int, device.deviceId)
    .query(`
      SELECT TOP (1) LOWER(StateValue) AS stateValue
      FROM dbo.Device_States
      WHERE DeviceId=@deviceId
        AND LOWER(StateCode) IN (N'relay_state', N'power_state', N'state')
      ORDER BY RecordedAt DESC, StateId DESC;
    `);
  const confirmedState = String(confirmedStateResult.recordset[0]?.stateValue || '').toLowerCase();
  if (confirmedState === desiredState) {
    return { deviceCode: device.deviceCode, status: 'already_set', message: `SQL Server confirms the relay is already ${desiredState}.` };
  }

'@
    $inProgressPattern = '(?s)(if \(previousStatus === ''pending'' \|\| previousStatus === ''sent''\) \{\s*return \{ deviceCode: device\.deviceCode, status: ''in_progress'', message: ''A previous command is still in progress\.'' \};\s*\}\s*)'
    if ($service -notmatch $inProgressPattern) { throw 'Could not safely find the in-progress command guard in occupancyAutomationService.js.' }
    $service = [regex]::Replace($service, $inProgressPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $m.Value + $stateCheck }, 1)
}

# The command ACK handler must save confirmed relay states, which the UI reads via /states.
if ($responseService -notmatch 'relay_state' -or $responseService -notmatch 'dbo\.Device_States') {
    $responseSource = Join-Path $packageRoot 'src\services\commandResponseService.js'
    if (-not (Test-Path -LiteralPath $responseSource)) { throw 'Current commandResponseService does not persist relay state and no compatible replacement was bundled.' }
    $responseService = [System.IO.File]::ReadAllText($responseSource)
}

# Save timestamped backups before writing the changed project files.
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($path in @($htmlPath, $jsPath, $appPath, $automationServicePath)) {
    Copy-Item -LiteralPath $path -Destination "$path.bak-cvrelay-$stamp"
}
if ((Test-Path -LiteralPath $responseServicePath) -and $responseService -ne [System.IO.File]::ReadAllText($responseServicePath)) {
    Copy-Item -LiteralPath $responseServicePath -Destination "$responseServicePath.bak-cvrelay-$stamp"
}

[System.IO.File]::WriteAllText($htmlPath, $html, $utf8)
[System.IO.File]::WriteAllText($jsPath, $js, $utf8)
[System.IO.File]::WriteAllText($appPath, $app, $utf8)
[System.IO.File]::WriteAllText($automationServicePath, $service, $utf8)
[System.IO.File]::WriteAllText($responseServicePath, $responseService, $utf8)
[System.IO.File]::WriteAllText($cvControlCssPath, $cvCss, $utf8)

Write-Host 'CampusX Control Panel CV and Relay integration installed.' -ForegroundColor Green
Write-Host 'The new CV Service card is beside Temperature & Fan Control (half-width); Occupancy + Automation is full-width below.' -ForegroundColor Cyan
Write-Host 'Start/Stop reuse the same Computer Vision manager/endpoints as Home Dashboard.' -ForegroundColor Cyan
Write-Host 'Relay state is displayed from SQL Server Device_States after a successful device ACK.' -ForegroundColor Cyan
Write-Host 'Timestamped backups were created. Review selected actuators and keep automation disabled until verified.' -ForegroundColor Yellow
