$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$publicDir = Join-Path $projectRoot 'public'
$htmlPath = Join-Path $publicDir 'control-panel.html'
$jsPath = Join-Path $publicDir 'control-panel-live.js'
$cssPath = Join-Path $publicDir 'control-panel-occupancy.css'

foreach ($path in @($htmlPath, $jsPath, $cssPath)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Required file not found: $path" }
}

$html = [System.IO.File]::ReadAllText($htmlPath)
$js = [System.IO.File]::ReadAllText($jsPath)

$cvBlock = @'
<!-- Computer Vision (Occupancy) Card -->
     <div class="ctrl-card cv-occupancy-card" id="control-cv-card">
      <div class="card-header-bar cv-card-header">
       <div class="header-title-group">
        <i class="blue-text" data-lucide="scan-eye"></i>
        <div>
         <h3>Computer Vision · Room Occupancy</h3>
         <p>Live people count from the room camera</p>
        </div>
       </div>
       <span class="pill-badge-blue cv-live-badge" id="control-cv-state">● CHECKING CAMERA</span>
      </div>
      <div class="cv-occupancy-layout">
       <section class="cv-count-panel" aria-label="Current people count">
        <div class="cv-count-label"><i data-lucide="users"></i><span>PEOPLE DETECTED NOW</span></div>
        <div class="headcount-num" id="control-current-count">—</div>
        <div class="cv-count-caption">People visible in the latest camera reading</div>
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
     </div>
    </div>
'@

$cvPattern = '(?s)<!-- Computer Vision \(Occupancy\) Card -->.*?(?=\s*<!-- Bottom Grid:)'
$cvMatches = [regex]::Matches($html, $cvPattern)
if ($cvMatches.Count -ne 1) { throw "Expected exactly one Computer Vision card block, found $($cvMatches.Count). No files changed." }

$jsFunc = @'
  function renderOccupancy() {
    const people = numericMetric('people_count');
    const room = selectedRoom();
    const capacityValue = Number(field(room, 'capacity'));
    const capacity = Number.isFinite(capacityValue) && capacityValue > 0 ? capacityValue : null;
    const count = people.value === null ? null : Math.max(0, Math.round(people.value));
    const roomCode = field(room, 'roomCode') || 'ROOM';
    const roomName = field(room, 'roomName', 'name') || 'Room not selected';
    const deviceLabel = field(people.row, 'deviceName', 'deviceCode') || 'Computer Vision device';
    const recordedAt = field(people.row, 'recordedAt', 'RecordedAt', 'receivedAt', 'ReceivedAt');
    const lastSeen = recordedAt ? ageLabel(recordedAt) : 'No reading yet';

    setText('control-current-count', count === null ? '—' : String(count));
    setText('control-cv-room-code', roomCode);
    setText('control-cv-room-name', roomName);
    setText('control-cv-device-label', deviceLabel);
    setText('control-cv-last-seen', lastSeen);
    setText('control-capacity-label', capacity ? `${capacity} people` : 'Not configured');

    const rawPercent = count !== null && capacity ? (count / capacity) * 100 : null;
    const barPercent = rawPercent === null ? 0 : Math.max(0, Math.min(100, rawPercent));
    setText('control-capacity-percent', rawPercent === null ? '—' : `${Math.round(rawPercent)}%`);
    setText('control-cv-capacity-summary', capacity ? `${count === null ? '—' : count} of ${capacity} people` : 'Set a room capacity to calculate occupancy');
    const fill = $('#control-capacity-fill');
    if (fill) fill.style.width = `${barPercent}%`;

    let remainingText = '—';
    if (capacity && count !== null) {
      const remaining = capacity - count;
      remainingText = remaining >= 0 ? `${remaining} spaces` : `${Math.abs(remaining)} over`;
    }
    setText('control-cv-remaining', remainingText);

    setText('control-cv-state', people.row
      ? (people.fresh ? '● CAMERA LIVE' : '● DATA STALE')
      : '● WAITING FOR CAMERA DATA');
    setText('control-occupancy-footer', count === null
      ? 'No people_count reading has been received for this room yet.'
      : 'This is the latest detected headcount, not the total number of daily entries.');
  }
'@
$jsPattern = '(?s)  function renderOccupancy\(\)\s*\{.*?(?=\r?\n  function parseJson\()'
$jsMatches = [regex]::Matches($js, $jsPattern)
if ($jsMatches.Count -ne 1) { throw "Expected exactly one renderOccupancy function, found $($jsMatches.Count). No files changed." }

$link = '<link rel="stylesheet" href="control-panel-occupancy.css?v=20261031-cv2">'
if ($html -notmatch 'control-panel-occupancy\.css') {
    if ($html -notmatch '(?i)</head>') { throw 'Could not find </head> in control-panel.html' }
    $html = [regex]::Replace($html, '(?i)</head>', "  $link`r`n</head>", 1)
}
$html = [regex]::Replace($html, $cvPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $cvBlock }, 1)
$js = [regex]::Replace($js, $jsPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $jsFunc }, 1)

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $htmlPath -Destination "$htmlPath.bak-cv-$stamp"
Copy-Item -LiteralPath $jsPath -Destination "$jsPath.bak-cv-$stamp"
[System.IO.File]::WriteAllText($htmlPath, $html, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($jsPath, $js, [System.Text.UTF8Encoding]::new($false))
Write-Host 'Computer Vision occupancy card updated.' -ForegroundColor Green
Write-Host 'Backups created beside control-panel.html and control-panel-live.js.' -ForegroundColor Cyan
Write-Host 'No SQL, API, MQTT, relay, authentication, or dashboard-wide styles were changed.' -ForegroundColor DarkGray
