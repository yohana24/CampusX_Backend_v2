(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const API = '/api/v1';
  const state = {
    account: null,
    session: null,
    health: null,
    rooms: [],
    devices: [],
    nodes: [],
    alerts: [],
    metrics: [],
    rules: [],
    latest: [],
    eventSource: null,
    pollTimer: null,
    refreshTimer: null,
  };

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null || value === '' ? '—' : String(value);
  }

  function setBadge(id, label, kind = 'neutral') {
    const el = $(id);
    if (!el) return;
    el.textContent = label;
    el.classList.remove('is-live', 'is-error', 'is-pending', 'is-neutral');
    el.classList.add(kind === 'live' ? 'is-live' : kind === 'error' ? 'is-error' : kind === 'pending' ? 'is-pending' : 'is-neutral');
  }

  function unwrap(body) {
    if (body && Object.prototype.hasOwnProperty.call(body, 'data')) return body.data;
    if (body && Object.prototype.hasOwnProperty.call(body, 'account')) return body.account;
    return body;
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`);
      throw new Error('Your session expired. Please sign in again.');
    }
    if (!response.ok) {
      const error = body?.error?.message || body?.message || `Request failed (${response.status})`;
      const ex = new Error(error);
      ex.status = response.status;
      ex.code = body?.error?.code;
      throw ex;
    }
    return body;
  }

  function initials(name) {
    const value = String(name || 'CX').trim();
    const parts = value.split(/[._@\s-]+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : value.slice(0, 2)).toUpperCase();
  }

  function dateText(value) {
    if (!value) return 'Not available';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString();
  }

  function remainingText(value) {
    if (!value) return 'Not available';
    const ms = new Date(value).getTime() - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return 'Expired';
    const mins = Math.floor(ms / 60000);
    const hours = Math.floor(mins / 60);
    return hours ? `${hours}h ${mins % 60}m remaining` : `${mins}m remaining`;
  }

  function renderAccount(account, session) {
    state.account = account;
    state.session = session;
    const username = account.username || session?.user?.username || 'CampusX Operator';
    const email = account.email || '';
    const verified = Boolean(account.emailVerified);
    const pending = account.pendingEmail || '';

    setText('cx-account-avatar', initials(username));
    setText('cx-account-title', username);
    setText('cx-account-email', verified ? email : (email ? `${email} (not verified)` : 'No verified email connected'));
    setText('cx-account-email-status', verified ? 'Email address verified' : pending ? `Verification pending for ${pending}` : 'No verified email connected');
    if ($('cx-account-username')) $('cx-account-username').value = username;
    if ($('cx-account-email-field')) $('cx-account-email-field').value = verified ? email : (pending ? `Pending: ${pending}` : 'Not connected');
    if ($('cx-account-id-role')) $('cx-account-id-role').value = `${account.accountCode || `CX-${account.accountId || '—'}`} · CampusX Operator · Single account`;
    setText('cx-account-updated', `Last updated: ${dateText(account.updatedAt)} · Last login: ${dateText(account.lastLoginAt)}`);
    setText('cx-header-username', username);
    setText('cx-header-role', 'CampusX Operator');
    if ($('cx-edit-username')) $('cx-edit-username').value = username;
    if ($('cx-new-email')) $('cx-new-email').value = pending || email || '';
    setText('cx-auth-session-info', `Session expires: ${dateText(session?.expiresAt || account.sessionExpiresAt)} · ${remainingText(session?.expiresAt || account.sessionExpiresAt)}`);
    setText('cx-auth-last-login', `Last login: ${dateText(account.lastLoginAt)}`);
    setText('cx-auth-email-security', verified ? `Account email ${email} is verified.` : 'Account email is not verified.');
    setText('cx-auth-method', 'Authenticated by CampusX Backend using a server-side password hash and signed HttpOnly session cookie.');
    setBadge('cx-auth-level', 'Session Active', 'live');
    setText('cx-email-channel-detail', verified ? `Verified destination: ${email}` : pending ? `Verification pending: ${pending}` : 'No verified email is connected to this account.');
    setBadge('cx-email-channel-status', verified ? 'Verified' : pending ? 'Pending' : 'Not connected', verified ? 'live' : 'neutral');
    setBadge('cx-notification-summary', verified ? 'Email destination verified' : 'Email not verified', verified ? 'live' : 'neutral');
  }

  async function loadAccount() {
    const [accountBody, sessionBody] = await Promise.all([
      request('/auth/account'),
      request('/auth/session'),
    ]);
    const account = accountBody.account || unwrap(accountBody);
    if (!account || !account.username) throw new Error('The account endpoint did not return an account username.');
    renderAccount(account, sessionBody);
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.data)) return value.data;
    if (Array.isArray(value?.items)) return value.items;
    return [];
  }

  function rowStatus(value) {
    return String(value || '').toLowerCase() === 'connected' || String(value || '').toLowerCase() === 'ok' || String(value || '').toLowerCase() === 'online';
  }

  function renderSystem(health, summary, rooms, devices, nodes, alerts, metrics, rules, latest) {
    state.health = health;
    state.rooms = rooms; state.devices = devices; state.nodes = nodes;
    state.alerts = alerts; state.metrics = metrics; state.rules = rules; state.latest = latest;

    const apiOnline = health?.status === 'ok';
    const dbOnline = health?.database === 'connected';
    const mqttOnline = health?.mqtt === 'connected';

    setBadge('cx-api-status', apiOnline ? 'Online' : 'Degraded', apiOnline ? 'live' : 'error');
    setText('cx-api-detail', apiOnline ? `CampusX Backend v1 responding at ${location.host}.` : 'Backend health reports a degraded state.');
    setText('cx-api-time', `Checked ${new Date().toLocaleTimeString()}`);
    setBadge('cx-db-status', dbOnline ? 'Connected' : 'Disconnected', dbOnline ? 'live' : 'error');
    setText('cx-db-detail', `Database: ${health?.database || 'unknown'} · SQL Server health is reported by the Backend.`);
    setText('cx-db-time', `${rooms.length} rooms · ${devices.length} devices`);
    setBadge('cx-mqtt-status', mqttOnline ? 'Connected' : 'Disconnected', mqttOnline ? 'live' : 'error');
    setText('cx-mqtt-detail', `MQTT client: ${health?.mqtt || 'unknown'} · Broker connectivity is read from /api/v1/health.`);
    setText('cx-mqtt-time', `${nodes.length} nodes registered`);

    const cvDevice = devices.find((d) => String(d.deviceCode || d.DeviceCode || '').toLowerCase() === 'people-counter-lab-01');
    const cvReading = latest.find((x) => String(x.metricCode || x.metric || '').toLowerCase() === 'people_count' && String(x.deviceCode || '').toLowerCase() === 'people-counter-lab-01');
    let cvState = 'Not registered';
    let cvKind = 'neutral';
    let cvDetail = 'people-counter-lab-01 was not found in the registered devices.';
    let cvTime = '—';
    if (cvDevice) {
      if (cvReading) {
        const recorded = new Date(cvReading.recordedAt || cvReading.recorded_at || cvReading.receivedAt || cvReading.received_at);
        const ageMs = Date.now() - recorded.getTime();
        const fresh = Number.isFinite(ageMs) && ageMs <= 60000;
        cvState = fresh ? 'Receiving data' : 'No recent data';
        cvKind = fresh ? 'live' : 'pending';
        const count = cvReading.value ?? cvReading.valueNumeric ?? cvReading.value_numeric ?? '—';
        cvDetail = `Latest people_count: ${count} persons · ${dateText(cvReading.recordedAt || cvReading.recorded_at)}`;
        cvTime = fresh ? `${Math.max(0, Math.floor(ageMs / 1000))}s ago` : dateText(cvReading.recordedAt || cvReading.recorded_at);
      } else {
        cvState = 'Registered · waiting'; cvKind = 'pending'; cvDetail = 'The People Counter is registered, but no people_count reading is currently returned by telemetry/latest.';
      }
    }
    setBadge('cx-cv-status', cvState, cvKind);
    setText('cx-cv-detail', cvDetail);
    setText('cx-cv-time', cvTime);

    const onlineDevices = devices.filter((d) => String(d.status || d.Status || '').toLowerCase() === 'online').length;
    const openAlerts = alerts.filter((a) => ['open', 'acknowledged'].includes(String(a.status || '').toLowerCase())).length;
    setText('cx-nav-alert-count', openAlerts);
    setText('cx-alert-channel-detail', `${openAlerts} active alert(s) · ${alerts.length} alert record(s) loaded from SQL Server.`);

    setText('cx-side-api-status', apiOnline ? '● Live' : '● Degraded');
    setText('cx-side-db-status', dbOnline ? '● Active' : '● Offline');
    setText('cx-side-mqtt-status', mqttOnline ? '● Online' : '● Offline');
    ['cx-side-api-status', 'cx-side-db-status', 'cx-side-mqtt-status'].forEach((id) => {
      const el = $(id);
      if (el) {
        el.classList.remove('cx-status-live', 'cx-status-error');
        el.classList.add((id === 'cx-side-api-status' ? apiOnline : id === 'cx-side-db-status' ? dbOnline : mqttOnline) ? 'cx-status-live' : 'cx-status-error');
      }
    });

    const serviceCount = [apiOnline, dbOnline, mqttOnline].filter(Boolean).length;
    setText('cx-service-summary', `${serviceCount}/3 core services online`);
    setText('cx-settings-live-state', `Live data connected · ${onlineDevices}/${devices.length} devices online`);
    setText('cx-system-updated', `Last refreshed: ${new Date().toLocaleString()} · ${rooms.length} rooms · ${devices.length} devices · ${metrics.length} metrics · ${rules.length} alert rules`);
  }

  async function loadSystem() {
    const endpoints = [
      ['/api/v1/health', 'health'],
      ['/api/v1/dashboard/summary', 'summary'],
      ['/api/v1/rooms', 'rooms'],
      ['/api/v1/devices', 'devices'],
      ['/api/v1/nodes', 'nodes'],
      ['/api/v1/alerts?limit=200', 'alerts'],
      ['/api/v1/metrics', 'metrics'],
      ['/api/v1/alert-rules', 'rules'],
      ['/api/v1/telemetry/latest', 'latest'],
    ];
    const results = await Promise.all(endpoints.map(async ([url, key]) => {
      try { return [key, await request(url)]; }
      catch (error) { console.warn(`[CampusX Settings] ${url}: ${error.message}`); return [key, null]; }
    }));
    const data = Object.fromEntries(results);
    const summary = unwrap(data.summary) || {};
    renderSystem(
      unwrap(data.health) || {},
      summary,
      asArray(data.rooms?.data ?? data.rooms),
      asArray(data.devices?.data ?? data.devices),
      asArray(data.nodes?.data ?? data.nodes),
      asArray(data.alerts?.data ?? data.alerts),
      asArray(data.metrics?.data ?? data.metrics),
      asArray(data.rules?.data ?? data.rules),
      asArray(data.latest?.data ?? data.latest),
    );
  }

  async function refreshAll() {
    const refresh = $('cx-refresh-system');
    if (refresh) refresh.disabled = true;
    try {
      await Promise.all([loadAccount(), loadSystem()]);
      setText('cx-settings-live-state', 'Connected to CampusX · Live system data loaded');
    } catch (error) {
      console.error('[CampusX Settings] Refresh failed:', error);
      setText('cx-settings-live-state', `Refresh issue: ${error.message}`);
    } finally {
      if (refresh) refresh.disabled = false;
    }
  }

  function setFormMessage(id, text, kind = '') {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('is-success', 'is-error');
    if (kind) el.classList.add(kind === 'success' ? 'is-success' : 'is-error');
  }

  function bindAccountForms() {
    const details = $('cx-account-editor');
    const close = $('cx-account-close');
    const cancel = $('cx-cancel-credentials');
    if (close) close.addEventListener('click', () => { if (details) details.open = false; });
    if (cancel) cancel.addEventListener('click', () => { if (details) details.open = false; });

    const credentials = $('cx-credentials-form');
    if (credentials) credentials.addEventListener('submit', async (event) => {
      event.preventDefault();
      const save = $('cx-save-credentials');
      const currentPassword = $('cx-current-password')?.value || '';
      const username = $('cx-edit-username')?.value.trim() || '';
      const newPassword = $('cx-new-password')?.value || '';
      const confirmPassword = $('cx-confirm-password')?.value || '';
      if (newPassword && newPassword !== confirmPassword) {
        setFormMessage('cx-credentials-message', 'New password and confirmation do not match.', 'error');
        return;
      }
      if (newPassword && newPassword.length < 12) {
        setFormMessage('cx-credentials-message', 'New password must contain at least 12 characters.', 'error');
        return;
      }
      if (!currentPassword) {
        setFormMessage('cx-credentials-message', 'Enter your current password to confirm this change.', 'error');
        return;
      }
      if (save) save.disabled = true;
      setFormMessage('cx-credentials-message', 'Saving account changes…');
      try {
        const result = await request('/auth/account/credentials', {
          method: 'PATCH',
          body: JSON.stringify({ currentPassword, username, ...(newPassword ? { newPassword } : {}) }),
        });
        if ($('cx-current-password')) $('cx-current-password').value = '';
        if ($('cx-new-password')) $('cx-new-password').value = '';
        if ($('cx-confirm-password')) $('cx-confirm-password').value = '';
        setFormMessage('cx-credentials-message', result.message || 'Account updated successfully. Your session has been renewed.', 'success');
        await loadAccount();
        setText('cx-header-username', result.user?.username || username);
      } catch (error) {
        setFormMessage('cx-credentials-message', error.message, 'error');
      } finally {
        if (save) save.disabled = false;
      }
    });

    const emailForm = $('cx-email-form');
    if (emailForm) emailForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const send = $('cx-send-verification');
      const email = $('cx-new-email')?.value.trim() || '';
      const currentPassword = $('cx-email-current-password')?.value || '';
      if (send) send.disabled = true;
      setFormMessage('cx-email-message', 'Requesting email verification…');
      try {
        const result = await request('/auth/account/email/request', {
          method: 'POST', body: JSON.stringify({ email, currentPassword }),
        });
        if ($('cx-email-current-password')) $('cx-email-current-password').value = '';
        setFormMessage('cx-email-message', result.message || 'Verification email requested. Check the target inbox.', 'success');
        await loadAccount();
      } catch (error) {
        const hint = error.code === 'SMTP_NOT_CONFIGURED' ? ' SMTP is not configured on this server yet.' : '';
        setFormMessage('cx-email-message', `${error.message}${hint}`, 'error');
      } finally {
        if (send) send.disabled = false;
      }
    });
  }

  function connectSse() {
    if (!window.EventSource) {
      setText('cx-settings-live-state', 'Live stream is not supported by this browser; polling remains active.');
      return;
    }
    try {
      const source = new EventSource(`${API}/stream`, { withCredentials: true });
      state.eventSource = source;
      source.addEventListener('open', () => {
        const el = $('cx-settings-live-state');
        if (el) el.textContent = 'Live stream connected · CampusX events enabled';
      });
      source.addEventListener('error', () => {
        const el = $('cx-settings-live-state');
        if (el) el.textContent = 'Live stream reconnecting · automatic refresh remains active';
      });
      ['telemetry', 'device.status', 'alert', 'command', 'device.state', 'device.created', 'device.updated', 'room.created'].forEach((type) => {
        source.addEventListener(type, () => {
          if (state.refreshTimer) clearTimeout(state.refreshTimer);
          state.refreshTimer = setTimeout(() => { void loadSystem(); }, 350);
        });
      });
    } catch (error) {
      console.warn('[CampusX Settings] SSE could not be started:', error);
    }
  }

  function init() {
    bindAccountForms();
    $('cx-refresh-system')?.addEventListener('click', () => void refreshAll());
    $('cx-theme-toggle')?.addEventListener('click', () => {
      document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('campusx_theme', document.documentElement.dataset.theme);
    });
    const savedTheme = localStorage.getItem('campusx_theme');
    if (savedTheme) document.documentElement.dataset.theme = savedTheme;
    const menu = $('mobile-menu-btn');
    menu?.addEventListener('click', () => document.querySelector('.sidebar')?.classList.toggle('cx-sidebar-open'));

    void refreshAll();
    connectSse();
    state.pollTimer = setInterval(() => { void refreshAll(); }, 20000);
    window.addEventListener('beforeunload', () => {
      if (state.eventSource) state.eventSource.close();
      if (state.pollTimer) clearInterval(state.pollTimer);
      if (state.refreshTimer) clearTimeout(state.refreshTimer);
    });
    if (window.lucide) window.lucide.createIcons();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
