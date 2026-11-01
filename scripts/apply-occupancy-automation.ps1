$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$publicDir = Join-Path $projectRoot 'public'
$srcDir = Join-Path $projectRoot 'src'
$htmlPath = Join-Path $publicDir 'control-panel.html'
$jsPath = Join-Path $publicDir 'control-panel-live.js'
$apiPath = Join-Path $srcDir 'routes\api.js'
$mqttPath = Join-Path $srcDir 'services\mqttService.js'
$cssPath = Join-Path $publicDir 'control-panel-automation.css'
$routeSource = Join-Path $PSScriptRoot '..\src\routes\occupancyAutomation.js'
$serviceSource = Join-Path $PSScriptRoot '..\src\services\occupancyAutomationService.js'

foreach ($path in @($htmlPath, $jsPath, $apiPath, $mqttPath, $cssPath, $routeSource, $serviceSource)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Required file not found: $path" }
}

$utf8 = [System.Text.UTF8Encoding]::new($false)
$html = [System.IO.File]::ReadAllText($htmlPath)
$js = [System.IO.File]::ReadAllText($jsPath)
$api = [System.IO.File]::ReadAllText($apiPath)
$mqtt = [System.IO.File]::ReadAllText($mqttPath)

# Replace only the Computer Vision card; other Control Panel sections remain untouched.
$cvBlock = @'
<!-- Computer Vision (Occupancy) Card -->
     <div class="ctrl-card cv-occupancy-card" id="control-cv-card">
      <div class="card-header-bar cv-card-header">
       <div class="header-title-group">
        <i class="blue-text" data-lucide="scan-eye"></i>
        <div>
         <h3>Computer Vision · Room Occupancy</h3>
         <p>Live people count and occupancy-based device automation</p>
        </div>
       </div>
       <span class="pill-badge-blue cv-live-badge" id="control-cv-state">● CHECKING CAMERA</span>
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
          <p class="cv-automation-subtitle">Automatically control the selected fan and light outputs based on the live people count.</p>
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
       <div class="cv-automation-actions">
        <label class="cv-automation-restore"><input id="control-occupancy-auto-restore" type="checkbox" checked> Turn devices ON again when people count rises above the threshold</label>
        <button class="cv-automation-save" id="control-occupancy-automation-save" type="button"><i data-lucide="save"></i>Save Automation</button>
       </div>
       <p class="cv-automation-message" id="control-occupancy-auto-help">Rule: 3 people or fewer for 30 seconds → OFF. More than 3 people → ON when automatic restore is enabled. Automation starts disabled.</p>
       <p class="cv-automation-message" id="control-occupancy-auto-last-action" aria-live="polite">No automation action has been recorded yet.</p>
      </section>
     </div>
    </div>
'@

$cvPattern = '(?s)<!-- Computer Vision \(Occupancy\) Card -->.*?(?=\s*<!-- Bottom Grid:)'
$cvMatches = [regex]::Matches($html, $cvPattern)
if ($cvMatches.Count -ne 1) { throw "Expected exactly one Computer Vision card block, found $($cvMatches.Count). No files changed." }
$html = [regex]::Replace($html, $cvPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $cvBlock }, 1)

# Attach the scoped stylesheet once and invalidate the browser's cached live script.
if ($html -notmatch 'control-panel-automation\.css') {
    if ($html -notmatch '(?i)</head>') { throw 'Could not find </head> in control-panel.html' }
    $html = [regex]::Replace($html, '(?i)</head>', '  <link rel="stylesheet" href="control-panel-automation.css?v=20261031-auto1">' + "`r`n</head>", 1)
}
$html = [regex]::Replace($html, 'control-panel-live\.js(?:\?v=[^"'']*)?', 'control-panel-live.js?v=20261031-occupancy-automation1')

# Extend the current Control Panel data model and load per-room automation settings.
if ($js -notmatch 'occupancyAutomation:') {
    if ($js -notmatch "selectedRelay:\s*'',") { throw 'Could not locate selectedRelay in Control Panel state.' }
    $js = [regex]::Replace($js, "selectedRelay:\s*'',", "selectedRelay: '',`r`n    occupancyAutomation: null,", 1)
}
if (-not $js.Contains('get(`/occupancy-automation${roomQ}`)')) {
    $needle = 'get(`/alert-rules${roomQ}`),'
    $replacement = $needle + [Environment]::NewLine + '      get(`/occupancy-automation${roomQ}`),' 
    if (-not $js.Contains($needle)) { throw 'Could not locate alert-rules request in loadAllData().' }
    $js = $js.Replace($needle, $replacement)
}
if ($js -notmatch 'state\.occupancyAutomation\s*=') {
    $js = [regex]::Replace($js, 'state\.rules\s*=\s*rows\(value\(8\)\);', "state.rules = rows(value(8));`r`n    state.occupancyAutomation = unwrap(value(9)) || state.occupancyAutomation;", 1)
}

