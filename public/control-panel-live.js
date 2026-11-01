(() => {
  'use strict';

  const API = '/api/v1';
  const STALE_AFTER_MS = 90_000;
  const CV_STALE_AFTER_MS = 20_000;
  const COMMAND_ACK_TIMEOUT_MS = 15_000;
  const REFRESH_INTERVAL_MS = 15_000;

  const state = {
    user: null,
    rooms: [],
    roomId: null,
    devices: [],
    nodes: [],
    latest: [],
    alerts: [],
    commands: [],
    commandsTotal: 0,
    commandLoadError: null,
    deviceStates: [],
    rules: [],
    health: null,
    stream: null,
    streamOpen: false,
    refreshTimer: null,
    refreshInFlight: false,
    relayBusy: false,
    selectedRelay: '',
    occupancyAutomation: null,
    lastRefreshAt: null,
    apiKeyPrompted: false,
    cvManagerBusy: false,
    cvManagerPollTimer: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);

  function field(object, ...names) {
    if (!object) return undefined;
    for (const name of names) {
      if (object[name] !== undefined && object[name] !== null) return object[name];
      const actual = Object.keys(object).find((key) => key.toLowerCase() === name.toLowerCase());
      if (actual && object[actual] !== undefined && object[actual] !== null) return object[actual];
    }
    return undefined;
  }

  function rows(response) {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.data)) return response.data;
    return [];
  }

  function unwrap(response) {
    return response?.data ?? response ?? {};
  }

  function readingValue(row) {
    if (!row) return null;
    const raw = field(row, 'value', 'valueNumeric', 'valueText', 'valueJson', 'ValueNumeric', 'ValueText', 'ValueJson');
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { return JSON.parse(trimmed); } catch { /* retain text value */ }
      }
    }
    return raw;
  }

  function dateValue(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function ageLabel(value) {
    const date = dateValue(value);
    if (!date) return 'No reading received';
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  function formatDate(value) {
    const date = dateValue(value);
    return date ? date.toLocaleString() : 'Not available';
  }

  function toast(message, kind = 'info') {
    let host = $('#control-live-toast');
    if (!host) {
      host = document.createElement('div');
      host.id = 'control-live-toast';
      host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:10000;display:grid;gap:8px;max-width:min(440px,calc(100vw - 40px))';
      document.body.appendChild(host);
    }
    const item = document.createElement('div');
    item.textContent = message;
    const background = kind === 'error' ? '#991b1b' : kind === 'success' ? '#166534' : '#1e3a8a';
    item.style.cssText = `padding:12px 16px;border-radius:10px;color:#fff;background:${background};box-shadow:0 8px 24px #0004;font:500 13px Inter,sans-serif`;
    host.appendChild(item);
    window.setTimeout(() => item.remove(), 5000);
  }

  async function apiRequest(path, options = {}, allowKeyPrompt = true) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const apiKey = sessionStorage.getItem('campusx_api_key');
    if (apiKey) headers['X-API-Key'] = apiKey;

    let response;
    try {
      response = await fetch(path.startsWith('/auth/') ? path : `${API}${path}`, {
        ...options,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch (error) {
      throw new Error(`Cannot reach CampusX Backend: ${error.message}`);
    }

    if (response.status === 401 && path !== '/auth/session') {
      const sessionResponse = await fetch('/auth/session', {
        credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
      }).catch(() => null);

      if (!sessionResponse || sessionResponse.status === 401) {
        location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`);
        throw new Error('Your CampusX login session has expired.');
      }

      if (allowKeyPrompt && !apiKey && !state.apiKeyPrompted) {
        state.apiKeyPrompted = true;
        const entered = window.prompt('CampusX API_KEY is enabled. Enter the API key from the server .env file:');
        if (entered?.trim()) {
          sessionStorage.setItem('campusx_api_key', entered.trim());
          return apiRequest(path, options, false);
        }
      }
    }

    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    if (!response.ok) {
      throw new Error(payload?.error?.message || payload?.message || `CampusX API returned HTTP ${response.status}`);
    }
    return payload;
  }

  const get = (path) => apiRequest(path);
  const post = (path, body) => apiRequest(path, { method: 'POST', body: JSON.stringify(body) });
  const patch = (path, body) => apiRequest(path, { method: 'PATCH', body: JSON.stringify(body) });

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  }

  function setStatus(id, label, ok) {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = label;
    element.classList.remove('tag-online', 'tag-connected', 'tag-active');
    element.classList.add(ok ? 'tag-online' : 'tag-connected');
  }

  function selectedRoom() {
    return state.rooms.find((room) => Number(field(room, 'roomId', 'id')) === Number(state.roomId)) || null;
  }

  function roomQuery() {
    return state.roomId ? `?roomId=${encodeURIComponent(state.roomId)}` : '';
  }

  function syncRoomSelectors() {
    ['lab-select-dropdown', 'control-room-dropdown'].forEach((id) => {
      const select = document.getElementById(id);
      if (select && state.roomId) select.value = String(state.roomId);
    });
  }

  function bindRoomSelectors() {
    const selectors = ['lab-select-dropdown', 'control-room-dropdown']
      .map((id) => document.getElementById(id)).filter(Boolean);
    const rememberedId = Number(localStorage.getItem('campusx_control_room_id'));
    const room = state.rooms.find((item) => Number(field(item, 'roomId', 'id')) === rememberedId)
      || state.rooms.find((item) => String(field(item, 'roomCode') || '').toUpperCase() === 'LAB-01')
      || state.rooms[0]
      || null;
    state.roomId = room ? Number(field(room, 'roomId', 'id')) : null;

    for (const select of selectors) {
      select.innerHTML = state.rooms.map((item) => {
        const id = field(item, 'roomId', 'id');
        const code = field(item, 'roomCode') || '';
        const name = field(item, 'roomName', 'name') || code || `Room ${id}`;
        return `<option value="${esc(id)}">${esc(code ? `${code} · ` : '')}${esc(name)}</option>`;
      }).join('') || '<option value="">No rooms registered</option>';

      if (!select.dataset.controlBound) {
        select.addEventListener('change', () => {
          state.roomId = Number(select.value) || null;
          if (state.roomId) localStorage.setItem('campusx_control_room_id', String(state.roomId));
          syncRoomSelectors();
          refreshAll(true);
        });
        select.dataset.controlBound = 'true';
      }
    }
    syncRoomSelectors();
  }

  async function loadSession() {
    const session = await get('/auth/session');
    state.user = session.user || {};
    const username = state.user.username || 'CampusX Operator';
    const name = $('.user-profile .user-info strong');
    const role = $('.user-profile .user-info small');
    const avatar = $('.user-profile .avatar');
    if (name) name.textContent = username;
    if (role) role.textContent = 'Authenticated operator';
    if (avatar) avatar.textContent = username.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  }

  async function loadRooms() {
    state.rooms = rows(await get('/rooms'));
    bindRoomSelectors();
  }

  async function loadAllData() {
    const roomQ = roomQuery();
    const requests = await Promise.allSettled([
      get('/health'),
      get('/sqlserver/health'),
      get(`/devices${roomQ}`),
      get(`/nodes${roomQ}`),
      get(`/telemetry/latest${roomQ}`),
      get(`/alerts?limit=100${state.roomId ? `&roomId=${state.roomId}` : ''}`),
      get('/commands?limit=7'),
      get('/states?limit=200'),
      get(`/alert-rules${roomQ}`),
      get(`/occupancy-automation${roomQ}`),
    ]);

    const value = (index) => requests[index].status === 'fulfilled' ? requests[index].value : null;
    state.health = value(0) || state.health;
    state.sql = unwrap(value(1)) || state.sql;
    state.devices = rows(value(2));
    state.nodes = rows(value(3));
    state.latest = rows(value(4));
    state.alerts = rows(value(5));
    if (requests[6].status === 'fulfilled') {
      state.commands = rows(requests[6].value);
      state.commandsTotal = Number(requests[6].value?.total ?? state.commands.length);
      state.commandLoadError = null;
    } else {
      state.commandLoadError = requests[6].reason?.message || 'Command history API request failed.';
    }
    state.deviceStates = rows(value(7));
    state.rules = rows(value(8));
    state.occupancyAutomation = unwrap(value(9)) || state.occupancyAutomation;
    state.lastRefreshAt = new Date();

    renderHealth();
    renderSensorValues();
    renderOccupancy();
    renderOccupancyAutomation();
    renderRules();
    renderRelay();
    renderCommands();
    renderAlertBadge();

    const failed = requests.map((item, index) => item.status === 'rejected' ? index : -1).filter((index) => index >= 0);
    if (failed.length) {
      const messages = failed.map((index) => requests[index].reason?.message).filter(Boolean);
      console.warn('[CampusX Control Panel] One or more APIs failed:', messages);
      setText('control-rules-updated', `Some data sources are unavailable (${failed.length}). Click Refresh Data to retry.`);
    }
  }

  function renderHealth() {
    const health = state.health || {};
    const backendOnline = health.status === 'ok';
    const databaseOnline = health.database === 'connected';
    const mqttOnline = health.mqtt === 'connected';
    setText('control-health-label', backendOnline && databaseOnline ? '● Backend & Database Online' : '● Backend Attention Required');
    setText('control-mqtt-label', mqttOnline ? 'MQTT: Connected' : 'MQTT: Offline');
    setStatus('control-command-broker', mqttOnline ? '● MQTT BROKER CONNECTED' : '● MQTT BROKER OFFLINE', mqttOnline);
    setText('live-backend-status', backendOnline ? '● Live' : '● Offline');
    setText('live-database-status', databaseOnline ? '● Connected' : '● Disconnected');
    setText('live-mqtt-status', mqttOnline ? '● Online' : '● Offline');
    setText('control-rules-status', state.sql ? '● SQL SERVER DATA' : '● DATABASE UNAVAILABLE');
  }

  function latestMetric(metricCode) {
    const filtered = state.latest.filter((item) => String(field(item, 'metricCode', 'metric') || '').toLowerCase() === metricCode.toLowerCase());
    filtered.sort((a, b) => {
      const left = dateValue(field(a, 'recordedAt', 'RecordedAt', 'receivedAt', 'ReceivedAt'))?.getTime() || 0;
      const right = dateValue(field(b, 'recordedAt', 'RecordedAt', 'receivedAt', 'ReceivedAt'))?.getTime() || 0;
      return right - left;
    });
    return filtered[0] || null;
  }

  function metricIsFresh(row, maxAge = STALE_AFTER_MS) {
    const timestamp = dateValue(field(row, 'recordedAt', 'RecordedAt', 'receivedAt', 'ReceivedAt'));
    return Boolean(timestamp && Date.now() - timestamp.getTime() <= maxAge);
  }

  function numericMetric(metricCode) {
    const row = latestMetric(metricCode);
    const value = readingValue(row);
    const number = value === null ? null : Number(value);
    return { row, value: Number.isFinite(number) ? number : null, fresh: metricIsFresh(row) };
  }

  function renderSensorValues() {
    const temperature = numericMetric('temperature');
    const humidity = numericMetric('humidity');
    const co2 = numericMetric('co2_ppm');

    setText('control-temperature-value', temperature.value === null ? '— °C' : `${temperature.value.toFixed(1)}°C`);
    setText('control-temperature-meta', temperature.row
      ? `${field(temperature.row, 'deviceName', 'deviceCode') || 'Registered sensor'} · ${ageLabel(field(temperature.row, 'recordedAt', 'RecordedAt'))}`
      : 'No temperature reading exists for this room.');
    setText('control-temperature-state', temperature.row
      ? (temperature.fresh ? '● LIVE TELEMETRY' : '● STALE TELEMETRY')
      : '● NO TELEMETRY');
    setText('control-humidity-value', humidity.value === null ? '—' : `${humidity.value.toFixed(1)} %`);
    setText('control-co2-value', co2.value === null ? '—' : `${co2.value.toFixed(0)} ppm`);

    const timestamps = [temperature.row, humidity.row, co2.row, latestMetric('people_count')]
      .map((row) => dateValue(field(row, 'recordedAt', 'RecordedAt', 'receivedAt', 'ReceivedAt')))
      .filter(Boolean)
      .sort((a, b) => b - a);
    setText('control-last-telemetry', timestamps[0] ? ageLabel(timestamps[0]) : 'No data');
  }

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
    setText('control-occupancy-light-state', lightServerState === 'on' || lightServerState === 'off' ? lightServerState.toUpperCase() : lightServerState === 'not configured' ? 'NOT CONFIGURED' : 'AWAITING CONFIRMATION');const enabled = Boolean(field(settings, 'isEnabled'));
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
    setText('control-cv-inference', inference === null || inference === undefined ? 'â€”' : `${Number(inference).toFixed(0)} ms`);

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
    if (badge) badge.textContent = action === 'start' ? 'STARTINGâ€¦' : 'STOPPINGâ€¦';
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
  function parseJson(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return {}; }
  }

  function ruleSeverity(rule) {
    return field(parseJson(field(rule, 'configJson', 'ConfigJson')), 'severity') || 'warning';
  }

  function formatRules(metricCode, unit) {
    const enabled = state.rules.filter((rule) => String(field(rule, 'metricCode') || '').toLowerCase() === metricCode.toLowerCase()
      && field(rule, 'isEnabled', 'IsEnabled') !== false);
    if (!enabled.length) return { value: 'No active rules', meta: 'No enabled rule is configured for this metric.' };
    const sorted = enabled.slice().sort((a, b) => Number(field(a, 'threshold')) - Number(field(b, 'threshold')));
    const value = sorted.map((rule) => `${ruleSeverity(rule).toUpperCase()} ${field(rule, 'operator') || '≥'} ${field(rule, 'threshold')} ${unit}`).join(' · ');
    return { value, meta: `${enabled.length} enabled rule(s) read from SQL Server Alert_Rules.` };
  }

  function renderRules() {
    const temperature = formatRules('temperature', '°C');
    const co2 = formatRules('co2_ppm', 'ppm');
    const tempInput = $('#control-temperature-rules');
    const co2Input = $('#control-co2-rules');
    if (tempInput) tempInput.value = temperature.value;
    if (co2Input) co2Input.value = co2.value;
    setText('control-temperature-rules-meta', temperature.meta);
    setText('control-co2-rules-meta', co2.meta);
    setText('control-rules-note', 'These thresholds are read from CampusX Alert_Rules. They describe alert conditions; they do not directly switch hardware unless a separate automation rule is implemented.');
    setText('control-rules-updated', `Loaded ${state.rules.length} rule(s) · Updated ${state.lastRefreshAt?.toLocaleTimeString() || '—'}`);
  }

  function relayDevices() {
    return state.devices.filter((device) => {
      const type = String(field(device, 'deviceType', 'typeName', 'category') || '').toLowerCase();
      const category = String(field(device, 'category') || '').toLowerCase();
      const code = String(field(device, 'deviceCode', 'deviceName', 'name') || '').toLowerCase();
      return category === 'actuator' || /relay|actuator|fan|switch/.test(type) || /relay|actuator|fan|switch/.test(code);
    });
  }

  function stateForDevice(device) {
    if (!device) return 'unknown';
    const deviceId = Number(field(device, 'deviceId', 'id'));
    const saved = state.deviceStates
      .filter((item) => Number(field(item, 'deviceId')) === deviceId)
      .sort((a, b) => (dateValue(field(b, 'recordedAt'))?.getTime() || 0) - (dateValue(field(a, 'recordedAt'))?.getTime() || 0));

    for (const item of saved) {
      const stateCode = String(field(item, 'stateCode') || '').toLowerCase();
      if (stateCode && stateCode !== 'relay_state' && stateCode !== 'power_state' && stateCode !== 'state') continue;
      const value = String(field(item, 'stateValue') || '').trim().toLowerCase();
      if (value === 'on' || value === 'off') return value;
    }

    const lastCommand = state.commands.find((command) => Number(field(command, 'deviceId')) === deviceId
      && String(field(command, 'commandType') || '').toLowerCase() === 'set_state'
      && String(field(command, 'status') || '').toLowerCase() === 'completed');
    if (lastCommand) {
      const payload = parseJson(field(lastCommand, 'payloadJson'));
      const desired = String(field(payload, 'state') || '').toLowerCase();
      if (desired === 'on' || desired === 'off') return desired;
    }
    return 'unknown';
  }

  function renderRelay() {
    const select = $('#control-relay-select');
    const button = $('#control-relay-toggle');
    if (!select || !button) return;
    const devices = relayDevices();
    const previous = state.selectedRelay || select.value;
    const defaultDevice = devices.find((device) => field(device, 'deviceCode') === 'fan-relay-lab-01') || devices[0] || null;
    state.selectedRelay = devices.some((device) => String(field(device, 'deviceCode')) === previous)
      ? previous : (defaultDevice ? String(field(defaultDevice, 'deviceCode')) : '');

    select.innerHTML = devices.map((device) => {
      const code = field(device, 'deviceCode');
      const name = field(device, 'deviceName', 'name') || code;
      const status = field(device, 'status') || 'unknown';
      return `<option value="${esc(code)}">${esc(name)} · ${esc(status)}</option>`;
    }).join('') || '<option value="">No Relay / actuator registered in this room</option>';
    select.value = state.selectedRelay;

    const selected = devices.find((device) => String(field(device, 'deviceCode')) === state.selectedRelay) || null;
    const relayState = stateForDevice(selected);
    const statusLabel = state.relayBusy ? '● WAITING FOR ACK' : `● ${relayState.toUpperCase()}`;
    setText('control-relay-state', statusLabel);
    setText('control-relay-hint', selected
      ? (state.relayBusy ? 'Command sent. Waiting for a device acknowledgement…' : `Device: ${field(selected, 'deviceCode')} · ${relayState === 'unknown' ? 'No confirmed state yet' : `Confirmed ${relayState.toUpperCase()}`}. Click to ${relayState === 'on' ? 'turn OFF' : 'turn ON'}.`)
      : 'No active Relay/actuator device is registered in this room.');

    button.disabled = !selected || state.relayBusy;
    button.classList.toggle('active', relayState === 'on');
    button.setAttribute('aria-pressed', relayState === 'on' ? 'true' : 'false');
    if (!select.dataset.relayBound) {
      select.addEventListener('change', () => {
        state.selectedRelay = select.value;
        renderRelay();
      });
      select.dataset.relayBound = 'true';
    }
    const topic = selected ? `smart-campus/devices/${encodeURIComponent(field(selected, 'deviceCode'))}/commands` : 'Select a registered actuator';
    setText('control-command-topic', `MQTT command topic: ${topic}`);
  }

  function commandDescription(command) {
    const rawPayload = field(command, 'payloadJson', 'PayloadJson', 'payload', 'Payload');
    let payload = rawPayload;
    if (typeof rawPayload === 'string') {
      try { payload = JSON.parse(rawPayload); } catch { payload = {}; }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};

    const commandType = String(field(command, 'commandType', 'CommandType') || '').trim().toLowerCase();
    const stateValue = String(payload.state ?? payload.value ?? '').trim().toLowerCase();
    const deviceLabel = `${field(command, 'deviceName') || ''} ${field(command, 'deviceCode') || ''}`.toLowerCase();
    const isFan = /fan|ventilat|blower/.test(deviceLabel);

    if (commandType === 'set_state' && stateValue === 'off') return isFan ? 'Fan turned off' : 'Device turned off';
    if (commandType === 'set_state' && stateValue === 'on') return isFan ? 'Fan turned on' : 'Device turned on';
    if (commandType === 'set_state' && stateValue) return `Device state set to ${stateValue.toUpperCase()}`;

    const readable = commandType.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return readable ? readable.charAt(0).toUpperCase() + readable.slice(1) : 'No description available';
  }

  function renderCommands() {
    const container = $('#control-command-list');
    if (!container) return;

    const commands = state.commands.slice().sort((a, b) => {
      const left = dateValue(field(a, 'createdAt'))?.getTime() || 0;
      const right = dateValue(field(b, 'createdAt'))?.getTime() || 0;
      return right - left;
    }).slice(0, 7);

    if (state.commandLoadError) {
      container.innerHTML = `<tr><td colspan="6" class="command-audit-empty">Unable to load command history: ${esc(state.commandLoadError)}</td></tr>`;
      setText('control-command-count', 'Command history unavailable');
      setText('control-command-latest-title', 'Unable to load command history');
      setText('control-command-latest-detail', state.commandLoadError);
      setText('control-command-latest-status', 'ERROR');
      return;
    }

    const rowsHtml = commands.map((command) => {
      const id = field(command, 'commandId') ?? '—';
      const sender = field(command, 'requestedBy', 'RequestedBy') || 'Legacy command (sender not recorded)';
      const deviceCode = field(command, 'deviceCode') || `Device ${field(command, 'deviceId') ?? ''}`;
      const deviceName = field(command, 'deviceName') || deviceCode;
      const roomCode = field(command, 'roomCode') || '';
      const roomName = field(command, 'roomName') || '';
      const destinationMeta = [deviceCode, roomCode, roomName].filter(Boolean).join(' · ');
      const commandType = field(command, 'commandType') || 'Command';
      const description = commandDescription(command);
      const status = String(field(command, 'status') || 'unknown').toLowerCase();
      const safeStatus = /^[a-z_]+$/.test(status) ? status : 'unknown';
      const createdAt = field(command, 'createdAt');
      const completedAt = field(command, 'completedAt');
      const resultDetail = completedAt
        ? `Finished ${formatDate(completedAt)}`
        : (['sent', 'pending'].includes(status) ? 'Awaiting device acknowledgement' : 'No completion time recorded');

      return `<tr data-command-id="${esc(id)}">
        <td data-label="Who sent it"><strong>${esc(sender)}</strong><small>Operator · #${esc(id)}</small></td>
        <td data-label="Sent to"><strong>${esc(deviceName)}</strong><small>${esc(destinationMeta || `Device ID ${field(command, 'deviceId') ?? '—'}`)}</small></td>
        <td data-label="Command"><strong>${esc(commandType)}</strong></td>
        <td data-label="Description"><strong>${esc(description)}</strong></td>
        <td data-label="Sent at"><span>${esc(formatDate(createdAt))}</span></td>
        <td data-label="Result"><span class="command-audit-status status-${esc(safeStatus)}">${esc(status.toUpperCase())}</span><small>${esc(resultDetail)}</small></td>
      </tr>`;
    }).join('');

    container.innerHTML = rowsHtml || '<tr><td colspan="6" class="command-audit-empty">No commands have been sent yet.</td></tr>';
    setText('control-command-count', `Showing ${commands.length} latest of ${state.commandsTotal} command(s)`);

    const latest = commands[0];
    setText('control-command-latest-title', latest
      ? `Command #${field(latest, 'commandId')} · ${String(field(latest, 'status') || 'unknown').toUpperCase()}`
      : 'No commands recorded yet.');
    setText('control-command-latest-detail', latest
      ? `By ${field(latest, 'requestedBy') || 'Legacy sender not recorded'} · To ${field(latest, 'deviceCode') || 'Device'} · ${field(latest, 'commandType') || 'Command'} · ${formatDate(field(latest, 'createdAt'))}`
      : 'Command history is empty.');
    setText('control-command-latest-status', latest ? String(field(latest, 'status') || 'unknown').toUpperCase() : '—');
  }

  function renderAlertBadge() {
    const count = state.alerts.filter((alert) => ['open', 'acknowledged'].includes(String(field(alert, 'status') || '').toLowerCase())).length;
    const badge = $('.sidebar-nav .nav-item[href="alerts.html"] .badge');
    if (badge) badge.textContent = String(count);
  }

  async function refreshAll(showMessage = false) {
    if (state.refreshInFlight) return;
    state.refreshInFlight = true;
    try {
      if (!state.rooms.length) await loadRooms();
      await loadAllData();
      if (showMessage) toast('Control Panel refreshed from CampusX SQL Server.', 'success');
    } catch (error) {
      console.error('[CampusX Control Panel]', error);
      toast(error.message, 'error');
    } finally {
      state.refreshInFlight = false;
    }
  }

  function scheduleRefresh() {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => refreshAll(false), 350);
  }

  function connectLiveStream() {
    const apiKey = sessionStorage.getItem('campusx_api_key');
    const url = `${API}/stream${apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : ''}`;
    state.stream?.close();
    state.stream = new EventSource(url, { withCredentials: true });
    state.stream.addEventListener('open', () => { state.streamOpen = true; });
    state.stream.addEventListener('error', () => { state.streamOpen = false; });
    [
      'telemetry', 'device.status', 'device.state', 'command', 'alert',
      'device.created', 'device.updated', 'room.updated', 'alert-rule.created', 'occupancy.automation',
    ].forEach((eventName) => state.stream.addEventListener(eventName, scheduleRefresh));
  }

  async function waitForCommand(commandId, deviceCode, desiredState) {
    const deadline = Date.now() + COMMAND_ACK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      const [commandsResult, statesResult] = await Promise.allSettled([
        get('/commands?limit=7'),
        get('/states?limit=200'),
      ]);
      if (commandsResult.status === 'fulfilled') { state.commands = rows(commandsResult.value); state.commandsTotal = Number(commandsResult.value?.total ?? state.commands.length); }
      if (statesResult.status === 'fulfilled') state.deviceStates = rows(statesResult.value);
      const command = state.commands.find((item) => String(field(item, 'commandId')) === String(commandId));
      const status = String(field(command, 'status') || '').toLowerCase();
      if (status === 'failed') throw new Error(`Device ${deviceCode} rejected the ${desiredState.toUpperCase()} command.`);
      if (status === 'completed') {
        renderCommands();
        renderRelay();
        return true;
      }
    }
    return false;
  }

  async function toggleRelay() {
    if (state.relayBusy) return;
    const deviceCode = $('#control-relay-select')?.value;
    const device = relayDevices().find((item) => String(field(item, 'deviceCode')) === String(deviceCode));
    if (!device) {
      toast('There is no registered Relay / actuator in the selected room.', 'error');
      return;
    }

    const current = stateForDevice(device);
    const desiredState = current === 'on' ? 'off' : 'on';
    state.relayBusy = true;
    renderRelay();

    try {
      const response = await post('/commands', {
        deviceCode,
        commandType: 'set_state',
        payload: { state: desiredState },
      });
      const command = unwrap(response);
      const commandId = field(command, 'commandId');
      if (commandId == null) throw new Error('Backend accepted the command but did not return commandId.');
      toast(`Command #${commandId} sent. Waiting for device acknowledgement…`);
      const completed = await waitForCommand(commandId, deviceCode, desiredState);
      if (completed) toast(`${deviceCode} confirmed state: ${desiredState.toUpperCase()}.`, 'success');
      else toast(`Command #${commandId} is still awaiting device acknowledgement.`, 'info');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      state.relayBusy = false;
      await refreshAll(false);
    }
  }

  async function setRoomCapacity() {
    const room = selectedRoom();
    if (!room) {
      toast('No room is selected.', 'error');
      return;
    }
    const current = Number(field(room, 'capacity')) || '';
    const answer = window.prompt(`Maximum occupancy for ${field(room, 'roomCode') || field(room, 'roomName')}:`, current);
    if (answer === null) return;
    const capacity = Number(answer);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) {
      toast('Enter a whole-number room capacity between 1 and 10000.', 'error');
      return;
    }
    try {
      await patch(`/rooms/${field(room, 'roomId', 'id')}`, { capacity });
      toast('Room capacity updated in CampusX SQL Server.', 'success');
      await loadRooms();
      await refreshAll(false);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function addPageControls() {
    $('#theme-toggle')?.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('campusx_theme', next);
    });
    const theme = localStorage.getItem('campusx_theme');
    if (theme) document.documentElement.dataset.theme = theme;
    $('#mobile-menu-btn')?.addEventListener('click', () => $('.sidebar')?.classList.toggle('open'));
    $('#control-refresh')?.addEventListener('click', () => refreshAll(true));
    $('#control-rules-refresh')?.addEventListener('click', () => refreshAll(true));
    $('#control-relay-toggle')?.addEventListener('click', toggleRelay);
    $('#control-set-capacity')?.addEventListener('click', setRoomCapacity);
    $('#control-occupancy-automation-save')?.addEventListener('click', saveOccupancyAutomation);

    document.querySelectorAll('.header-right-group .icon-btn').forEach((button) => {
      if (button.id !== 'theme-toggle') button.addEventListener('click', () => { location.href = '/alerts.html'; });
    });
  }

  async function init() {
    addPageControls();
    try {
      await loadSession();
      await loadRooms();
      await loadAllData();
      connectLiveStream();
      bindComputerVisionControl();
    } catch (error) {
      console.error('[CampusX Control Panel init]', error);
      toast(error.message, 'error');
    }
    window.setInterval(() => refreshAll(false), REFRESH_INTERVAL_MS);
    if (window.lucide) window.lucide.createIcons();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
