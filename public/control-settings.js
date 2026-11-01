(() => {
  'use strict';

  const API = '/api/v1';
  const $ = (selector, root = document) => root.querySelector(selector);
  const state = {
    page: location.pathname.toLowerCase().includes('settings') ? 'settings' : 'control',
    session: null,
    rooms: [],
    selectedRoomId: localStorage.getItem('campusx_control_room') || '',
    devices: [],
    latest: [],
    states: [],
    commands: [],
    cv: null,
    health: null,
    refreshTimer: null,
    eventSource: null,
    busy: false,
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function dataOf(payload) {
    return payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload;
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: { Accept: 'application/json', ...(options.headers || {}) },
    });
    if (response.status === 401) {
      location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`);
      throw new Error('Your CampusX session has expired. Please sign in again.');
    }
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : { message: await response.text() };
    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `Request failed (${response.status})`;
      throw new Error(message);
    }
    return payload;
  }

  function showError(id, message) {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = message;
    element.hidden = !message;
  }

  function setChip(element, label, status) {
    if (!element) return;
    element.textContent = label;
    element.className = `cx-state-label ${status || 'neutral'}`;
  }

  function setStatusChip(element, label, status) {
    if (!element) return;
    element.textContent = label;
    element.className = `cx-status-chip ${status || 'neutral'}`;
  }

  function fmtDate(value) {
    if (!value) return 'Not available';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not available';
    return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function fmtAgo(value) {
    if (!value) return 'No timestamp';
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return 'Timestamp unavailable';
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 5) return 'Just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
  }

  function initials(username) {
    const clean = String(username || 'CX').trim();
    const parts = clean.split(/[\s._-]+/).filter(Boolean);
    if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
    return clean.slice(0, 2).toUpperCase();
  }

  async function loadSession() {
    const payload = await request('/auth/session');
    state.session = payload;
    const username = payload?.user?.username || 'CampusX Operator';
    ['header-username', 'side-username', 'account-username', 'account-username-value'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = username;
    });
    ['header-avatar', 'side-avatar', 'account-avatar'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = initials(username);
    });
    const expiresAt = payload?.user?.expiresAt;
    if (expiresAt) {
      const expiry = new Date(expiresAt);
      const expiryEl = document.getElementById('account-expiry');
      if (expiryEl) expiryEl.textContent = fmtDate(expiry);
      const remaining = Math.max(0, expiry.getTime() - Date.now());
      const remainingEl = document.getElementById('account-remaining');
      if (remainingEl) remainingEl.textContent = remaining > 0 ? formatDuration(remaining) : 'Expired';
    }
    const subtitle = document.getElementById('account-subtitle');
    if (subtitle) subtitle.textContent = `Signed in as ${username}`;
    setStatusChip(document.getElementById('account-session-state'), 'Authenticated', 'good');
    return payload;
  }

  function formatDuration(milliseconds) {
    const minutes = Math.floor(milliseconds / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days) return `${days}d ${hours % 24}h remaining`;
    if (hours) return `${hours}h ${minutes % 60}m remaining`;
    return `${minutes}m remaining`;
  }

  async function logout() {
    const buttons = [document.getElementById('logout-btn'), document.getElementById('account-logout')].filter(Boolean);
    buttons.forEach((button) => { button.disabled = true; });
    try {
      await request('/auth/logout', { method: 'POST' });
    } catch { /* navigate to login even when the session has already expired */ }
    location.replace('/login.html');
  }

  function initShell() {
    document.getElementById('logout-btn')?.addEventListener('click', logout);
    document.getElementById('account-logout')?.addEventListener('click', logout);
    document.getElementById('mobile-menu-btn')?.addEventListener('click', () => $('.sidebar')?.classList.toggle('cx-sidebar-open'));
    const themeButton = document.getElementById('theme-toggle');
    const savedTheme = localStorage.getItem('campusx_theme');
    if (savedTheme) document.documentElement.dataset.theme = savedTheme;
    themeButton?.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('campusx_theme', next);
    });
    if (window.lucide) window.lucide.createIcons();
  }

  async function loadCommonHealth() {
    const health = await request(`${API}/health`);
    state.health = health;
    const backendOk = health?.status === 'ok';
    setChip(document.getElementById('side-backend'), backendOk ? '● Online' : '● Degraded', backendOk ? 'good' : 'bad');
    setChip(document.getElementById('side-database'), health?.database === 'connected' ? '● Connected' : '● Offline', health?.database === 'connected' ? 'good' : 'bad');
    setChip(document.getElementById('side-mqtt'), health?.mqtt === 'connected' ? '● Connected' : '● Offline', health?.mqtt === 'connected' ? 'good' : 'bad');
    if (state.page === 'settings') renderHealthSettings(health);
    return health;
  }

  async function loadRooms() {
    const response = await request(`${API}/rooms`);
    state.rooms = Array.isArray(dataOf(response)) ? dataOf(response) : [];
    const select = document.getElementById('control-room-select');
    if (select) {
      const previous = state.selectedRoomId;
      select.innerHTML = '<option value="">All rooms</option>' + state.rooms.map((room) => `<option value="${esc(room.roomId ?? room.id)}">${esc(room.roomCode || room.roomName || room.name || `Room ${room.roomId}`)}${room.roomName ? ` — ${esc(room.roomName)}` : ''}</option>`).join('');
      const found = state.rooms.some((room) => String(room.roomId ?? room.id) === String(previous));
      state.selectedRoomId = found ? String(previous) : (state.rooms[0] ? String(state.rooms[0].roomId ?? state.rooms[0].id) : '');
      if (state.selectedRoomId) select.value = state.selectedRoomId;
      select.addEventListener('change', () => {
        state.selectedRoomId = select.value;
        localStorage.setItem('campusx_control_room', state.selectedRoomId);
        void loadControlData();
      }, { once: true });
    }
    return state.rooms;
  }

  function selectedRoom() {
    return state.rooms.find((room) => String(room.roomId ?? room.id) === String(state.selectedRoomId)) || null;
  }

  async function loadControlData() {
    const roomQuery = state.selectedRoomId ? `?roomId=${encodeURIComponent(state.selectedRoomId)}` : '';
    const requests = await Promise.allSettled([
      request(`${API}/devices${roomQuery}`),
      request(`${API}/telemetry/latest${roomQuery}`),
      request(`${API}/states?limit=100`),
      request(`${API}/commands?limit=12`),
      request(`${API}/dashboard/summary`),
      request(`${API}/computer-vision/status`),
      request(`${API}/health`),
    ]);
    const valueAt = (index) => requests[index].status === 'fulfilled' ? dataOf(requests[index].value) : null;
    state.devices = Array.isArray(valueAt(0)) ? valueAt(0) : [];
    state.latest = Array.isArray(valueAt(1)) ? valueAt(1) : [];
    state.states = Array.isArray(valueAt(2)) ? valueAt(2) : [];
    state.commands = Array.isArray(valueAt(3)) ? valueAt(3) : [];
    state.summary = valueAt(4) || {};
    state.cv = valueAt(5);
    state.health = valueAt(6) || state.health;

    if (requests[5].status === 'rejected') {
      state.cvError = requests[5].reason?.message || 'Computer Vision manager is not available.';
    } else {
      state.cvError = '';
    }
    if (requests.some((item) => item.status === 'rejected' && !String(item.reason?.message || '').includes('Not found'))) {
      showError('control-error', requests.filter((item) => item.status === 'rejected').map((item) => item.reason?.message).filter(Boolean).join(' · '));
    } else {
      showError('control-error', '');
    }
    renderHealthCommon(state.health);
    renderSensors();
    renderOccupancy();
    renderActuators();
    renderCommands();
    renderCv();
  }

  function renderHealthCommon(health) {
    if (!health) return;
    const connected = health.mqtt === 'connected';
    const live = document.getElementById('control-live-status');
    if (live) {
      live.classList.toggle('is-online', health.database === 'connected' && connected);
      live.innerHTML = `<span></span>${health.database === 'connected' && connected ? 'Backend live' : 'Service degraded'}`;
    }
    setChip(document.getElementById('side-backend'), health.status === 'ok' ? '● Online' : '● Degraded', health.status === 'ok' ? 'good' : 'bad');
    setChip(document.getElementById('side-database'), health.database === 'connected' ? '● Connected' : '● Offline', health.database === 'connected' ? 'good' : 'bad');
    setChip(document.getElementById('side-mqtt'), connected ? '● Connected' : '● Offline', connected ? 'good' : 'bad');
  }

  function readingValue(reading) {
    if (!reading) return null;
    if (reading.value !== undefined && reading.value !== null) return reading.value;
    if (reading.valueNumeric !== undefined && reading.valueNumeric !== null) return reading.valueNumeric;
    if (reading.valueText !== undefined && reading.valueText !== null) return reading.valueText;
    if (reading.valueJson !== undefined && reading.valueJson !== null) return reading.valueJson;
    return null;
  }

  function renderMetric(code, targetId, metaId, suffix, emptyText) {
    const row = state.latest.find((item) => String(item.metricCode || item.metric || '').toLowerCase() === code);
    const value = readingValue(row);
    const target = document.getElementById(targetId);
    const meta = document.getElementById(metaId);
    if (target) target.innerHTML = `${value === null ? '—' : esc(typeof value === 'number' ? Number(value.toFixed(2)) : value)}<small>${esc(suffix)}</small>`;
    if (meta) meta.textContent = row ? `${row.deviceCode || 'Device'} · ${fmtAgo(row.recordedAt)}` : emptyText;
    return { row, value };
  }

  function renderSensors() {
    const temp = renderMetric('temperature', 'metric-temperature', 'metric-temperature-meta', '°C', 'No temperature reading');
    renderMetric('humidity', 'metric-humidity', 'metric-humidity-meta', '%', 'No humidity reading');
    renderMetric('co2_ppm', 'metric-co2', 'metric-co2-meta', 'ppm', 'No CO₂ reading');
    const people = renderMetric('people_count', 'metric-people', 'metric-people-meta', 'persons', 'No camera reading');
    const latestDate = [temp.row, people.row, ...state.latest].filter(Boolean).map((row) => new Date(row.recordedAt).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0];
    const updated = document.getElementById('sensor-updated');
    if (updated) updated.textContent = latestDate ? `Latest data ${fmtAgo(latestDate)}` : 'No telemetry received yet';
  }

  function renderOccupancy() {
    const room = selectedRoom();
    const row = state.latest.find((item) => String(item.metricCode || item.metric || '').toLowerCase() === 'people_count');
    const count = row ? Number(readingValue(row)) : NaN;
    const capacity = Number(room?.capacity);
    const hasCapacity = Number.isFinite(capacity) && capacity > 0;
    const safeCount = Number.isFinite(count) && count >= 0 ? count : null;
    $('#occupancy-room-name').textContent = room?.roomName || room?.name || room?.roomCode || 'All rooms';
    $('#occupancy-current').textContent = safeCount === null ? '—' : String(safeCount);
    $('#occupancy-capacity').textContent = hasCapacity ? `Capacity ${capacity} people` : 'Room capacity is not configured';
    const percent = hasCapacity && safeCount !== null ? Math.min(100, Math.round((safeCount / capacity) * 100)) : null;
    $('#occupancy-progress').style.width = percent === null ? '0%' : `${percent}%`;
    $('#occupancy-percent').textContent = percent === null ? '—' : `${percent}% of capacity`;
    $('#occupancy-updated').textContent = row ? fmtAgo(row.recordedAt) : 'Waiting for camera data';
    setStatusChip($('#occupancy-status'), safeCount === null ? 'No camera data' : 'Live count', safeCount === null ? 'neutral' : 'good');
  }

  function stateFor(deviceId) {
    return state.states.find((item) => Number(item.deviceId) === Number(deviceId) && /^(relay_state|power_state|state)$/i.test(item.stateCode || '')) || null;
  }

  function isActuator(device) {
    const category = String(device.category || '').toLowerCase();
    const type = String(device.deviceType || '').toLowerCase();
    return category === 'actuator' || /relay|fan|valve|actuator|switch/.test(type);
  }

  function renderActuators() {
    const list = document.getElementById('actuator-list');
    if (!list) return;
    const actuators = state.devices.filter((device) => device.isActive !== false && isActuator(device));
    $('#actuator-count').textContent = `${actuators.length} registered actuator${actuators.length === 1 ? '' : 's'}`;
    if (!actuators.length) {
      list.innerHTML = '<div class="cx-empty-state">No active actuator devices are registered in this room. Add a device with category <code>actuator</code> or type Relay/Fan to enable controls.</div>';
      return;
    }
    list.innerHTML = actuators.map((device) => {
      const lastState = stateFor(device.deviceId);
      const value = String(lastState?.stateValue || '').toLowerCase();
      const command = state.commands.find((item) => Number(item.deviceId) === Number(device.deviceId));
      const confirmed = ['on', 'off'].includes(value);
      return `<article class="cx-actuator-card" data-device-id="${Number(device.deviceId)}">
        <div class="cx-actuator-head"><span class="cx-icon-bubble orange"><i data-lucide="fan"></i></span><span class="cx-status-chip ${confirmed ? (value === 'on' ? 'good' : 'neutral') : 'neutral'}">${confirmed ? `State ${esc(value.toUpperCase())}` : 'State not reported'}</span></div>
        <h4>${esc(device.deviceName || device.name || device.deviceCode)}</h4><p>${esc(device.deviceCode)} · ${esc(device.deviceType || 'Actuator')}</p>
        <div class="cx-actuator-meta"><span>Device status</span><strong>${esc(device.status || 'unknown')}</strong></div>
        <div class="cx-actuator-meta"><span>Last command</span><strong>${command ? `${esc(command.commandType)} · ${esc(command.status)}` : 'No commands yet'}</strong></div>
        <div class="cx-button-row"><button class="cx-btn cx-btn-primary" data-action="on" data-code="${esc(device.deviceCode)}" ${device.status === 'offline' || !state.health || state.health.mqtt !== 'connected' ? 'disabled' : ''}><i data-lucide="power"></i> Turn on</button><button class="cx-btn cx-btn-secondary" data-action="off" data-code="${esc(device.deviceCode)}" ${device.status === 'offline' || !state.health || state.health.mqtt !== 'connected' ? 'disabled' : ''}><i data-lucide="power-off"></i> Turn off</button></div>
        ${lastState ? `<small class="cx-hint">Confirmed ${esc(value)} · ${fmtAgo(lastState.recordedAt)}</small>` : '<small class="cx-hint">State appears after a device reports a successful command response with result.state.</small>'}
      </article>`;
    }).join('');
    list.querySelectorAll('button[data-action]').forEach((button) => button.addEventListener('click', () => sendRelayCommand(button.dataset.code, button.dataset.action)));
    if (window.lucide) window.lucide.createIcons();
  }

  async function sendRelayCommand(deviceCode, action) {
    if (!deviceCode || !['on', 'off'].includes(action)) return;
    if (!confirm(`Send ${action.toUpperCase()} command to ${deviceCode}?`)) return;
    const buttons = [...document.querySelectorAll(`[data-code="${CSS.escape(deviceCode)}"]`)];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const result = await request(`${API}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode, commandType: 'set_state', payload: { state: action } }),
      });
      const id = dataOf(result)?.commandId ?? dataOf(result)?.id;
      showError('control-error', `Command ${id ?? ''} sent to ${deviceCode}. Waiting for the device response…`);
      await pollCommand(deviceCode, id);
      await loadControlData();
    } catch (error) {
      showError('control-error', error.message);
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async function pollCommand(deviceCode, commandId) {
    const until = Date.now() + 12000;
    let latest = null;
    while (Date.now() < until) {
      const response = await request(`${API}/commands?limit=30`);
      const rows = Array.isArray(dataOf(response)) ? dataOf(response) : [];
      latest = rows.find((item) => String(item.deviceCode) === String(deviceCode) && (commandId == null || String(item.commandId ?? item.id) === String(commandId))) || latest;
      if (latest && ['completed', 'failed', 'timeout', 'cancelled'].includes(String(latest.status).toLowerCase())) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (latest?.status === 'completed') showError('control-error', `Device ${deviceCode} confirmed the ${latest.commandType} command.`);
    else if (latest?.status === 'failed') showError('control-error', `Device ${deviceCode} reported command failure.`);
    else showError('control-error', `Command sent to ${deviceCode}; current status is ${latest?.status || 'pending'}. No final device confirmation received yet.`);
  }

  function renderCommands() {
    const body = document.getElementById('command-history');
    if (!body) return;
    if (!state.commands.length) {
      body.innerHTML = '<tr><td colspan="6" class="cx-empty-cell">No device commands have been recorded yet.</td></tr>';
      return;
    }
    body.innerHTML = state.commands.slice(0, 12).map((command) => {
      const payload = typeof command.payload === 'string' ? command.payload : JSON.stringify(command.payload || {});
      const status = String(command.status || 'unknown').toLowerCase();
      const css = status === 'completed' ? 'good' : status === 'failed' || status === 'timeout' ? 'bad' : 'neutral';
      return `<tr><td><strong>${esc(command.deviceCode || `Device #${command.deviceId}`)}</strong></td><td>${esc(command.commandType || command.type)}</td><td><code>${esc(payload)}</code></td><td><span class="cx-state-label ${css}">${esc(status)}</span></td><td>${esc(fmtDate(command.createdAt || command.created_at))}</td><td>${esc(fmtDate(command.completedAt || command.completed_at))}</td></tr>`;
    }).join('');
  }

  function renderCv() {
    const cv = state.cv;
    const camera = Boolean(cv?.camera?.running);
    const bridge = Boolean(cv?.bridge?.running);
    const running = Boolean(cv?.running);
    setStatusChip($('#cv-status-chip'), running ? 'Running' : cv?.partiallyRunning ? 'Partially running' : cv?.configured ? 'Stopped' : 'Not configured', running ? 'good' : cv?.partiallyRunning ? 'warn' : 'neutral');
    $('#cv-camera-status').textContent = camera ? 'Online' : 'Offline';
    $('#cv-bridge-status').textContent = bridge ? 'Running' : 'Stopped';
    $('#cv-inference').textContent = Number.isFinite(Number(cv?.camera?.inferenceMs)) ? `${Number(cv.camera.inferenceMs).toFixed(0)} ms` : '—';
    $('#cv-people').textContent = Number.isFinite(Number(cv?.camera?.currentPeople)) ? String(cv.camera.currentPeople) : '—';
    $('#cv-message').textContent = state.cvError || (cv?.configured ? (running ? 'Camera and MQTT Bridge are both running.' : 'Use Start CV to launch the camera service and MQTT Bridge.') : 'Computer Vision manager is not installed or its scripts are missing.');
    $('#cv-start').disabled = !cv?.configured || running || Boolean(cv?.partiallyRunning);
    $('#cv-stop').disabled = !camera && !bridge;
    const preview = $('#cv-preview');
    if (preview) {
      preview.href = cv?.previewUrl || 'http://127.0.0.1:5000/';
      preview.classList.toggle('disabled-link', !camera);
      preview.setAttribute('aria-disabled', String(!camera));
    }
  }

  async function cvAction(action) {
    const button = document.getElementById(action === 'start' ? 'cv-start' : 'cv-stop');
    if (button) button.disabled = true;
    $('#cv-message').textContent = `${action === 'start' ? 'Starting' : 'Stopping'} Computer Vision…`;
    try {
      const result = await request(`${API}/computer-vision/${action}`, { method: 'POST' });
      state.cv = dataOf(result);
      $('#cv-message').textContent = result.message || `${action} request completed.`;
      await loadControlData();
    } catch (error) {
      $('#cv-message').textContent = error.message;
      await refreshCvOnly();
    } finally {
      renderCv();
    }
  }

  async function refreshCvOnly() {
    try { state.cv = dataOf(await request(`${API}/computer-vision/status`)); state.cvError = ''; }
    catch (error) { state.cvError = error.message; }
    renderCv();
  }

  function connectEvents() {
    if (!window.EventSource) return;
    const stream = new EventSource(`${API}/stream?types=telemetry,device.status,device.state,command,alert`);
    state.eventSource = stream;
    const live = document.getElementById(state.page === 'settings' ? 'settings-live-status' : 'control-live-status');
    stream.onopen = () => { if (live) { live.classList.add('is-online'); live.innerHTML = '<span></span> Live updates'; } };
    stream.onerror = () => { if (live) { live.classList.remove('is-online'); live.innerHTML = '<span></span> Reconnecting'; } };
    ['telemetry', 'device.status', 'device.state', 'command', 'alert'].forEach((type) => {
      stream.addEventListener(type, () => {
        if (state.refreshTimer) clearTimeout(state.refreshTimer);
        state.refreshTimer = setTimeout(() => {
          if (state.page === 'control') void loadControlData();
          else void loadSettingsData();
        }, 350);
      });
    });
  }

  function renderHealthSettings(health) {
    const ok = health?.status === 'ok';
    setStatusChip($('#system-overall'), ok ? 'Operational' : 'Degraded', ok ? 'good' : 'bad');
    $('#backend-detail').textContent = `${health?.service || 'CampusX Backend'} · ${fmtDate(health?.time)}`;
    setChip($('#backend-state'), ok ? 'Online' : 'Degraded', ok ? 'good' : 'bad');
    $('#database-detail').textContent = health?.database === 'connected' ? 'SQL Server connection established' : 'Database connection unavailable';
    setChip($('#database-state'), health?.database === 'connected' ? 'Connected' : 'Offline', health?.database === 'connected' ? 'good' : 'bad');
    $('#mqtt-detail').textContent = health?.mqtt === 'connected' ? 'Backend MQTT client is connected to the broker' : 'Backend MQTT client is disconnected';
    setChip($('#mqtt-state'), health?.mqtt === 'connected' ? 'Connected' : 'Offline', health?.mqtt === 'connected' ? 'good' : 'bad');
    if ($('#write-protection-state')) {
      $('#write-protection-copy').textContent = 'Authenticated dashboard session is required for API access. API_KEY can be configured as an additional write guard.';
      setChip($('#write-protection-state'), 'Session protected', 'good');
    }
  }

  async function loadSettingsData() {
    const jobs = await Promise.allSettled([
      request('/auth/session'),
      request(`${API}/health`),
      request(`${API}/sqlserver/health`),
      request(`${API}/rooms`),
      request(`${API}/devices`),
      request(`${API}/metrics`),
      request(`${API}/alert-rules`),
      request(`${API}/computer-vision/status`),
    ]);
    const values = jobs.map((job) => job.status === 'fulfilled' ? dataOf(job.value) : null);
    if (jobs[0].status === 'rejected') throw jobs[0].reason;
    const sessionPayload = jobs[0].value;
    state.session = sessionPayload;
    const username = sessionPayload?.user?.username || 'CampusX Operator';
    ['header-username', 'side-username', 'account-username', 'account-username-value'].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = username; });
    ['header-avatar', 'side-avatar', 'account-avatar'].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = initials(username); });
    const expiresAt = sessionPayload?.user?.expiresAt;
    $('#account-expiry').textContent = fmtDate(expiresAt);
    $('#account-remaining').textContent = expiresAt ? formatDuration(Math.max(0, new Date(expiresAt).getTime() - Date.now())) : 'Not provided by session';
    $('#account-subtitle').textContent = `Signed in as ${username}`;
    setStatusChip($('#account-session-state'), 'Authenticated', 'good');

    const health = values[1];
    if (health) renderHealthSettings(health);
    const db = values[2];
    if (db) {
      $('#database-detail').textContent = `${db.databaseName || 'SQL Server'} · ${db.tableCount ?? '—'} tables`;
      setChip($('#database-state'), health?.database === 'connected' ? 'Connected' : 'Available', health?.database === 'connected' ? 'good' : 'neutral');
    }
    const rooms = Array.isArray(values[3]) ? values[3] : [];
    const devices = Array.isArray(values[4]) ? values[4] : [];
    const metrics = Array.isArray(values[5]) ? values[5] : [];
    const rules = Array.isArray(values[6]) ? values[6] : [];
    $('#resource-rooms').textContent = rooms.filter((item) => item.isActive !== false).length;
    $('#resource-devices').textContent = devices.filter((item) => item.isActive !== false).length;
    $('#resource-metrics').textContent = metrics.length;
    $('#resource-rules').textContent = rules.filter((item) => item.isEnabled === true || item.isEnabled === 1).length;

    const cv = values[7];
    if (cv) {
      const running = Boolean(cv.running);
      $('#cv-detail').textContent = running ? 'Camera and MQTT Bridge are running' : cv.configured ? 'Manager configured; processes stopped' : 'Manager or scripts not configured';
      setChip($('#cv-state'), running ? 'Running' : cv.partiallyRunning ? 'Partial' : cv.configured ? 'Stopped' : 'Unavailable', running ? 'good' : cv.partiallyRunning ? 'warn' : 'neutral');
    } else {
      $('#cv-detail').textContent = jobs[7].status === 'rejected' ? 'CV manager endpoint not available' : 'Status unavailable';
      setChip($('#cv-state'), 'Unavailable', 'neutral');
    }
    renderRules(rules);
    if (jobs.slice(1).some((job) => job.status === 'rejected')) {
      showError('settings-error', jobs.slice(1).filter((job) => job.status === 'rejected').map((job) => job.reason?.message).join(' · '));
    } else {
      showError('settings-error', '');
    }
    if (window.lucide) window.lucide.createIcons();
  }

  function renderRules(rules) {
    const host = document.getElementById('settings-rules');
    if (!host) return;
    if (!rules.length) {
      host.innerHTML = '<div class="cx-empty-state">No alert rules are configured in SQL Server.</div>';
      return;
    }
    host.innerHTML = rules.map((rule) => {
      let severity = 'info';
      try { severity = JSON.parse(rule.configJson || '{}').severity || 'info'; } catch { /* display default */ }
      return `<div class="cx-rule-row"><div><strong>${esc(rule.ruleName)}</strong><small>${esc(rule.metricCode || `Metric #${rule.metricId}`)} ${esc(rule.operator)} ${esc(rule.threshold ?? '—')} · ${esc(rule.durationSeconds ?? 0)}s</small></div><span class="cx-severity ${esc(severity)}">${esc(severity)}</span><span class="cx-state-label ${rule.isEnabled ? 'good' : 'neutral'}">${rule.isEnabled ? 'Enabled' : 'Disabled'}</span></div>`;
    }).join('');
  }

  function bindButtons() {
    document.getElementById('control-refresh')?.addEventListener('click', () => void loadControlData());
    document.getElementById('commands-refresh')?.addEventListener('click', () => void loadControlData());
    document.getElementById('cv-start')?.addEventListener('click', () => void cvAction('start'));
    document.getElementById('cv-stop')?.addEventListener('click', () => void cvAction('stop'));
    document.getElementById('settings-refresh')?.addEventListener('click', () => void loadSettingsData());
  }

  async function init() {
    initShell();
    bindButtons();
    try {
      if (state.page === 'control') {
        await loadSession();
        await loadRooms();
        await loadControlData();
        connectEvents();
        setInterval(() => void loadControlData(), 20000);
      } else {
        await loadSettingsData();
        connectEvents();
        setInterval(() => void loadSettingsData(), 30000);
      }
    } catch (error) {
      const id = state.page === 'control' ? 'control-error' : 'settings-error';
      showError(id, error.message || 'Could not load CampusX page data.');
    }
    if (window.lucide) window.lucide.createIcons();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
