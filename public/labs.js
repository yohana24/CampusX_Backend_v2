(() => {
  'use strict';

  const API = '/api/v1';
  const REFRESH_MS = 15000;
  const state = { rooms: [], devices: [], telemetry: [], alerts: [], selectedRoomId: null, query: '', timer: null, loading: false, apiKeyPrompted: false };
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const field = (obj, ...names) => {
    if (!obj) return undefined;
    for (const name of names) {
      if (obj[name] !== undefined && obj[name] !== null) return obj[name];
      const key = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());
      if (key && obj[key] !== undefined && obj[key] !== null) return obj[key];
    }
    return undefined;
  };
  const rows = (payload) => Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const numberOrNull = (value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  const roomIdOf = (room) => Number(field(room, 'roomId', 'id', 'lab_id'));
  const roomCodeOf = (room) => String(field(room, 'roomCode', 'code') || `ROOM-${roomIdOf(room)}`);
  const roomNameOf = (room) => String(field(room, 'roomName', 'name') || roomCodeOf(room));
  const dateOf = (value) => { const d = value ? new Date(value) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
  const age = (value) => {
    const d = dateOf(value); if (!d) return 'No reading yet';
    const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`;
  };
  const dateLabel = (value) => { const d = dateOf(value); return d ? d.toLocaleString() : 'Time unavailable'; };

  async function api(path, retry = true, requestOptions = {}) {
    const headers = { Accept: 'application/json', ...(requestOptions.headers || {}) };
    const key = sessionStorage.getItem('campusx_api_key');
    if (key) headers['X-API-Key'] = key;
    if (requestOptions.body && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${API}${path}`, {
      ...requestOptions,
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
    });
    if (response.status === 401) {
      location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`);
      throw new Error('Your login session has expired. Please sign in again.');
    }
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
    if (response.status === 403 && retry && !key && !state.apiKeyPrompted) {
      state.apiKeyPrompted = true;
      const entered = window.prompt('Enter the CampusX API key from the server .env file:');
      if (entered?.trim()) {
        sessionStorage.setItem('campusx_api_key', entered.trim());
        return api(path, false, requestOptions);
      }
    }
    if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `Request failed (${response.status})`);
    return payload;
  }

  function setCreateLabFeedback(message, kind = 'info') {
    const box = $('#create-lab-feedback');
    if (!box) return;
    box.hidden = !message;
    box.className = `labs-create-feedback ${kind}`;
    box.textContent = message || '';
  }

  async function createLab(event) {
    event.preventDefault();
    const form = $('#create-lab-form');
    const button = $('#create-lab-submit');
    if (!form || !button) return;

    const roomName = $('#new-lab-name').value.trim();
    const roomCode = $('#new-lab-code').value.trim().toUpperCase();
    const capacityText = $('#new-lab-capacity').value.trim();
    const locationDetails = $('#new-lab-location').value.trim();
    const capacity = capacityText === '' ? null : Number(capacityText);

    if (!roomName || !roomCode) {
      setCreateLabFeedback('Lab name and lab code are required.', 'error');
      return;
    }
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 0)) {
      setCreateLabFeedback('Capacity must be a whole number greater than or equal to zero.', 'error');
      return;
    }
    if (state.rooms.some((room) => roomCodeOf(room).toLowerCase() === roomCode.toLowerCase())) {
      setCreateLabFeedback(`Lab code ${roomCode} already exists. Choose a different code.`, 'error');
      return;
    }

    button.disabled = true;
    button.classList.add('is-loading');
    button.querySelector('span').textContent = 'Saving labâ€¦';
    setCreateLabFeedback('Connecting to CampusX and saving the new labâ€¦', 'info');

    try {
      const response = await api('/rooms', true, {
        method: 'POST',
        body: JSON.stringify({
          roomCode,
          roomName,
          capacity,
          locationDetails: locationDetails || null,
        }),
      });
      const created = response?.data || response;
      const newRoomId = Number(field(created, 'roomId', 'id'));
      setCreateLabFeedback(`${roomName} (${roomCode}) was saved successfully in CampusX.`, 'success');
      form.reset();
      await loadData(false);
      if (Number.isFinite(newRoomId) && newRoomId > 0) selectRoom(newRoomId);
      $('#create-lab-panel').open = true;
    } catch (error) {
      const rawMessage = String(error.message || 'Could not create lab.');
      const duplicate = /duplicate|unique|UQ_Rooms_RoomCode|2627|2601/i.test(rawMessage);
      setCreateLabFeedback(duplicate ? `Lab code ${roomCode} is already registered. Choose another code.` : rawMessage, 'error');
    } finally {
      button.disabled = false;
      button.classList.remove('is-loading');
      button.querySelector('span').textContent = 'Create lab';
      icons();
    }
  }

  function metricsFor(roomId) {
    const list = state.telemetry.filter((r) => Number(field(r, 'roomId', 'lab_id')) === roomId);
    const latest = new Map();
    for (const row of list) {
      const code = String(field(row, 'metricCode', 'metric', 'displayName') || '').toLowerCase();
      if (!code) continue;
      const previous = latest.get(code);
      const when = dateOf(field(row, 'recordedAt', 'recorded_at', 'receivedAt'))?.getTime() || 0;
      const prevWhen = dateOf(field(previous, 'recordedAt', 'recorded_at', 'receivedAt'))?.getTime() || 0;
      if (!previous || when >= prevWhen) latest.set(code, row);
    }
    return latest;
  }

  function metricValue(map, aliases) {
    for (const alias of aliases) {
      const row = map.get(alias);
      if (!row) continue;
      let value = field(row, 'value', 'valueNumeric', 'valueText', 'valueJson');
      if (value === null || value === undefined || value === '') continue;
      if (typeof value === 'string' && /^[{[]/.test(value.trim())) { try { value = JSON.parse(value); } catch { /* keep text */ } }
      if (typeof value === 'object') value = value.count ?? value.value ?? value.raw ?? null;
      const n = numberOrNull(value);
      return { value: n === null ? String(value) : n, row };
    }
    return { value: null, row: null };
  }

  function roomDevices(roomId) { return state.devices.filter((d) => Number(field(d, 'roomId', 'lab_id')) === roomId); }
  function roomAlerts(roomId) { return state.alerts.filter((a) => Number(field(a, 'roomId', 'lab_id')) === roomId && ['open', 'acknowledged'].includes(String(field(a, 'status') || '').toLowerCase())); }
  function deviceIsOnline(d) { return String(field(d, 'status') || '').toLowerCase() === 'online'; }
  function occupancy(roomId) {
    const m = metricValue(metricsFor(roomId), ['people_count']);
    return { count: numberOrNull(m.value), row: m.row };
  }
  function freshness(roomId) {
    const rowsInRoom = state.telemetry.filter((r) => Number(field(r, 'roomId', 'lab_id')) === roomId);
    const times = rowsInRoom.map((r) => dateOf(field(r, 'recordedAt', 'recorded_at', 'receivedAt'))?.getTime() || 0).filter(Boolean);
    return times.length ? Math.max(...times) : null;
  }
  function roomStatus(room) {
    const devices = roomDevices(roomIdOf(room));
    if (!devices.length) return 'offline';
    if (devices.some(deviceIsOnline)) return 'online';
    if (devices.some((d) => String(field(d, 'status') || '').toLowerCase() === 'maintenance')) return 'warning';
    return 'offline';
  }
  function statusMarkup(status) {
    const label = status === 'online' ? 'Online' : status === 'warning' ? 'Maintenance' : 'Offline';
    return `<span class="lab-status ${status}">${label}</span>`;
  }

  function renderSummary() {
    const online = state.devices.filter(deviceIsOnline).length;
    const openAlerts = state.alerts.filter((a) => ['open', 'acknowledged'].includes(String(field(a, 'status') || '').toLowerCase())).length;
    const occupied = state.rooms.filter((r) => (occupancy(roomIdOf(r)).count || 0) > 0).length;
    $('#summary-labs').textContent = state.rooms.length;
    $('#summary-online').textContent = online;
    $('#summary-device-total').textContent = `of ${state.devices.length} registered devices`;
    $('#summary-alerts').textContent = openAlerts;
    $('#summary-occupied').textContent = occupied;
    $('#labs-count').textContent = `${state.rooms.length} ${state.rooms.length === 1 ? 'lab' : 'labs'}`;
  }

  function renderLabs() {
    const query = state.query.trim().toLowerCase();
    const visible = state.rooms.filter((r) => `${roomCodeOf(r)} ${roomNameOf(r)} ${field(r, 'locationDetails') || ''}`.toLowerCase().includes(query));
    const host = $('#labs-grid');
    if (!visible.length) {
      host.innerHTML = `<div class="labs-empty-grid">${state.rooms.length ? 'No labs match your search.' : 'No laboratories are registered in CampusX yet.'}</div>`;
      return;
    }
    host.innerHTML = visible.map((room) => {
      const id = roomIdOf(room); const devices = roomDevices(id); const online = devices.filter(deviceIsOnline).length;
      const alerts = roomAlerts(id).length; const occ = occupancy(id); const count = occ.count;
      const cap = numberOrNull(field(room, 'capacity')); const pct = cap && count !== null ? Math.max(0, Math.min(100, count / cap * 100)) : null;
      const active = id === Number(state.selectedRoomId);
      return `<article class="lab-card${active ? ' selected' : ''}" data-room-id="${id}" tabindex="0" role="button" aria-label="View ${esc(roomNameOf(room))}">
        <div class="lab-card-top"><div class="lab-card-identity"><div class="lab-card-icon"><i data-lucide="building-2"></i></div><div class="lab-card-title"><strong>${esc(roomNameOf(room))}</strong><span>${esc(roomCodeOf(room))}${field(room, 'locationDetails') ? ` آ· ${esc(field(room, 'locationDetails'))}` : ''}</span></div></div>${statusMarkup(roomStatus(room))}</div>
        <div class="lab-card-occupancy"><div><span>Current occupancy</span><strong>${count === null ? 'â€”' : Math.round(count)}</strong><small>${count === null ? 'No people-count data' : `people detected آ· ${cap ? `${Math.max(0, cap - count)} spaces available` : 'capacity not set'}`}</small></div><div style="text-align:right"><span>Devices online</span><strong style="font-size:18px">${online}<small style="font-size:10px"> / ${devices.length}</small></strong></div></div>
        ${pct === null ? '' : `<div class="lab-mini-progress"><span style="width:${pct}%"></span></div>`}
        <div class="lab-card-bottom"><span><i data-lucide="bell"></i><b>${alerts}</b> open alerts</span><span><i data-lucide="clock-3"></i>${age(freshness(id))}</span></div>
      </article>`;
    }).join('');
    host.querySelectorAll('[data-room-id]').forEach((card) => {
      const select = () => selectRoom(Number(card.dataset.roomId));
      card.addEventListener('click', select);
      card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
    });
    icons();
  }

  function metricCard(title, aliases, unit, icon, decimals = 1) {
    const map = metricsFor(Number(state.selectedRoomId));
    const item = metricValue(map, aliases);
    const value = item.value === null ? 'â€”' : typeof item.value === 'number' ? `${Number(item.value.toFixed(decimals))}${unit}` : `${item.value}${unit}`;
    return `<div class="labs-metric"><span><i data-lucide="${icon}" style="width:11px;height:11px;vertical-align:-2px;margin-right:4px"></i>${title}</span><strong>${esc(value)}</strong><small>${item.row ? `Updated ${age(field(item.row, 'recordedAt', 'recorded_at', 'receivedAt'))}` : 'No reading received'}</small></div>`;
  }

  function renderDetails() {
    const room = state.rooms.find((r) => roomIdOf(r) === Number(state.selectedRoomId));
    const host = $('#lab-details');
    if (!room) {
      host.innerHTML = `<div class="labs-detail-empty"><div class="labs-empty-icon"><i data-lucide="mouse-pointer-click"></i></div><h3>Select a laboratory</h3><p>Choose a lab card to see its sensors, occupancy, devices and alerts.</p></div>`;
      icons(); return;
    }
    const id = roomIdOf(room); const devices = roomDevices(id); const alerts = roomAlerts(id); const occ = occupancy(id); const cap = numberOrNull(field(room, 'capacity'));
    const count = occ.count; const pct = cap && count !== null ? Math.max(0, Math.min(100, count / cap * 100)) : 0;
    const activeDevices = devices.filter((d) => Boolean(field(d, 'isActive')));
    const metricCards = [
      metricCard('Temperature', ['temperature', 'temp_c', 'temp'], 'آ°C', 'thermometer', 1),
      metricCard('Humidity', ['humidity', 'relative_humidity'], '%', 'droplets', 1),
      metricCard('COâ‚‚', ['co2_ppm', 'co2'], ' ppm', 'wind', 0),
      metricCard('Air quality', ['air_quality', 'air_quality_index', 'aqi'], '', 'activity', 0),
      metricCard('Smoke', ['smoke', 'smoke_level'], '', 'flame', 0),
      metricCard('People detected', ['people_count'], '', 'users', 0),
    ].join('');
    host.innerHTML = `<section class="labs-detail-panel" data-room-id="${id}">
      <div class="labs-detail-heading"><div><h3>${esc(roomNameOf(room))}</h3><p>${esc(roomCodeOf(room))}${field(room, 'locationDetails') ? ` آ· ${esc(field(room, 'locationDetails'))}` : ''}</p></div>${statusMarkup(roomStatus(room))}</div>
      <div class="labs-detail-actions"><a class="labs-small-link" href="devices.html"><i data-lucide="cpu"></i>Manage devices</a><a class="labs-small-link" href="control-panel.html"><i data-lucide="sliders-horizontal"></i>Open Control Panel</a></div>
      <section class="labs-detail-section"><h4><i data-lucide="activity"></i>Environment & sensors</h4><div class="labs-metric-grid">${metricCards}</div></section>
      <section class="labs-detail-section"><h4><i data-lucide="users"></i>Room occupancy</h4><div class="labs-occupancy-box"><div class="labs-occupancy-head"><strong>${count === null ? 'No occupancy reading' : `${Math.round(count)} ${Math.round(count) === 1 ? 'person' : 'people'} detected`}</strong><span>${cap ? `${Math.round(pct)}% of ${cap}` : 'Capacity not set'}</span></div><div class="labs-occupancy-bar"><span style="width:${pct}%"></span></div><div class="labs-occupancy-caption">${count === null ? 'Waiting for Computer Vision people_count telemetry.' : `${cap ? `${Math.max(0, cap - count)} spaces available آ· ` : ''}Latest detected headcount, not daily entries.`} ${occ.row ? `Last detection ${age(field(occ.row, 'recordedAt', 'recorded_at', 'receivedAt'))}.` : ''}</div></div></section>
      <section class="labs-detail-section"><h4><i data-lucide="cpu"></i>Devices <span style="margin-left:auto;color:#8296af;font-size:9px;font-weight:500">${onlineCount(devices)} online آ· ${devices.length} total</span></h4><div class="labs-device-list">${devices.length ? devices.map((d) => `<div class="labs-device-row"><div class="labs-device-info"><span class="labs-device-icon"><i data-lucide="${String(field(d, 'category') || '').toLowerCase() === 'actuator' ? 'toggle-right' : String(field(d, 'category') || '').toLowerCase() === 'camera' ? 'camera' : 'cpu'}"></i></span><div><strong>${esc(field(d, 'deviceName', 'name') || field(d, 'deviceCode'))}</strong><small>${esc(field(d, 'deviceCode') || '')} آ· ${esc(field(d, 'deviceType', 'category') || 'Device')}</small></div></div>${statusMarkup(deviceIsOnline(d) ? 'online' : String(field(d, 'status') || '').toLowerCase() === 'maintenance' ? 'warning' : 'offline')}</div>`).join('') : '<div class="labs-empty-inline">No devices are registered in this lab.</div>'}</div></section>
      <section class="labs-detail-section"><h4><i data-lucide="bell-ring"></i>Open alerts <span style="margin-left:auto;color:#8296af;font-size:9px;font-weight:500">${alerts.length} active</span></h4><div class="labs-alert-list">${alerts.length ? alerts.slice(0, 5).map((a) => { const severity = String(field(a, 'severity') || 'info').toLowerCase(); return `<div class="labs-alert-row ${esc(severity)}"><div class="labs-alert-info"><span class="labs-alert-icon"><i data-lucide="${severity === 'critical' ? 'alert-octagon' : severity === 'warning' ? 'alert-triangle' : 'info'}"></i></span><div><strong>${esc(field(a, 'alertType', 'type') || 'Alert')}</strong><small>${esc(String(field(a, 'status') || 'open').toUpperCase())} آ· ${esc(age(field(a, 'createdAt', 'created_at')))}</small></div></div><span class="labs-alert-message">${esc(field(a, 'message') || '')}</span></div>`; }).join('') : '<div class="labs-alert-empty">No open alerts for this lab.</div>'}</div></section>
      <div class="labs-detail-actions" style="margin-top:16px"><a class="labs-small-link" href="alerts.html">View all alerts <i data-lucide="arrow-up-right"></i></a></div>
    </section>`;
    icons();
  }

  function onlineCount(devices) { return devices.filter(deviceIsOnline).length; }
  function selectRoom(id) {
    state.selectedRoomId = id;
    const url = new URL(location.href); url.searchParams.set('roomId', String(id)); history.replaceState({}, '', url);
    renderLabs(); renderDetails();
  }
  function icons() { if (window.lucide?.createIcons) window.lucide.createIcons(); }

  async function loadData(showSpinner = false) {
    if (state.loading) return;
    state.loading = true;
    if (showSpinner) $('#labs-grid').innerHTML = '<div class="labs-loading"><span class="labs-spinner"></span>Loading registered labsâ€¦</div>';
    try {
      const [roomResponse, deviceResponse, telemetryResponse, alertResponse, healthResponse] = await Promise.all([
        api('/rooms'), api('/devices'), api('/telemetry/latest'), api('/alerts?limit=500'), api('/health').catch(() => null),
      ]);
      state.rooms = rows(roomResponse);
      state.devices = rows(deviceResponse);
      state.telemetry = rows(telemetryResponse);
      state.alerts = rows(alertResponse);
      if (healthResponse) {
        const data = healthResponse.data || healthResponse;
        setSystemStatus('labs-backend-status', data.status === 'ok' ? 'Online' : 'Degraded', data.status === 'ok');
        setSystemStatus('labs-db-status', data.database || 'Unknown', data.database === 'connected');
        setSystemStatus('labs-mqtt-status', data.mqtt || 'Unknown', data.mqtt === 'connected');
      }
      const params = new URLSearchParams(location.search); const requested = Number(params.get('roomId'));
      if (!state.rooms.some((r) => roomIdOf(r) === Number(state.selectedRoomId))) {
        state.selectedRoomId = state.rooms.some((r) => roomIdOf(r) === requested) ? requested : (state.rooms.length ? roomIdOf(state.rooms[0]) : null);
      }
      renderSummary(); renderLabs(); renderDetails();
      $('#labs-updated-at').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      $('#labs-grid').innerHTML = `<div class="labs-error">Could not load CampusX lab data: ${esc(error.message)}<br>Check that you are logged in and the Backend/SQL Server are running.</div>`;
      setSystemStatus('labs-backend-status', 'Unavailable', false);
    } finally { state.loading = false; }
  }
  function setSystemStatus(id, label, good) {
    const el = document.getElementById(id); if (!el) return;
    el.textContent = label; el.style.color = good ? '#6ee7b7' : '#fbbf24';
  }

  async function loadUser() {
    try {
      const response = await fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401) { location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`); return; }
      const payload = await response.json(); const username = payload?.user?.username || 'CampusX Operator';
      $('#labs-username').textContent = username; $('#labs-avatar').textContent = username.slice(0, 2).toUpperCase();
    } catch { /* auth-client handles session failures */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#labs-mobile-menu')?.addEventListener('click', () => $('.sidebar')?.classList.toggle('open'));
    $('#labs-refresh')?.addEventListener('click', () => loadData(true));
    $('#labs-search-input')?.addEventListener('input', (event) => { state.query = event.target.value || ''; renderLabs(); });
    $('#create-lab-form')?.addEventListener('submit', createLab);
    $('#new-lab-code')?.addEventListener('input', (event) => { event.target.value = event.target.value.toUpperCase().replace(/\s+/g, '-'); });
    loadUser(); loadData(true);
    state.timer = window.setInterval(() => loadData(false), REFRESH_MS);
    icons();
  });
  window.addEventListener('beforeunload', () => { if (state.timer) window.clearInterval(state.timer); });
})();

