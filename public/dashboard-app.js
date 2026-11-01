/* CampusX Dashboard API integration. Keeps the supplied UI and binds it to /api/v1. */
(() => {
  'use strict';

  const API = '/api/v1';
  const state = {
    rooms: [], roomId: null, devices: [], nodes: [], telemetry: [], alerts: [], commands: [],
    chart: null, eventSource: null, refreshTimer: null, deviceFilter: 'all', alertFilter: 'all',
    fanState: 'off', fanBusy: false, cvBusy: false, cvPollTimer: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
  const fmt = (value, digits = 1) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
  const asArray = (response) => Array.isArray(response?.data) ? response.data : [];
  const valueOf = (row) => {
    if (row?.value !== undefined && row?.value !== null) return row.value;
    if (row?.valueNumeric !== undefined && row?.valueNumeric !== null) return row.valueNumeric;
    if (row?.valueText !== undefined && row?.valueText !== null) return row.valueText;
    return row?.valueJson ?? null;
  };
  const when = (value) => {
    if (!value) return 'Never';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  };
  const ago = (value) => {
    if (!value) return 'Never';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    if (!Number.isFinite(seconds)) return '—';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };
  const activeAlert = (a) => ['open', 'acknowledged'].includes(String(a.status || '').toLowerCase());
  const metricRows = (metricCode, rows = state.telemetry) => rows.filter((r) => r.metricCode === metricCode || r.metric === metricCode);
  const average = (rows) => {
    const values = rows.map(valueOf).map(Number).filter(Number.isFinite);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  const sum = (rows) => {
    const values = rows.map(valueOf).map(Number).filter(Number.isFinite);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };

  function toast(message, kind = 'info') {
    let host = $('#cx-toast-host');
    if (!host) {
      host = document.createElement('div'); host.id = 'cx-toast-host'; host.className = 'cx-toast-host';
      document.body.appendChild(host);
    }
    const item = document.createElement('div');
    item.className = `cx-toast cx-toast-${kind}`;
    item.textContent = message;
    host.appendChild(item);
    window.setTimeout(() => item.remove(), 4500);
  }

  async function request(path, options = {}, retried = false) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const key = sessionStorage.getItem('campusx_api_key');
    if (key) headers['X-API-Key'] = key;
    let response;
    try {
      response = await fetch(`${API}${path}`, { ...options, headers, credentials: 'same-origin' });
    } catch (error) {
      throw new Error(`Cannot reach CampusX API. Is npm start running? (${error.message})`);
    }
    let payload;
    const text = await response.text();
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    if (response.status === 401 && payload?.error?.code === 'AUTH_REQUIRED') {
      location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`);
      throw new Error('Your CampusX session expired. Please sign in again.');
    }
    if (response.status === 401 && !retried) {
      const entered = window.prompt('CampusX API key is required. Enter API_KEY from the backend .env file:');
      if (entered !== null && entered.trim()) {
        sessionStorage.setItem('campusx_api_key', entered.trim());
        return request(path, options, true);
      }
    }
    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }

  async function get(path) { return request(path); }
  async function post(path, body) { return request(path, { method: 'POST', body: JSON.stringify(body) }); }
  async function patch(path, body) { return request(path, { method: 'PATCH', body: JSON.stringify(body) }); }

  function setText(element, text) { if (element) element.textContent = text; }
  function updateSidebarHealth(health) {
    const rows = $$('.system-status-box .sys-row');
    if (rows[0]) setText($('strong', rows[0]), health?.status === 'ok' ? '● Live' : '● Offline');
    if (rows[1]) setText($('strong', rows[1]), health?.database === 'connected' ? '● Connected' : '● Disconnected');
    if (rows[2]) setText($('strong', rows[2]), health?.mqtt === 'connected' ? '● Online' : '● Offline');
    rows.forEach((row) => {
      const strong = $('strong', row);
      if (strong) strong.className = /Online|Live|Connected/.test(strong.textContent) ? 'green-text' : 'red-text';
    });
  }

  async function loadRooms() {
    const rooms = asArray(await get('/rooms'));
    state.rooms = rooms;
    const select = $('#lab-select-dropdown');
    if (!select) {
      const saved = Number(localStorage.getItem('campusx_room_id'));
      state.roomId = rooms.some((r) => Number(r.roomId ?? r.id) === saved) ? saved : Number(rooms[0]?.roomId ?? rooms[0]?.id) || null;
      return;
    }
    const saved = Number(localStorage.getItem('campusx_room_id'));
    const preferred = rooms.find((r) => Number(r.roomId ?? r.id) === saved)
      || rooms.find((r) => String(r.roomCode).toUpperCase() === 'LAB-01') || rooms[0];
    select.innerHTML = rooms.map((room) => {
      const id = Number(room.roomId ?? room.id);
      const name = room.name || room.roomName || room.roomCode || `Room ${id}`;
      return `<option value="${id}">${esc(room.roomCode ? `${room.roomCode} - ` : '')}${esc(name)}</option>`;
    }).join('');
    state.roomId = preferred ? Number(preferred.roomId ?? preferred.id) : null;
    if (state.roomId) select.value = String(state.roomId);
    if (!select.dataset.cxBound) {
      select.dataset.cxBound = '1';
      select.addEventListener('change', () => {
        state.roomId = Number(select.value) || null;
        if (state.roomId) localStorage.setItem('campusx_room_id', String(state.roomId));
        refreshCurrentPage();
      });
    }
    if (state.roomId) localStorage.setItem('campusx_room_id', String(state.roomId));
  }

  function roomQuery() { return state.roomId ? `?roomId=${encodeURIComponent(state.roomId)}` : ''; }
  function selectedRoom() { return state.rooms.find((r) => Number(r.roomId ?? r.id) === Number(state.roomId)); }

  async function loadHealth() {
    try { updateSidebarHealth(await get('/health')); }
    catch { updateSidebarHealth({ status: 'offline', database: 'disconnected', mqtt: 'disconnected' }); }
  }

  async function loadDashboard() {
    const [summaryRes, latestRes, alertRes, devicesRes, nodesRes] = await Promise.all([
      get('/dashboard/summary'), get(`/telemetry/latest${roomQuery()}`),
      get(`/alerts?limit=30${state.roomId ? `&roomId=${state.roomId}` : ''}`),
      get(`/devices${state.roomId ? `?roomId=${state.roomId}` : ''}`),
      get(`/nodes${state.roomId ? `?roomId=${state.roomId}` : ''}`),
    ]);
    const summary = summaryRes.data || {};
    state.telemetry = asArray(latestRes);
    state.alerts = asArray(alertRes);
    state.devices = asArray(devicesRes);
    state.nodes = asArray(nodesRes);
    renderCvPeopleFromTelemetry();

    const kpis = $$('.kpi-grid-4 .kpi-card-v2');
    const online = state.devices.filter((d) => d.status === 'online').length;
    const activeAlerts = state.alerts.filter(activeAlert);
    if (kpis[0]) {
      setText($('.val-number', kpis[0]), state.devices.filter((d) => d.isActive !== false).length);
      setText($('.kpi-v2-footer-text', kpis[0]), 'Registered devices in selected view');
      setText($('.kpi-pill-right', kpis[0]), `${online} Online / ${state.devices.length - online} Not Online`);
    }
    if (kpis[1]) {
      setText($('.val-number', kpis[1]), summary.activeRooms ?? state.rooms.length);
      setText($('.kpi-v2-footer-text', kpis[1]), 'Active rooms in CampusX');
      setText($('.kpi-pill-right', kpis[1]), 'Database inventory');
    }
    if (kpis[2]) {
      setText($('.val-number', kpis[2]), summary.openAlerts ?? activeAlerts.length);
      setText($('.kpi-v2-footer-text', kpis[2]), 'Open or acknowledged alerts');
      const critical = activeAlerts.filter((a) => a.severity === 'critical').length;
      const warning = activeAlerts.filter((a) => a.severity === 'warning').length;
      setText($('.kpi-pill-right', kpis[2]), `${critical} Critical · ${warning} Warning`);
    }
    if (kpis[3]) {
      const temperatures = metricRows('temperature');
      const temp = average(temperatures);
      setText($('.val-number', kpis[3]), temp == null ? '—' : `${fmt(temp)}°C`);
      setText($('.kpi-v2-footer-text', kpis[3]), 'Average of latest temperature readings');
      setText($('.kpi-pill-right', kpis[3]), `${temperatures.length} reporting sensor(s)`);
    }

    const room = selectedRoom();
    const banner = $('.lab-overview-banner');
    if (banner) {
      const title = $('.banner-title-group h2', banner);
      if (title) title.innerHTML = `${esc(room?.name || room?.roomName || room?.roomCode || 'Campus')} Overview <span class="primary-zone-tag">Live Zone</span>`;
      const meta = $('.sub-meta', banner);
      if (meta) meta.textContent = `● Live telemetry · Updated ${new Date().toLocaleTimeString()} · Room ${room?.roomCode || state.roomId || 'All'}`;
      const band = $('.normal-band-badge', banner);
      if (band) {
        const critical = activeAlerts.some((a) => a.severity === 'critical');
        band.textContent = critical ? '● Critical Alert Active' : activeAlerts.length ? '● Attention Required' : '● Normal Operational Band';
        band.className = `normal-band-badge ${critical ? 'red-text' : ''}`;
      }
    }

    const grid = $('.lab-metrics-3grid');
    if (grid) {
      const temp = average(metricRows('temperature'));
      const humidity = average(metricRows('humidity'));
      const co2 = average(metricRows('co2_ppm'));
      const people = sum(metricRows('people_count'));
      const cards = [
        ['AMBIENT TEMPERATURE', 'thermometer', temp == null ? '—' : `${fmt(temp)}°C`, 'Latest temperature average', 'Metric: temperature'],
        ['HUMIDITY', 'droplet', humidity == null ? '—' : `${fmt(humidity)}%`, 'Latest humidity average', 'Metric: humidity'],
        ['PEOPLE DETECTED', 'users', people == null ? '—' : `${Math.round(people)} persons`, 'Latest people_count from camera(s)', 'Metric: people_count'],
        ['CO₂ CONCENTRATION', 'wind', co2 == null ? '—' : `${fmt(co2, 0)} ppm`, 'Latest CO₂ average', 'Metric: co2_ppm'],
      ];
      grid.innerHTML = cards.map(([label, icon, value, sub, foot]) => `
        <div class="sub-metric-card">
          <div class="sm-top"><span>${esc(label)}</span><i data-lucide="${icon}"></i></div>
          <div class="sm-value">${esc(value)}</div>
          <span class="sm-sub">${esc(sub)}</span>
          <div class="sm-footer"><small>${esc(foot)}</small><span class="blue-text">Live</span></div>
        </div>`).join('');
    }

    const recent = $('.recent-alerts-list');
    if (recent) {
      const list = activeAlerts.slice(0, 5);
      recent.innerHTML = list.length ? list.map((a) => {
        const sev = String(a.severity || 'info').toLowerCase();
        const cls = sev === 'critical' ? 'red' : sev === 'warning' ? 'purple' : 'blue';
        return `<div class="recent-alert-item ${cls}-border">
          <i data-lucide="${sev === 'critical' ? 'alert-circle' : 'bell-ring'}" class="alert-icon ${cls}-text"></i>
          <div class="alert-content"><div class="alert-top-line"><strong>${esc(a.alertType || a.type || 'Alert')}</strong><span class="time-str">${esc(ago(a.createdAt || a.created_at))}</span></div>
          <p>${esc(a.message || '')} · ${esc(a.deviceCode || a.deviceName || 'Unknown device')}</p></div></div>`;
      }).join('') : '<div class="cx-empty">No active alerts.</div>';
    }

    const nodeFooterValue = $('.node-footer-info strong');
    if (nodeFooterValue) setText(nodeFooterValue, `${summary.readingsLast24Hours ?? 0} telemetry row(s) in last 24h · MQTT`);
    const clusterTag = $('.node-status-right')?.closest('.widget-box')?.querySelector('.cluster-tag');
    if (clusterTag) setText(clusterTag, `${state.nodes.length} Registered Node(s)`);
    const nodeList = $('.nodes-list');
    if (nodeList) {
      nodeList.innerHTML = state.nodes.length ? state.nodes.slice(0, 6).map((n) => {
        const attached = state.devices.filter((d) => Number(d.nodeId) === Number(n.nodeId));
        const onlineCount = attached.filter((d) => d.status === 'online').length;
        const isLive = onlineCount > 0;
        return `<div class="node-row-item"><div class="node-info"><strong>${esc(n.nodeCode)}</strong><small>${esc(n.nodeType || 'Node')} · ${attached.length} device(s) · ${esc(n.roomName || '')}</small></div><div class="node-status-right ${isLive ? 'green-text' : 'blue-text'}"><span>${isLive ? 'Online' : (n.isActive ? 'Awaiting data' : 'Inactive')}</span><small>${esc(ago(n.lastSeenAt))}</small></div></div>`;
      }).join('') : '<div class="cx-empty">No nodes registered in this room.</div>';
    }
    const navBadge = $('.sidebar-nav a[href="alerts.html"] .badge');
    if (navBadge) setText(navBadge, activeAlerts.length);

    await updateTemperatureChart();
    if (window.lucide) window.lucide.createIcons();
  }

  async function updateTemperatureChart() {
    const canvas = $('#dashboardTrendChart');
    if (!canvas || !window.Chart) return;
    const roomQ = state.roomId ? `&roomId=${state.roomId}` : '';
    const response = await get(`/telemetry?metric=temperature&limit=100${roomQ}`);
    const rows = asArray(response).slice().sort((a, b) => new Date(a.recordedAt || a.recorded_at) - new Date(b.recordedAt || b.recorded_at));
    const labels = rows.map((r) => new Date(r.recordedAt || r.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const values = rows.map((r) => Number(valueOf(r)));
    const valid = values.filter(Number.isFinite);
    const badges = $('.min-max-avg-badges');
    if (badges) badges.innerHTML = valid.length ? `<span>Min: ${fmt(Math.min(...valid))}°C</span><span>Avg: ${fmt(valid.reduce((a,b)=>a+b,0)/valid.length)}°C</span><span>Max: ${fmt(Math.max(...valid))}°C</span>` : '<span>No temperature readings yet</span>';
    const ctx = canvas.getContext('2d');
    if (!state.chart) {
      const gradient = ctx.createLinearGradient(0, 0, 0, 180);
      gradient.addColorStop(0, 'rgba(56, 189, 248, 0.30)'); gradient.addColorStop(1, 'rgba(56, 189, 248, 0)');
      state.chart = new Chart(ctx, { type: 'line', data: { labels, datasets: [{ label: 'Temperature °C', data: values, borderColor: '#38bdf8', backgroundColor: gradient, fill: true, tension: 0.35, pointRadius: 2, borderWidth: 2 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', maxTicksLimit: 8 } }, y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e' } } } } });
    } else {
      state.chart.data.labels = labels; state.chart.data.datasets[0].data = values; state.chart.update('none');
    }
  }

  function statusClass(status) {
    const value = String(status || '').toLowerCase();
    return value === 'online' ? 'green' : value === 'offline' || value === 'fault' ? 'red' : 'blue';
  }

  async function loadDevices() {
    const roomQ = state.roomId ? `?roomId=${state.roomId}` : '';
    const [deviceRes, telemetryRes, summaryRes] = await Promise.all([
      get(`/devices${roomQ}`), get(`/telemetry/latest${roomQ}`), get('/dashboard/summary'),
    ]);
    state.devices = asArray(deviceRes); state.telemetry = asArray(telemetryRes);
    const online = state.devices.filter((d) => d.status === 'online').length;
    const active = state.devices.filter((d) => d.isActive !== false).length;
    const offline = state.devices.filter((d) => d.isActive !== false && d.status !== 'online').length;
    const navBadge = $('.sidebar-nav a[href="alerts.html"] .badge');
    if (navBadge) setText(navBadge, summaryRes.data?.openAlerts ?? '—');
    const cards = $$('.kpi-grid-4 .kpi-card-v2');
    if (cards[0]) {
      setText($('.kpi-v2-header span', cards[0]), 'ONLINE DEVICES');
      setText($('.val-number', cards[0]), `${online} / ${active}`);
      setText($('.kpi-v2-footer-text', cards[0]), 'Active devices currently reporting online');
      setText($('.kpi-pill-right', cards[0]), `${active ? fmt(online / active * 100, 1) : '0'}% online`);
    }
    if (cards[1]) {
      setText($('.kpi-v2-header span', cards[1]), 'OFFLINE / NEEDING ATTENTION');
      setText($('.val-number', cards[1]), offline);
      setText($('.kpi-v2-footer-text', cards[1]), 'Active devices not currently online');
      setText($('.kpi-pill-right', cards[1]), 'Live device status');
    }
    if (cards[2]) {
      setText($('.kpi-v2-header span', cards[2]), 'TELEMETRY · LAST 24H');
      setText($('.val-number', cards[2]), summaryRes.data?.readingsLast24Hours ?? '—');
      setText($('.kpi-v2-footer-text', cards[2]), 'Telemetry rows received in the last 24 hours');
      setText($('.kpi-pill-right', cards[2]), 'CampusX SQL Server');
    }
    if (cards[3]) {
      setText($('.kpi-v2-header span', cards[3]), 'ONLINE DEVICE RATIO');
      setText($('.val-number', cards[3]), `${active ? fmt(online / active * 100, 1) : '0'}%`);
      setText($('.kpi-v2-footer-text', cards[3]), 'Online devices divided by active devices');
      setText($('.kpi-pill-right', cards[3]), 'Calculated from device status');
    }
    const subtitle = $('.page-title-banner .subtitle-text');
    if (subtitle) subtitle.textContent = `${state.devices.length} device records · ${online} online · ${offline} needing attention · Live inventory from CampusX`;
    renderDeviceTable();
  }

  function renderDeviceTable() {
    const body = $('.custom-data-table tbody');
    if (!body) return;
    const query = ($('.search-input')?.value || '').trim().toLowerCase();
    let rows = state.devices.filter((d) => {
      const matches = [d.deviceCode, d.name, d.deviceName, d.nodeCode, d.deviceType, d.roomName].join(' ').toLowerCase().includes(query);
      const statusMatch = state.deviceFilter === 'all' || (state.deviceFilter === 'online' ? d.status === 'online' : d.status !== 'online');
      return matches && statusMatch;
    });
    const latestByDevice = new Map();
    state.telemetry.forEach((t) => {
      const id = Number(t.deviceId ?? t.device_id);
      const old = latestByDevice.get(id);
      if (!old || new Date(t.recordedAt || t.recorded_at) > new Date(old.recordedAt || old.recorded_at)) latestByDevice.set(id, t);
    });
    body.innerHTML = rows.length ? rows.map((d) => {
      const status = statusClass(d.status);
      const reading = latestByDevice.get(Number(d.deviceId ?? d.id));
      const v = reading ? `${esc(reading.displayName || reading.metricCode || reading.metric)}: ${esc(valueOf(reading))} ${esc(reading.unit || '')}` : 'No readings';
      const nodeDesc = `${d.nodeCode || 'Node'} · ID ${d.nodeId ?? '—'}`;
      return `<tr class="${status === 'red' ? 'offline-row' : ''}">
        <td><div class="device-cell"><i data-lucide="${d.category === 'actuator' ? 'sliders' : d.category === 'camera' ? 'camera' : 'radio'}" class="dev-icon ${status === 'red' ? 'red-text' : 'blue-text'}"></i><div><strong>${esc(d.name || d.deviceName || d.deviceCode)}</strong><small>${esc(d.deviceCode)} · ${esc(nodeDesc)}</small></div></div></td>
        <td><span class="type-badge">${esc(d.deviceType || d.category || 'Device')}</span></td>
        <td>${esc(d.roomName || '—')}<br><small class="text-muted">Room ${esc(d.roomId ?? '—')}</small></td>
        <td><span class="status-indicator-pill ${status}">● ${esc(d.status || 'unknown')}</span></td>
        <td><strong>${v}</strong></td>
        <td><span class="text-muted">Not reported</span></td>
        <td>${esc(ago(d.lastSeenAt))}</td>
        <td class="text-right"><button class="btn-table-action" data-device-view="${Number(d.deviceId ?? d.id)}">View</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="8" class="cx-empty-cell">No devices match this filter.</td></tr>';
    const pills = $$('.devices-filter .tab-pill, .tab-pills .tab-pill');
    pills.forEach((pill) => {
      const label = pill.textContent.toLowerCase();
      const filter = label.includes('online') ? 'online' : label.includes('offline') ? 'offline' : 'all';
      pill.classList.toggle('active', filter === state.deviceFilter);
      const count = filter === 'all' ? state.devices.length : filter === 'online' ? state.devices.filter((d) => d.status === 'online').length : state.devices.filter((d) => d.status !== 'online').length;
      pill.textContent = `${filter === 'all' ? 'All' : filter[0].toUpperCase() + filter.slice(1)} (${count})`;
    });
    if (window.lucide) window.lucide.createIcons();
  }

  async function showAddDeviceModal() {
    const [nodesRes, typesRes] = await Promise.all([get('/nodes'), get('/device-types')]);
    const nodes = asArray(nodesRes); const types = asArray(typesRes);
    if (!nodes.length || !types.length) throw new Error('Register a Node and Device Type before adding a device.');
    const overlay = document.createElement('div'); overlay.className = 'cx-modal-backdrop';
    overlay.innerHTML = `<form class="cx-modal" id="cx-add-device-form"><div class="cx-modal-head"><h2>Add CampusX Device</h2><button type="button" class="cx-modal-close" aria-label="Close">×</button></div>
      <label>Node<select name="nodeId" required>${nodes.map((n) => `<option value="${n.nodeId}">${esc(n.nodeCode)} · ${esc(n.roomName || '')}</option>`).join('')}</select></label>
      <label>Device type<select name="deviceTypeId" required>${types.map((t) => `<option value="${t.deviceTypeId}">${esc(t.typeName)} (${esc(t.category)})</option>`).join('')}</select></label>
      <label>Device code<input name="deviceCode" required maxlength="100" placeholder="e.g. air-quality-lab-01"></label>
      <label>Device name<input name="deviceName" required maxlength="150" placeholder="Readable device name"></label>
      <div class="cx-modal-actions"><button type="button" class="btn-secondary-sm cx-modal-cancel">Cancel</button><button type="submit" class="btn-primary-sm">Create device</button></div></form>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    $('.cx-modal-close', overlay).addEventListener('click', close);
    $('.cx-modal-cancel', overlay).addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    $('#cx-add-device-form', overlay).addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = new FormData(e.currentTarget);
      const button = $('button[type="submit"]', e.currentTarget); button.disabled = true; button.textContent = 'Creating…';
      try {
        await post('/devices', {
          nodeId: Number(form.get('nodeId')), deviceTypeId: Number(form.get('deviceTypeId')),
          deviceCode: form.get('deviceCode').trim(), deviceName: form.get('deviceName').trim(),
          configJson: { createdFrom: 'CampusX Dashboard' },
        });
        close(); toast('Device registered successfully.', 'success'); await loadDevices();
      } catch (error) { toast(error.message, 'error'); button.disabled = false; button.textContent = 'Create device'; }
    });
  }

  function exportCsv(filename, rows) {
    if (!rows.length) { toast('Nothing to export.', 'info'); return; }
    const keys = Object.keys(rows[0]);
    const csv = [keys.join(','), ...rows.map((row) => keys.map((key) => `"${String(row[key] ?? '').replace(/"/g, '""')}"`).join(','))].join('\r\n');
    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
  }

  async function loadAlerts() {
    const query = state.roomId ? `?roomId=${state.roomId}&limit=200` : '?limit=200';
    state.alerts = asArray(await get(`/alerts${query}`));
    const active = state.alerts.filter(activeAlert);
    const critical = active.filter((a) => a.severity === 'critical');
    const warning = active.filter((a) => a.severity === 'warning');
    const info = active.filter((a) => a.severity === 'info');
    const cards = $$('.kpi-grid-4 .kpi-card-v2');
    const alertKpis = [
      ['CRITICAL ALERTS', critical.length, 'Critical alerts currently open or acknowledged'],
      ['WARNING ALERTS', warning.length, 'Warning alerts currently open or acknowledged'],
      ['INFO ALERTS', info.length, 'Informational alerts currently open or acknowledged'],
      ['RESOLUTION TIME', '—', 'Not calculated by the current Backend API'],
    ];
    alertKpis.forEach(([label, value, description], i) => {
      if (!cards[i]) return;
      setText($('.kpi-v2-header span', cards[i]), label);
      setText($('.val-number', cards[i]), value);
      setText($('.kpi-v2-footer-text', cards[i]), description);
      setText($('.kpi-pill-right', cards[i]), i === 3 ? 'Metric unavailable' : 'Live from SQL Server');
    });
    const badge = $('.page-title-banner .red-pill-badge'); if (badge) setText(badge, `${active.length} ACTIVE ALERTS`);
    const navBadge = $('.sidebar-nav a[href="alerts.html"] .badge'); if (navBadge) setText(navBadge, active.length);
    const pills = $$('.table-toolbar .tab-pill');
    pills.forEach((pill) => {
      const t = pill.textContent.toLowerCase();
      const filter = t.startsWith('critical') ? 'critical' : t.startsWith('warning') ? 'warning' : t.startsWith('info') ? 'info' : 'all';
      pill.dataset.alertFilter = filter;
      const count = filter === 'all' ? state.alerts.length : state.alerts.filter((a) => a.severity === filter).length;
      pill.textContent = `${filter === 'all' ? 'All' : filter[0].toUpperCase() + filter.slice(1)} (${count})`;
    });
    renderAlertsTable();
  }

  function renderAlertsTable() {
    const body = $('.custom-data-table tbody'); if (!body) return;
    let rows = state.alerts;
    if (state.alertFilter !== 'all') rows = rows.filter((a) => a.severity === state.alertFilter);
    const colors = { critical: 'red', warning: 'purple', info: 'blue' };
    body.innerHTML = rows.length ? rows.map((a) => {
      const sev = String(a.severity || 'info').toLowerCase(); const color = colors[sev] || 'blue';
      const status = String(a.status || 'open').toLowerCase();
      const action = status === 'open'
        ? `<button class="btn-table-danger" data-alert-action="acknowledged" data-alert-id="${a.alertId ?? a.id}">Acknowledge</button>`
        : status === 'acknowledged'
          ? `<button class="btn-table-action" data-alert-action="resolved" data-alert-id="${a.alertId ?? a.id}">Resolve</button>`
          : `<span class="text-muted">${esc(status)}</span>`;
      return `<tr class="${sev === 'critical' ? 'critical-row' : ''}">
        <td><span class="severity-pill ${color}">● ${esc(sev.toUpperCase())}</span></td>
        <td><div class="device-cell"><i data-lucide="${sev === 'critical' ? 'alert-circle' : 'bell-ring'}" class="dev-icon ${color}-text"></i><div><strong>${esc(a.alertType || a.type || 'Alert')}</strong><small>${esc(a.deviceCode || a.deviceName || 'CampusX device')}</small></div></div></td>
        <td>${esc(a.roomName || '—')}<br><small class="text-muted">Room ${esc(a.roomId ?? '—')}</small></td>
        <td><strong>${esc(a.message || '')}</strong><br><small class="text-muted">Status: ${esc(status)}</small></td>
        <td>${esc(ago(a.createdAt || a.created_at))}<br><small class="text-muted">${esc(when(a.createdAt || a.created_at))}</small></td>
        <td class="text-right">${action}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="cx-empty-cell">No alerts found.</td></tr>';
    const footer = $('.table-footer-pagination > span'); if (footer) setText(footer, `Showing ${rows.length} alert(s) · Updated from CampusX SQL Server`);
    const pager = $('.pagination-controls'); if (pager) pager.style.display = 'none';
    if (window.lucide) window.lucide.createIcons();
  }

  async function setAlertStatus(id, status) {
    await patch(`/alerts/${encodeURIComponent(id)}`, { status });
    toast(`Alert #${id} ${status}.`, 'success'); await loadAlerts();
  }

  async function loadControlPanel() {
    const roomQ = state.roomId ? `?roomId=${state.roomId}` : '';
    const [latestRes, devicesRes, commandsRes, rulesRes] = await Promise.all([
      get(`/telemetry/latest${roomQ}`), get(`/devices${roomQ}`), get('/commands?limit=8'), get(`/alert-rules${roomQ}`),
    ]);
    state.telemetry = asArray(latestRes); state.devices = asArray(devicesRes); state.commands = asArray(commandsRes);
    const pageStatus = $('.page-title-banner .status-pill-green');
    if (pageStatus) setText(pageStatus, '● CampusX command interface');
    const latencyTag = $('.page-title-banner .latency-tag');
    if (latencyTag) setText(latencyTag, '📡 MQTT device command channel');
    const temps = metricRows('temperature'); const temp = average(temps);
    const tempValue = $('.temp-display-side .big-val'); if (tempValue) setText(tempValue, temp == null ? '—' : `${fmt(temp)}°C`);
    const tempMeta = $('.temp-display-side > span'); if (tempMeta) setText(tempMeta, temps[0] ? `Source: ${temps[0].deviceCode}` : 'No temperature telemetry yet');
    const tempHeaderPill = $('.temp-display-side')?.closest('.ctrl-card')?.querySelector('.pill-badge-green');
    if (tempHeaderPill) setText(tempHeaderPill, '● API CONTROL');
    const people = sum(metricRows('people_count'));
    const room = selectedRoom(); const capacity = Number(room?.capacity) > 0 ? Number(room.capacity) : null;
    const headcount = $('.headcount-num');
    if (headcount) headcount.innerHTML = `${people == null ? '—' : Math.round(people)} <small>${capacity ? `/ ${capacity} Max Persons` : 'persons detected'}</small>`;
    const pct = people != null && capacity ? Math.min(100, people / capacity * 100) : null;
    setText($('.capacity-box strong'), pct == null ? '—' : `${fmt(pct, 0)}%`);
    const fill = $('.occupancy-progress-bar .progress-fill'); if (fill) fill.style.width = `${pct ?? 0}%`;
    const progress = $$('.progress-labels span'); if (progress.length >= 4 && capacity) { setText(progress[3], `${capacity} (Cap)`); }
    const footer = $('.cv-card-footer span'); if (footer) setText(footer, people == null ? 'No occupancy telemetry received yet.' : `${capacity ? `${Math.max(0, capacity - people)} seats remaining` : 'Live occupancy'} · Current count: ${Math.round(people)}`);
    const cvCard = $('.occupancy-body')?.closest('.ctrl-card');
    const cvHeaderPill = cvCard?.querySelector('.pill-badge-blue');
    if (cvHeaderPill) setText(cvHeaderPill, '● MQTT TELEMETRY');
    const cvHeaderDesc = cvCard?.querySelector('.header-title-group p');
    if (cvHeaderDesc) setText(cvHeaderDesc, 'People count received from the registered CampusX camera device');
    if (cvCard && !$('#cx-camera-preview-link')) {
      const link = document.createElement('a'); link.id = 'cx-camera-preview-link'; link.href = 'http://127.0.0.1:5000/';
      link.target = '_blank'; link.rel = 'noopener'; link.className = 'btn-secondary-xs'; link.textContent = 'Open local camera preview';
      $('.cv-card-footer', cvCard)?.appendChild(link);
    }

    const actuators = state.devices.filter((d) => d.category === 'actuator' || /relay|actuator|controller/i.test(d.deviceType || ''));
    const fanSide = $('.fan-actuator-side');
    if (fanSide) {
      let select = $('#cx-actuator-select');
      if (!select) {
        select = document.createElement('select'); select.id = 'cx-actuator-select'; select.className = 'settings-select cx-actuator-select';
        select.setAttribute('aria-label', 'Select actuator');
        const small = $('small', fanSide); small?.insertAdjacentElement('afterend', select);
      }
      select.innerHTML = actuators.map((d) => `<option value="${esc(d.deviceCode)}">${esc(d.deviceName || d.name || d.deviceCode)}</option>`).join('');
      if (actuators.some((d) => d.deviceCode === 'fan-relay-lab-01')) select.value = 'fan-relay-lab-01';
      if (!actuators.length) select.innerHTML = '<option value="">No actuator devices registered</option>';
      if (!select.dataset.cxBound) {
        select.dataset.cxBound = '1';
        select.addEventListener('change', () => { void inferFanStateFromCommands().then(updateFanButton); });
      }
    }
    await inferFanStateFromCommands();
    renderCommands();
    const eepromBadge = $('.ctrl-bottom-grid .eeprom-badge');
    if (eepromBadge) setText(eepromBadge, 'SQL SERVER RULES');
    const actuatorFacts = $('.sub-metrics-3row');
    if (actuatorFacts) actuatorFacts.innerHTML = `<div><small>Actuator</small><strong>${esc($('#cx-actuator-select')?.value || 'Not selected')}</strong></div><div><small>Transport</small><strong>MQTT QoS 1</strong></div><div><small>Last command</small><strong>${esc(state.commands[0]?.status || 'No command')}</strong></div>`;
    renderAlertRules(asArray(rulesRes));
    updateFanButton();
    if (window.lucide) window.lucide.createIcons();
  }

  async function inferFanStateFromCommands() {
    const select = $('#cx-actuator-select'); const code = select?.value;
    const device = state.devices.find((d) => d.deviceCode === code);
    if (!device) return;
    try {
      const commands = asArray(await get(`/commands?deviceId=${device.deviceId}&limit=10`));
      const last = commands.find((c) => c.commandType === 'set_state' || c.type === 'set_state');
      const payload = last?.payload && typeof last.payload === 'object' ? last.payload : {};
      if (last?.status === 'completed' && (payload.state === 'on' || payload.state === 'off')) state.fanState = payload.state;
    } catch { /* read-only status is best effort */ }
  }

  function updateFanButton() {
    const btn = $('.fan-power-btn'); if (!btn) return;
    btn.disabled = state.fanBusy;
    btn.classList.toggle('active', state.fanState === 'on');
    const icon = $('i', btn); if (icon) icon.classList.toggle('spin-icon', state.fanState === 'on');
    const badge = $('.fan-actuator-side .pill-badge-green');
    if (badge) setText(badge, state.fanBusy ? '● COMMAND PENDING' : `● STATE: ${state.fanState.toUpperCase()} (SIMULATED/DEVICE ACK)`);
    const hint = $('.fan-actuator-side .click-hint'); if (hint) setText(hint, state.fanBusy ? 'Waiting for device acknowledgement…' : 'Click to send the opposite relay state');
  }

  async function toggleFan() {
    if (state.fanBusy) return;
    const code = $('#cx-actuator-select')?.value;
    if (!code) { toast('No actuator device is registered for this room.', 'error'); return; }
    const desired = state.fanState === 'on' ? 'off' : 'on';
    state.fanBusy = true; updateFanButton();
    try {
      const response = await post('/commands', { deviceCode: code, commandType: 'set_state', payload: { state: desired } });
      const command = response.data || {};
      toast(`Command #${command.commandId ?? command.id ?? '?'} sent: ${desired.toUpperCase()}. Awaiting device acknowledgement.`, 'success');
      await loadCommandsForPanel();
    } catch (error) { toast(error.message, 'error'); }
    finally { state.fanBusy = false; updateFanButton(); }
  }

  async function loadCommandsForPanel() {
    state.commands = asArray(await get('/commands?limit=8'));
    renderCommands();
  }

  function renderCommands() {
    const box = $('.actuation-stream-box'); if (!box) return;
    box.innerHTML = `<small>RECENT ACTUATION STREAM</small>` + (state.commands.length ? state.commands.slice(0, 6).map((c) => {
      const payload = c.payload && typeof c.payload === 'object' ? JSON.stringify(c.payload) : String(c.payloadJson || '');
      return `<div class="stream-item"><span>● #${esc(c.commandId ?? c.id)} · ${esc(c.deviceCode || '')} · ${esc(c.commandType || c.type)} ${esc(payload)}</span><small>${esc(c.status)} · ${esc(when(c.createdAt || c.created_at))}</small></div>`;
    }).join('') : '<div class="cx-empty">No commands have been issued.</div>');
    const latest = state.commands[0]; const successBox = $('.command-success-box');
    if (successBox) {
      if (latest) successBox.innerHTML = `<i data-lucide="${latest.status === 'completed' ? 'check-circle' : 'clock'}" class="${latest.status === 'completed' ? 'green-text' : 'blue-text'}" style="width:18px;height:18px"></i><div class="cmd-text"><strong>Command #${esc(latest.commandId ?? latest.id)} · ${esc(latest.status)}</strong><p>${esc(latest.deviceCode || '')} · ${esc(latest.commandType || latest.type)} · ${esc(when(latest.completedAt || latest.completed_at || latest.createdAt || latest.created_at))}</p></div><span class="target-node-tag">${esc(latest.status)}</span>`;
      else successBox.textContent = 'No command history yet.';
    }
    if (window.lucide) window.lucide.createIcons();
  }

  function renderAlertRules(rules) {
    const target = $('.threshold-inputs-grid'); if (!target) return;
    const section = target.closest('.ctrl-card');
    const description = section?.querySelector('.card-header-bar p');
    if (description) setText(description, 'Active thresholds loaded from CampusX Alert_Rules');
    const actions = section?.querySelector('.thresh-actions-footer'); if (actions) actions.style.display = 'none';
    target.innerHTML = rules.length ? rules.map((rule) => {
      let config = {}; try { config = typeof rule.configJson === 'string' ? JSON.parse(rule.configJson) : (rule.configJson || {}); } catch { /* ignore */ }
      const severity = config.severity || 'info';
      return `<div class="thresh-box-v2"><div class="thresh-top-line"><small>${esc(rule.metricCode)} · ${esc(severity.toUpperCase())}</small><i data-lucide="shield-alert" class="${severity === 'critical' ? 'red-text' : 'blue-text'}" style="width:14px;height:14px"></i></div><div class="thresh-input-group"><strong>${esc(rule.operator)} ${esc(rule.threshold)}</strong><span>${esc(rule.ruleName)}</span></div><small class="thresh-sub-text">${rule.isEnabled ? 'Enabled' : 'Disabled'} · ${esc(rule.durationSeconds)} sec</small></div>`;
    }).join('') : '<div class="cx-empty">No alert rules configured for this room.</div>';
  }

  async function loadSettings() {
    const [healthRes, sqlRes] = await Promise.allSettled([get('/health'), get('/sqlserver/health')]);
    const health = healthRes.status === 'fulfilled' ? healthRes.value : null;
    const sql = sqlRes.status === 'fulfilled' ? sqlRes.value?.data : null;
    updateSidebarHealth(health);
    const statusPill = $('.status-pill-green');
    if (statusPill) setText(statusPill, health?.status === 'ok' && health?.mqtt === 'connected' ? '● Backend, SQL Server & MQTT Operational' : '● One or more services need attention');

    const settingsCards = $$('.settings-card');
    const systemCard = settingsCards.find((card) => $('h3', card)?.textContent.trim() === 'System Connections');
    if (systemCard) {
      const body = $('.card-body-content', systemCard);
      if (body) body.innerHTML = `
        <div class="connection-row"><div class="conn-info"><i data-lucide="radio" class="conn-icon blue-text"></i><div><div class="conn-title-line"><strong>MQTT Broker</strong><span class="tag-${health?.mqtt === 'connected' ? 'online' : 'connected'}">${health?.mqtt === 'connected' ? 'Connected' : 'Disconnected'}</span></div><p>Configured broker: ${esc(location.hostname)} · Port 1883 · Topic: smart-campus/telemetry</p></div></div><span class="uptime-text">${esc(health?.mqtt || 'unknown')}</span></div>
        <div class="connection-row"><div class="conn-info"><i data-lucide="database" class="conn-icon purple-text"></i><div><div class="conn-title-line"><strong>SQL Server</strong><span class="tag-${health?.database === 'connected' ? 'connected' : 'online'}">${health?.database === 'connected' ? 'Connected' : 'Disconnected'}</span></div><p>${esc(sql?.databaseName || 'CampusX')} · ${esc(sql?.tableCount ?? '—')} tables</p></div></div><span class="uptime-text">${esc(health?.database || 'unknown')}</span></div>
        <div class="connection-row"><div class="conn-info"><i data-lucide="server" class="conn-icon green-text"></i><div><div class="conn-title-line"><strong>CampusX Node.js API</strong><span class="tag-${health?.status === 'ok' ? 'active' : 'online'}">${health?.status === 'ok' ? 'Available' : 'Unavailable'}</span></div><p>${esc(location.origin)} · REST API v1 · Server-Sent Events</p></div></div><span class="uptime-text">${esc(health?.status || 'unknown')}</span></div>
        <div class="card-footer-action"><small>Connection status queried live from CampusX.</small><button class="btn-secondary-sm" id="cx-refresh-health"><i data-lucide="refresh-cw"></i> Refresh Status</button></div>`;
    }

    const securityCard = settingsCards.find((card) => $('h3', card)?.textContent.trim() === 'Security & Privacy');
    if (securityCard) {
      const desc = $('.card-header-bar p', securityCard);
      if (desc) setText(desc, 'Dashboard sign-in and backend API-key protection');
      const badge = $('.sec-badge', securityCard);
      if (badge) setText(badge, 'API KEY GUARD');
      const body = $('.card-body-content', securityCard);
      if (body) body.innerHTML = `<div class="cx-connection-info" style="margin:0"><strong>Backend access model</strong><span>Dashboard origin: ${esc(location.origin)}</span><span>Login: signed HttpOnly cookie session (single operator account)</span><span>Password verification: scrypt hash configured in backend .env</span><span>Session duration: configured by DASHBOARD_SESSION_HOURS</span><span>API_KEY: optional extra API guard; keep HOST=127.0.0.1 during local testing.</span></div><div class="card-footer-action"><small>The dashboard keeps an optional API key only in this browser session. Sign out using the header button.</small><button class="btn-secondary-sm" id="cx-clear-api-key"><i data-lucide="key-round"></i> Clear Session API Key</button></div>`;
    }

    const notificationCard = settingsCards.find((card) => $('h3', card)?.textContent.trim() === 'Notification Preferences');
    if (notificationCard) {
      const desc = $('.card-header-bar p', notificationCard);
      if (desc) setText(desc, 'In-dashboard alert feed is active; email/SMS delivery is not connected.');
      const select = $('select', notificationCard); if (select) select.disabled = true;
    }
    const profileCard = settingsCards.find((card) => $('h3', card)?.textContent.trim() === 'User Profile');
    if (profileCard) {
      const desc = $('.card-header-bar p', profileCard);
      if (desc) setText(desc, 'Local dashboard profile placeholder; user profile storage is not configured.');
      $$('.btn-secondary-sm', profileCard).forEach((button) => { button.disabled = true; button.title = 'User profile API is not configured'; });
    }
    if (!$('#cx-connection-info')) {
      const info = document.createElement('div'); info.id = 'cx-connection-info'; info.className = 'cx-connection-info';
      info.innerHTML = `<strong>Current backend health</strong><span>HTTP API: ${health?.status === 'ok' ? 'Connected' : 'Unavailable'}</span><span>Database: ${esc(sql?.databaseName || health?.database || 'Unavailable')}</span><span>Tables: ${esc(sql?.tableCount ?? '—')}</span><span>MQTT: ${esc(health?.mqtt || 'Unavailable')}</span>`;
      $('.main-content')?.appendChild(info);
    }
    $('#cx-refresh-health')?.addEventListener('click', () => void loadSettings());
    $('#cx-clear-api-key')?.addEventListener('click', () => { sessionStorage.removeItem('campusx_api_key'); toast('Session API key cleared. Reload to enter it again if required.', 'success'); });
    if (window.lucide) window.lucide.createIcons();
  }

  function renderCvPeopleFromTelemetry() {
    const target = $('#cx-cv-people-count');
    if (!target) return;
    const rows = metricRows('people_count');
    const latest = rows.slice().sort((a, b) => {
      const at = new Date(a.recordedAt || a.recorded_at || 0).getTime();
      const bt = new Date(b.recordedAt || b.recorded_at || 0).getTime();
      return bt - at;
    })[0];
    const value = latest ? Number(valueOf(latest)) : NaN;
    setText(target, Number.isFinite(value) ? `${Math.round(value)} person(s)` : 'No reading yet');
  }

  function renderComputerVisionStatus(data) {
    const panel = $('#cx-cv-manager');
    if (!panel) return;
    const cameraRunning = Boolean(data?.camera?.running);
    const bridgeRunning = Boolean(data?.bridge?.running);
    const running = Boolean(data?.running || (cameraRunning && bridgeRunning));
    const partial = Boolean(data?.partiallyRunning || (cameraRunning !== bridgeRunning));
    const badge = $('#cx-cv-state');
    const badgeText = $('#cx-cv-state-text');
    if (badge) {
      badge.classList.toggle('is-running', running);
      badge.classList.toggle('is-stopped', !running && !partial);
      badge.classList.toggle('is-partial', !running && partial);
      badge.classList.remove('is-checking');
    }
    setText(badgeText, running ? 'Running' : partial ? 'Partially running' : 'Stopped');
    setText($('#cx-cv-camera-state'), cameraRunning ? 'Online' : 'Offline');
    setText($('#cx-cv-bridge-state'), bridgeRunning ? 'Running' : 'Stopped / Not managed');

    const cameraCount = data?.camera?.currentPeople;
    if (cameraCount !== null && cameraCount !== undefined && Number.isFinite(Number(cameraCount))) {
      setText($('#cx-cv-people-count'), `${Math.round(Number(cameraCount))} person(s)`);
    }
    const inference = data?.camera?.inferenceMs;
    setText($('#cx-cv-inference'), inference == null ? '—' : `${fmt(inference, 0)} ms`);

    const startButton = $('#cx-cv-start');
    const stopButton = $('#cx-cv-stop');
    const preview = $('#cx-cv-preview');
    if (startButton) startButton.disabled = state.cvBusy || running;
    if (stopButton) stopButton.disabled = state.cvBusy || (!cameraRunning && !bridgeRunning);
    if (preview) {
      preview.href = data?.previewUrl || 'http://127.0.0.1:5000/';
      preview.classList.toggle('is-disabled', !cameraRunning);
      preview.setAttribute('aria-disabled', cameraRunning ? 'false' : 'true');
    }
    const updated = $('#cx-cv-updated');
    if (updated) setText(updated, `Checked ${new Date().toLocaleTimeString()}`);
  }

  async function loadComputerVisionStatus(silent = true) {
    if (!$('#cx-cv-manager')) return;
    try {
      const response = await get('/computer-vision/status');
      renderComputerVisionStatus(response.data || {});
    } catch (error) {
      const badge = $('#cx-cv-state');
      badge?.classList.remove('is-running', 'is-partial', 'is-checking');
      badge?.classList.add('is-stopped');
      setText($('#cx-cv-state-text'), 'Status unavailable');
      setText($('#cx-cv-camera-state'), 'Unknown');
      setText($('#cx-cv-bridge-state'), 'Unknown');
      if (!silent) toast(error.message, 'error');
    }
  }

  async function controlComputerVision(action) {
    if (state.cvBusy) return;
    state.cvBusy = true;
    const startButton = $('#cx-cv-start');
    const stopButton = $('#cx-cv-stop');
    if (startButton) startButton.disabled = true;
    if (stopButton) stopButton.disabled = true;
    setText($('#cx-cv-state-text'), action === 'start' ? 'Starting…' : 'Stopping…');
    try {
      const response = await post(`/computer-vision/${action}`, {});
      toast(response.message || `Computer Vision ${action} request completed.`, 'success');
      renderComputerVisionStatus(response.data || {});
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      state.cvBusy = false;
      await loadComputerVisionStatus(true);
    }
  }

  function bindComputerVisionControls() {
    if (!$('#cx-cv-manager')) return;
    $('#cx-cv-start')?.addEventListener('click', () => void controlComputerVision('start'));
    $('#cx-cv-stop')?.addEventListener('click', () => void controlComputerVision('stop'));
    void loadComputerVisionStatus(false);
    if (state.cvPollTimer) clearInterval(state.cvPollTimer);
    state.cvPollTimer = setInterval(() => void loadComputerVisionStatus(true), 10000);
  }

  async function refreshCurrentPage() {
    await loadHealth();
    const file = location.pathname.split('/').pop().toLowerCase();
    try {
      if (file === 'devices.html') await loadDevices();
      else if (file === 'alerts.html') await loadAlerts();
      else if (file === 'control-panel.html') await loadControlPanel();
      else if (file === 'settings.html') { /* Settings page is managed by settings-account.js (live account/system APIs). */ }
      else if (file === '' || file === 'index.html' || file === 'dashboard') await loadDashboard();
    } catch (error) { toast(error.message, 'error'); console.error('[CampusX Dashboard]', error); }
  }

  function setStreamIndicator(status, label) {
    const header = $('.header-right-group');
    if (!header) return;
    let indicator = $('#cx-stream-status');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'cx-stream-status';
      indicator.className = 'cx-stream-status is-connecting';
      indicator.setAttribute('role', 'status');
      indicator.setAttribute('aria-live', 'polite');
      indicator.innerHTML = '<span class="cx-stream-dot"></span><span class="cx-stream-label"></span>';
      const profile = $('.user-profile', header);
      header.insertBefore(indicator, profile || null);
    }
    indicator.classList.toggle('is-live', status === 'live');
    indicator.classList.toggle('is-offline', status === 'offline');
    indicator.classList.toggle('is-connecting', status === 'connecting');
    const text = $('.cx-stream-label', indicator);
    if (text) text.textContent = label;
  }

  function connectStream() {
    const key = sessionStorage.getItem('campusx_api_key');
    const url = `${API}/stream${key ? `?apiKey=${encodeURIComponent(key)}` : ''}`;
    if (state.eventSource) state.eventSource.close();
    setStreamIndicator('connecting', 'Connecting live data…');
    const source = new EventSource(url); state.eventSource = source;
    source.addEventListener('open', () => {
      document.body.classList.add('cx-stream-connected');
      setStreamIndicator('live', 'Live updates');
    });
    source.addEventListener('error', () => {
      document.body.classList.remove('cx-stream-connected');
      setStreamIndicator('offline', 'Reconnecting…');
      fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' })
        .then((response) => {
          if (!response.ok) location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`);
        })
        .catch(() => {});
    });
    ['telemetry', 'device.status', 'alert', 'command', 'device.state', 'device.created', 'device.updated', 'room.created'].forEach((type) => {
      source.addEventListener(type, (event) => {
        // The SSE event is a low-latency trigger. The page then reloads authoritative values from the API.
        try { JSON.parse(event.data); } catch { /* ignore malformed event */ }
        setStreamIndicator('live', 'Live updates');
        if (state.refreshTimer) clearTimeout(state.refreshTimer);
        state.refreshTimer = setTimeout(() => { void refreshCurrentPage(); }, 500);
      });
    });
  }

  function bindSharedUi() {
    const theme = $('#theme-toggle');
    if (theme) theme.addEventListener('click', () => {
      const root = document.documentElement; root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('campusx_theme', root.dataset.theme);
    });
    const savedTheme = localStorage.getItem('campusx_theme'); if (savedTheme) document.documentElement.dataset.theme = savedTheme;
    const mobile = $('#mobile-menu-btn'); if (mobile) mobile.addEventListener('click', () => $('.sidebar')?.classList.toggle('cx-sidebar-open'));
    $$('.header-right-group .icon-btn').forEach((button) => {
      if (button.id !== 'theme-toggle') button.addEventListener('click', () => { location.href = 'alerts.html'; });
    });
    const alertsBadge = $('.sidebar-nav a[href="alerts.html"] .badge');
    if (alertsBadge) alertsBadge.setAttribute('aria-live', 'polite');
  }

  function bindPageUi() {
    const file = location.pathname.split('/').pop().toLowerCase();
    if (file === 'devices.html') {
      $('.search-input')?.addEventListener('input', renderDeviceTable);
      $$('.tab-pills .tab-pill').forEach((pill) => pill.addEventListener('click', () => {
        const text = pill.textContent.toLowerCase(); state.deviceFilter = text.includes('online') ? 'online' : text.includes('offline') ? 'offline' : 'all'; renderDeviceTable();
      }));
      $('.icon-btn-sm')?.addEventListener('click', () => void loadDevices());
      const add = $('.banner-actions .btn-primary-sm'); if (add) add.addEventListener('click', () => showAddDeviceModal().catch((e) => toast(e.message, 'error')));
      const exportBtn = $('.banner-actions .btn-secondary-sm'); if (exportBtn) exportBtn.addEventListener('click', () => exportCsv('campusx-devices.csv', state.devices));
      $('.custom-data-table tbody')?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-device-view]'); if (!button) return;
        const device = state.devices.find((d) => Number(d.deviceId ?? d.id) === Number(button.dataset.deviceView));
        if (device) toast(`${device.deviceCode} · ${device.status} · ${device.roomName}`, 'info');
      });
    }
    if (file === 'alerts.html') {
      $$('.table-toolbar .tab-pill').forEach((pill) => pill.addEventListener('click', () => { state.alertFilter = pill.dataset.alertFilter || 'all'; $$('.table-toolbar .tab-pill').forEach((p) => p.classList.toggle('active', p === pill)); renderAlertsTable(); }));
      $('.custom-data-table tbody')?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-alert-action]'); if (!button) return;
        button.disabled = true; setAlertStatus(button.dataset.alertId, button.dataset.alertAction).catch((e) => { toast(e.message, 'error'); button.disabled = false; });
      });
      const buttons = $$('.table-toolbar button');
      const exportBtn = buttons.find((b) => b.textContent.toLowerCase().includes('export'));
      if (exportBtn) exportBtn.addEventListener('click', () => exportCsv('campusx-alerts.csv', state.alerts));
      const acknowledgeAll = buttons.find((b) => b.textContent.toLowerCase().includes('mark all'));
      if (acknowledgeAll) acknowledgeAll.addEventListener('click', async () => {
        const pending = state.alerts.filter((a) => a.status === 'open');
        try { await Promise.all(pending.map((a) => patch(`/alerts/${a.alertId ?? a.id}`, { status: 'acknowledged' }))); toast(`${pending.length} alert(s) acknowledged.`, 'success'); await loadAlerts(); }
        catch (e) { toast(e.message, 'error'); }
      });
    }
    if (file === 'control-panel.html') {
      $('.fan-power-btn')?.addEventListener('click', (event) => { event.preventDefault(); void toggleFan(); });
      const capacityButton = $('.cv-card-footer .btn-secondary-xs');
      if (capacityButton) capacityButton.addEventListener('click', async () => {
        const room = selectedRoom();
        if (!room) { toast('Select a room first.', 'error'); return; }
        const current = Number(room.capacity) > 0 ? Number(room.capacity) : '';
        const value = window.prompt(`Set maximum occupancy for ${room.roomCode || room.name}:`, current);
        if (value === null) return;
        const capacity = Number(value);
        if (!Number.isInteger(capacity) || capacity < 1) { toast('Capacity must be a positive whole number.', 'error'); return; }
        try { await patch(`/rooms/${room.roomId ?? room.id}`, { capacity }); toast('Room capacity updated.', 'success'); await loadRooms(); await loadControlPanel(); }
        catch (error) { toast(error.message, 'error'); }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindSharedUi(); bindPageUi();
    try { await loadRooms(); } catch (error) { toast(error.message, 'error'); }
    await refreshCurrentPage();
    bindComputerVisionControls();
    connectStream();
    if (window.lucide) window.lucide.createIcons();
  });
})();
