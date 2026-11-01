(() => {
  'use strict';

  const API = '/api/v1';
  const PAGE_SIZE = 25;
  const state = { page: 1, total: 0, totalPages: 0, status: '', loading: false, apiKeyPrompted: false };
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);

  function valueOf(object, ...names) {
    if (!object) return undefined;
    for (const name of names) {
      if (object[name] !== undefined && object[name] !== null) return object[name];
      const key = Object.keys(object).find((item) => item.toLowerCase() === name.toLowerCase());
      if (key && object[key] !== undefined && object[key] !== null) return object[key];
    }
    return undefined;
  }

  function dateText(value) {
    if (!value) return 'Not available';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString();
  }

  async function request(path, allowPrompt = true) {
    const headers = { Accept: 'application/json' };
    const apiKey = sessionStorage.getItem('campusx_api_key');
    if (apiKey) headers['X-API-Key'] = apiKey;
    const response = await fetch(`${API}${path}`, {
      credentials: 'same-origin', cache: 'no-store', headers,
    });

    if (response.status === 401) {
      const session = await fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
      if (!session || session.status === 401) {
        location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`);
        throw new Error('Your CampusX login session has expired.');
      }
      if (allowPrompt && !apiKey && !state.apiKeyPrompted) {
        state.apiKeyPrompted = true;
        const entered = window.prompt('CampusX API_KEY is enabled. Enter the API key from the server .env file:');
        if (entered && entered.trim()) {
          sessionStorage.setItem('campusx_api_key', entered.trim());
          return request(path, false);
        }
      }
    }

    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `API returned HTTP ${response.status}`);
    return payload;
  }

  function commandDescription(command) {
    const rawPayload = valueOf(command, 'payloadJson', 'payload');
    let payload = rawPayload;
    if (typeof rawPayload === 'string') {
      try { payload = JSON.parse(rawPayload); } catch { payload = {}; }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};

    const type = String(valueOf(command, 'commandType') || '').trim().toLowerCase();
    const state = String(payload.state ?? payload.value ?? '').trim().toLowerCase();
    const deviceLabel = `${valueOf(command, 'deviceName') || ''} ${valueOf(command, 'deviceCode') || ''}`.toLowerCase();
    const isFan = /fan|ventilat|blower/.test(deviceLabel);

    if (type === 'set_state' && state === 'off') return isFan ? 'Fan turned off' : 'Device turned off';
    if (type === 'set_state' && state === 'on') return isFan ? 'Fan turned on' : 'Device turned on';
    if (type === 'set_state' && state) return `Device state set to ${state.toUpperCase()}`;

    const readable = type.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return readable ? readable.charAt(0).toUpperCase() + readable.slice(1) : 'No description available';
  }

  function renderRows(items, offset) {
    const body = $('#history-command-list');
    if (!items.length) {
      body.innerHTML = '<tr><td colspan="6" class="command-audit-empty">No commands match this filter.</td></tr>';
      return;
    }

    body.innerHTML = items.map((command) => {
      const id = valueOf(command, 'commandId') ?? '—';
      const sender = valueOf(command, 'requestedBy') || 'Legacy command (sender not recorded)';
      const deviceCode = valueOf(command, 'deviceCode') || `Device ${valueOf(command, 'deviceId') ?? ''}`;
      const deviceName = valueOf(command, 'deviceName') || deviceCode;
      const roomCode = valueOf(command, 'roomCode') || '';
      const roomName = valueOf(command, 'roomName') || '';
      const destination = [deviceCode, roomCode, roomName].filter(Boolean).join(' · ');
      const type = valueOf(command, 'commandType') || 'Command';
      const description = commandDescription(command);
      const status = String(valueOf(command, 'status') || 'unknown').toLowerCase();
      const safeStatus = /^[a-z_]+$/.test(status) ? status : 'unknown';
      const createdAt = valueOf(command, 'createdAt');
      const completedAt = valueOf(command, 'completedAt');
      const detail = completedAt ? `Finished ${dateText(completedAt)}`
        : (['pending', 'sent'].includes(status) ? 'Awaiting device acknowledgement' : 'No completion time recorded');
      return `<tr data-command-id="${esc(id)}">
        <td data-label="Who sent it"><strong>${esc(sender)}</strong><small>Operator · #${esc(id)}</small></td>
        <td data-label="Sent to"><strong>${esc(deviceName)}</strong><small>${esc(destination || `Device ID ${valueOf(command, 'deviceId') ?? '—'}`)}</small></td>
        <td data-label="Command"><strong>${esc(type)}</strong></td>
        <td data-label="Description"><strong>${esc(description)}</strong></td>
        <td data-label="Sent at"><span>${esc(dateText(createdAt))}</span></td>
        <td data-label="Result"><span class="command-audit-status status-${esc(safeStatus)}">${esc(status.toUpperCase())}</span><small>${esc(detail)}</small></td>
      </tr>`;
    }).join('');
  }

  function renderPagination(itemCount) {
    const offset = (state.page - 1) * PAGE_SIZE;
    const first = state.total ? offset + 1 : 0;
    const last = Math.min(offset + itemCount, state.total);
    $('#history-total').textContent = `${state.total.toLocaleString()} command(s) found`;
    $('#history-page-summary').textContent = `Showing ${first.toLocaleString()}–${last.toLocaleString()} · Page ${state.page} of ${Math.max(1, state.totalPages)}`;
    $('#history-prev').disabled = state.loading || state.page <= 1;
    $('#history-next').disabled = state.loading || state.page >= state.totalPages;
  }

  async function loadPage() {
    if (state.loading) return;
    state.loading = true;
    $('#history-connection-status').textContent = '● LOADING';
    $('#history-prev').disabled = true;
    $('#history-next').disabled = true;
    $('#history-command-list').innerHTML = '<tr><td colspan="6" class="command-audit-empty">Loading commands…</td></tr>';

    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((state.page - 1) * PAGE_SIZE) });
      if (state.status) params.set('status', state.status);
      const result = await request(`/commands?${params.toString()}`);
      const items = Array.isArray(result.data) ? result.data : (Array.isArray(result) ? result : []);
      state.total = Number(result.total ?? items.length);
      state.totalPages = Math.ceil(state.total / PAGE_SIZE);
      renderRows(items, (state.page - 1) * PAGE_SIZE);
      $('#history-connection-status').textContent = '● DATABASE CONNECTED';
      renderPagination(items.length);
    } catch (error) {
      console.error('[CampusX Command History]', error);
      $('#history-command-list').innerHTML = `<tr><td colspan="6" class="command-audit-empty">Unable to load command history: ${esc(error.message)}</td></tr>`;
      $('#history-total').textContent = 'Command history unavailable';
      $('#history-page-summary').textContent = 'Check the Backend connection and try again.';
      $('#history-connection-status').textContent = '● ERROR';
      $('#history-prev').disabled = true;
      $('#history-next').disabled = true;
    } finally {
      state.loading = false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#history-status-filter').addEventListener('change', (event) => {
      state.status = event.target.value;
      state.page = 1;
      loadPage();
    });
    $('#history-prev').addEventListener('click', () => {
      if (state.page > 1) { state.page -= 1; loadPage(); }
    });
    $('#history-next').addEventListener('click', () => {
      if (state.page < state.totalPages) { state.page += 1; loadPage(); }
    });
    const mobile = $('#mobile-menu-btn');
    mobile?.addEventListener('click', () => document.querySelector('.sidebar')?.classList.toggle('mobile-open'));
    loadPage();
  });
})();