$jsFunctions = @'
  function renderOccupancy() {
    const people = numericMetric('people_count');
    const room = selectedRoom();
    const capacityValue = Number(field(room, 'capacity'));
    const capacity = Number.isFinite(capacityValue) && capacityValue > 0 ? capacityValue : null;
    const count = people.value === null ? null : Math.max(0, Math.round(people.value));
    const recordedAt = field(people.row, 'recordedAt', 'RecordedAt', 'receivedAt', 'ReceivedAt');

    setText('control-current-count', count === null ? '—' : String(count));
    setText('control-cv-room-code', field(room, 'roomCode') || 'ROOM');
    setText('control-cv-room-name', field(room, 'roomName', 'name') || 'Room not selected');
    setText('control-cv-device-label', field(people.row, 'deviceName', 'deviceCode') || 'Computer Vision device');
    setText('control-cv-last-seen', recordedAt ? ageLabel(recordedAt) : 'No reading yet');
    setText('control-capacity-label', capacity ? `${capacity} people` : 'Not configured');

    const rawPercent = count !== null && capacity ? (count / capacity) * 100 : null;
    const percent = rawPercent === null ? 0 : Math.max(0, Math.min(100, rawPercent));
    setText('control-capacity-percent', rawPercent === null ? '—' : `${Math.round(rawPercent)}%`);
    setText('control-cv-capacity-summary', capacity ? `${count === null ? '—' : count} of ${capacity} people` : 'Set a room capacity to calculate occupancy');
    const fill = $('#control-capacity-fill');
    if (fill) fill.style.width = `${percent}%`;

    let remaining = '—';
    if (capacity && count !== null) {
      const available = capacity - count;
      remaining = available >= 0 ? `${available} spaces` : `${Math.abs(available)} over`;
    }
    setText('control-cv-remaining', remaining);
    setText('control-cv-state', people.row
      ? (people.fresh ? '● CAMERA LIVE' : '● DATA STALE')
      : '● WAITING FOR CAMERA DATA');
    setText('control-occupancy-footer', count === null
      ? 'No people_count reading has been received for this room yet.'
      : `Latest detected headcount: ${count}. This is not the total number of daily entries.`);
  }

  function renderOccupancyAutomation() {
    const model = state.occupancyAutomation || {};
    const settings = model.settings || {};
    const actuators = Array.isArray(model.actuators) ? model.actuators : [];
    const panel = $('#control-occupancy-automation');
    if (!panel) return;
    const editing = panel.contains(document.activeElement);

    const fanSelect = $('#control-occupancy-fan-device');
    const lightSelect = $('#control-occupancy-light-device');
    const fillSelect = (select, placeholder, selected, matcher) => {
      if (!select || (editing && select === document.activeElement)) return;
      const current = select.value;
      const preferred = current || selected || actuators.find((item) => matcher(`${field(item, 'deviceCode')} ${field(item, 'deviceName')}`))?.deviceCode || '';
      select.innerHTML = `<option value="">${esc(placeholder)}</option>` + actuators.map((item) => {
        const code = field(item, 'deviceCode');
        const name = field(item, 'deviceName') || code;
        return `<option value="${esc(code)}">${esc(name)} · ${esc(code)}</option>`;
      }).join('');
      select.value = actuators.some((item) => String(field(item, 'deviceCode')) === String(preferred)) ? preferred : '';
    };

    if (!editing) {
      const enabled = Boolean(field(settings, 'isEnabled'));
      const threshold = Number(field(settings, 'personThreshold'));
      const delay = Number(field(settings, 'offDelaySeconds'));
      const restore = field(settings, 'restoreOnAboveThreshold') !== false;
      const enabledInput = $('#control-occupancy-auto-enabled');
      const thresholdInput = $('#control-occupancy-off-threshold');
      const delayInput = $('#control-occupancy-off-delay');
      const restoreInput = $('#control-occupancy-auto-restore');
      if (enabledInput) enabledInput.checked = enabled;
      if (thresholdInput) thresholdInput.value = Number.isInteger(threshold) ? String(threshold) : '3';
      if (delayInput) delayInput.value = Number.isInteger(delay) ? String(delay) : '30';
      if (restoreInput) restoreInput.checked = restore;
    }

    fillSelect(fanSelect, actuators.length ? 'Select fan relay' : 'No actuator registered', field(settings, 'fanDeviceCode'), (value) => /fan/i.test(value));
    fillSelect(lightSelect, actuators.some((item) => /light|lamp/i.test(`${field(item, 'deviceCode')} ${field(item, 'deviceName')}`))
      ? 'Select light relay' : 'No light relay registered', field(settings, 'lightDeviceCode'), (value) => /light|lamp/i.test(value));

    const enabled = Boolean(field(settings, 'isEnabled'));
    const threshold = Number(field(settings, 'personThreshold', 'PersonThreshold') ?? 3);
    const delay = Number(field(settings, 'offDelaySeconds', 'OffDelaySeconds') ?? 30);
    const restore = field(settings, 'restoreOnAboveThreshold', 'RestoreOnAboveThreshold') !== false;
    const badge = $('#control-occupancy-auto-state');
    if (badge) {
      badge.textContent = enabled ? 'AUTOMATION ON' : 'DISABLED';
      badge.classList.toggle('is-on', enabled);
    }
    const message = `Rule: ${threshold} people or fewer for ${delay} seconds → OFF. Above ${threshold} → ${restore ? 'ON' : 'no automatic restore'}.`;
    setText('control-occupancy-auto-help', message);
    const lastAction = field(settings, 'lastActionMessage', 'LastActionMessage')
      || (enabled ? 'Automation is enabled and waiting for fresh camera readings.' : 'Automation is disabled.');
    setText('control-occupancy-auto-last-action', lastAction);
    const noLight = !field(settings, 'lightDeviceCode');
    const help = $('#control-occupancy-auto-help');
    if (help) help.classList.toggle('is-warning', noLight);
    if (noLight && help) help.textContent += ' No Light relay is configured in this room yet; register and select a Light actuator to automate the light.';
  }

  async function saveOccupancyAutomation() {
    const room = selectedRoom();
    if (!room) { toast('Select a room before configuring occupancy automation.', 'error'); return; }
    const threshold = Number($('#control-occupancy-off-threshold')?.value);
    const delay = Number($('#control-occupancy-off-delay')?.value);
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 500) {
      toast('Person threshold must be a whole number between 0 and 500.', 'error'); return;
    }
    if (!Number.isInteger(delay) || delay < 5 || delay > 3600) {
      toast('Confirmation delay must be between 5 and 3600 seconds.', 'error'); return;
    }
    const button = $('#control-occupancy-automation-save');
    if (button) button.disabled = true;
    try {
      const response = await apiRequest('/occupancy-automation', {
        method: 'PUT',
        body: JSON.stringify({
          roomId: Number(field(room, 'roomId', 'id')),
          isEnabled: Boolean($('#control-occupancy-auto-enabled')?.checked),
          personThreshold: threshold,
          offDelaySeconds: delay,
          restoreOnAboveThreshold: Boolean($('#control-occupancy-auto-restore')?.checked),
          fanDeviceCode: $('#control-occupancy-fan-device')?.value || null,
          lightDeviceCode: $('#control-occupancy-light-device')?.value || null,
        }),
      });
      state.occupancyAutomation = unwrap(response);
      renderOccupancyAutomation();
      toast('Occupancy automation settings saved for this room.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }
'@

$jsPattern = '(?s)  function renderOccupancy\(\)\s*\{.*?(?=\r?\n  function parseJson\()'
$jsMatches = [regex]::Matches($js, $jsPattern)
if ($jsMatches.Count -ne 1) { throw "Expected exactly one renderOccupancy function, found $($jsMatches.Count). No files changed." }
$js = [regex]::Replace($js, $jsPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $jsFunctions }, 1)
if ($js -notmatch 'renderOccupancy\(\);\s*renderOccupancyAutomation\(\);') {
    $needle = '    renderOccupancy();'
    if (-not $js.Contains($needle)) { throw 'Could not locate renderOccupancy() call in loadAllData().' }
    $js = $js.Replace($needle, "    renderOccupancy();`r`n    renderOccupancyAutomation();")
}
$automationListener = '$' + "('#control-occupancy-automation-save')?.addEventListener('click', saveOccupancyAutomation);"
if (-not $js.Contains($automationListener)) {
    $capacityListener = '$' + "('#control-set-capacity')?.addEventListener('click', setRoomCapacity);"
    if (-not $js.Contains($capacityListener)) { throw 'Could not locate Set Capacity button listener.' }
    $js = $js.Replace($capacityListener, $capacityListener + [Environment]::NewLine + '    ' + $automationListener)
}
if ($js -notmatch "'occupancy\.automation'") {
    $js = [regex]::Replace($js, "'device.created', 'device.updated', 'room.updated', 'alert-rule.created',", "'device.created', 'device.updated', 'room.updated', 'alert-rule.created', 'occupancy.automation',", 1)
}

# Mount the dedicated endpoints inside the existing protected /api/v1 router.
if ($api -notmatch "router\.use\('/occupancy-automation'") {
    if ($api -notmatch 'const router = express\.Router\(\);') { throw 'Could not locate API router declaration.' }
    $api = [regex]::Replace($api, 'const router = express\.Router\(\);', "const router = express.Router();`r`nrouter.use('/occupancy-automation', require('./occupancyAutomation'));", 1)
}

# Run automation only after a newly received people_count reading has been stored.
if ($mqtt -notmatch 'evaluateOccupancyAutomation') {
    $importLine = "const { processCommandResponse } = require('./commandResponseService');"
    if (-not $mqtt.Contains($importLine)) { throw 'Could not locate commandResponseService import in mqttService.js.' }
    $mqtt = $mqtt.Replace($importLine, $importLine + [Environment]::NewLine + "const { evaluateOccupancyAutomation } = require('./occupancyAutomationService');")

    $needle = '        const result = await processTelemetryMessage(topic, message);'
    if (-not $mqtt.Contains($needle)) { throw 'Could not locate telemetry processing line in mqttService.js.' }
    $automationBlock = @'
        for (const reading of result.readings || []) {
          if (String(reading.metricCode || '').toLowerCase() !== 'people_count') continue;
          const count = Number(reading.ValueNumeric ?? reading.valueNumeric ?? reading.value);
          if (Number.isInteger(count)) {
            try {
              await evaluateOccupancyAutomation({
                deviceCode: reading.deviceCode,
                count,
                receivedAt: reading.ReceivedAt ?? reading.receivedAt ?? reading.RecordedAt ?? reading.recordedAt,
              });
            } catch (automationError) {
              console.error('[Occupancy Automation] Evaluation failed:', automationError.message);
            }
          }
        }
'@
    $mqtt = $mqtt.Replace($needle, $needle + [Environment]::NewLine + $automationBlock.TrimEnd())
}

# Back up only the existing files that are changed by this patch.
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($path in @($htmlPath, $jsPath, $apiPath, $mqttPath)) {
    Copy-Item -LiteralPath $path -Destination "$path.bak-occupancy-$stamp"
}
# The route and service modules are already extracted into these exact destination paths.
# Do not Copy-Item a file onto itself (PowerShell throws an IOException in that case).
$routeTarget = Join-Path $srcDir 'routes\occupancyAutomation.js'
$serviceTarget = Join-Path $srcDir 'services\occupancyAutomationService.js'
$routeSourceFull = [System.IO.Path]::GetFullPath($routeSource)
$routeTargetFull = [System.IO.Path]::GetFullPath($routeTarget)
$serviceSourceFull = [System.IO.Path]::GetFullPath($serviceSource)
$serviceTargetFull = [System.IO.Path]::GetFullPath($serviceTarget)
if (-not [string]::Equals($routeSourceFull, $routeTargetFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    Copy-Item -LiteralPath $routeSource -Destination $routeTarget -Force
}
if (-not [string]::Equals($serviceSourceFull, $serviceTargetFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    Copy-Item -LiteralPath $serviceSource -Destination $serviceTarget -Force
}

[System.IO.File]::WriteAllText($htmlPath, $html, $utf8)
[System.IO.File]::WriteAllText($jsPath, $js, $utf8)
[System.IO.File]::WriteAllText($apiPath, $api, $utf8)
[System.IO.File]::WriteAllText($mqttPath, $mqtt, $utf8)
Write-Host 'CampusX Occupancy Automation installed.' -ForegroundColor Green
Write-Host 'Default rule: OFF at or below 3 people after 30 stable seconds; ON above 3 when restore is enabled.' -ForegroundColor Cyan
Write-Host 'Automation is disabled by default. Select registered Fan/Light actuators and enable it in Control Panel.' -ForegroundColor Yellow
Write-Host 'The script created timestamped backups. No dashboard-wide CSS, login, room data, or Alert_Rules were replaced.' -ForegroundColor DarkGray
