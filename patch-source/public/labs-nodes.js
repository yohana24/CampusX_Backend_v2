(() => {
  'use strict';

  const API = '/api/v1';
  const $ = (selector, root = document) => root.querySelector(selector);
  const cache = { types: null, typePromise: null, roomId: null, requestId: 0 };

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const pick = (obj, ...names) => {
    if (!obj) return undefined;
    for (const name of names) {
      if (obj[name] !== undefined && obj[name] !== null) return obj[name];
      const found = Object.keys(obj).find((key) => key.toLowerCase() === name.toLowerCase());
      if (found && obj[found] !== undefined && obj[found] !== null) return obj[found];
    }
    return undefined;
  };
  const rows = (payload) => Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const formatAge = (value) => {
    if (!value) return 'Never seen';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Time unavailable';
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  async function api(path, options = {}, retry = true) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    const key = sessionStorage.getItem('campusx_api_key');
    if (key) headers['X-API-Key'] = key;
    if (options.body && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${API}${path}`, {
      ...options,
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
    if (response.status === 403 && retry && !key) {
      const entered = window.prompt('Enter the CampusX API key from the server .env file:');
      if (entered?.trim()) {
        sessionStorage.setItem('campusx_api_key', entered.trim());
        return api(path, options, false);
      }
    }
    if (!response.ok || payload?.status === 'error') {
      throw new Error(payload?.error?.message || payload?.message || `Request failed (${response.status})`);
    }
    return payload;
  }

  async function getNodeTypes() {
    if (Array.isArray(cache.types)) return cache.types;
    if (!cache.typePromise) {
      cache.typePromise = api('/node-types').then((payload) => {
        cache.types = rows(payload);
        return cache.types;
      }).finally(() => { cache.typePromise = null; });
    }
    return cache.typePromise;
  }

  function panelMarkup(roomId) {
    return `<section class="labs-detail-section labs-nodes-section" id="labs-nodes-section" data-room-id="${roomId}">
      <div class="labs-nodes-heading">
        <h4><i data-lucide="network"></i> Nodes <span class="labs-nodes-count" id="labs-nodes-count">Loading…</span></h4>
        <button class="labs-node-add-button" type="button" data-node-add><i data-lucide="plus"></i><span>Add Node</span></button>
      </div>
      <div class="labs-nodes-list" id="labs-nodes-list"><div class="labs-nodes-loading">Loading room nodes…</div></div>
      <form class="labs-node-form" id="labs-node-form" data-node-form hidden>
        <div class="labs-node-form-title"><strong>Register a controller / host</strong><small>This Node will be assigned to this laboratory.</small></div>
        <div class="labs-node-fields">
          <label><span>Node code <b>*</b></span><input name="nodeCode" type="text" maxlength="100" placeholder="e.g. esp32-lab-02" required autocomplete="off"></label>
          <label><span>Node type <b>*</b></span><select name="nodeTypeId" id="labs-node-type" required><option value="">Loading node types…</option></select></label>
          <label><span>Firmware version</span><input name="firmwareVersion" type="text" maxlength="100" placeholder="e.g. 1.0.0" autocomplete="off"></label>
        </div>
        <div class="labs-node-form-footer">
          <span class="labs-node-form-hint">A Node is a controller or host (ESP32, Raspberry Pi, or CV computer).</span>
          <div class="labs-node-form-actions"><button type="button" class="labs-node-cancel" data-node-cancel>Cancel</button><button type="submit" class="labs-node-save" id="labs-node-save">Create Node</button></div>
        </div>
        <div class="labs-node-feedback" id="labs-node-feedback" role="status" aria-live="polite" hidden></div>
      </form>
    </section>`;
  }

  function injectNodesPanel() {
    const detail = $('#lab-details .labs-detail-panel');
    if (!detail) return;
    const roomId = Number(detail.dataset.roomId);
    if (!Number.isInteger(roomId) || roomId < 1) return;
    const current = $('#labs-nodes-section', detail);
    if (current && Number(current.dataset.roomId) === roomId) return;
    if (current) current.remove();
    const actions = $('.labs-detail-actions', detail);
    if (!actions) return;
    actions.insertAdjacentHTML('afterend', panelMarkup(roomId));
    loadNodes(roomId);
    window.lucide?.createIcons?.();
  }

  function nodeMarkup(node, deviceCount) {
    const active = Boolean(pick(node, 'isActive'));
    const code = pick(node, 'nodeCode') || 'Unknown node';
    const type = pick(node, 'nodeType', 'typeName') || 'Node';
    const firmware = pick(node, 'firmwareVersion');
    const lastSeen = pick(node, 'lastSeenAt');
    return `<article class="labs-node-row">
      <span class="labs-node-icon"><i data-lucide="cpu"></i></span>
      <div class="labs-node-main"><strong>${esc(code)}</strong><small>${esc(type)}${firmware ? ` · Firmware ${esc(firmware)}` : ''}</small><small>${deviceCount} ${deviceCount === 1 ? 'device' : 'devices'} · Last seen ${esc(formatAge(lastSeen))}</small></div>
      <span class="labs-node-status ${active ? 'active' : 'inactive'}">${active ? 'Active' : 'Inactive'}</span>
    </article>`;
  }

  async function loadNodes(roomId) {
    const requestId = ++cache.requestId;
    const section = $('#labs-nodes-section');
    if (!section || Number(section.dataset.roomId) !== roomId) return;
    const list = $('#labs-nodes-list', section);
    const count = $('#labs-nodes-count', section);
    if (!list || !count) return;
    list.innerHTML = '<div class="labs-nodes-loading">Loading room nodes…</div>';
    try {
      const [nodePayload, devicePayload, types] = await Promise.all([
        api(`/nodes?roomId=${encodeURIComponent(roomId)}`),
        api(`/devices?roomId=${encodeURIComponent(roomId)}`),
        getNodeTypes(),
      ]);
      if (requestId !== cache.requestId || !$('#labs-nodes-section') || Number($('#labs-nodes-section').dataset.roomId) !== roomId) return;
      const nodes = rows(nodePayload);
      const devices = rows(devicePayload);
      count.textContent = `${nodes.length} ${nodes.length === 1 ? 'registered' : 'registered'}`;
      list.innerHTML = nodes.length
        ? nodes.map((node) => {
            const nodeId = Number(pick(node, 'nodeId', 'id'));
            const deviceCount = devices.filter((device) => Number(pick(device, 'nodeId')) === nodeId).length;
            return nodeMarkup(node, deviceCount);
          }).join('')
        : '<div class="labs-nodes-empty">No Nodes registered in this lab yet. Add an ESP32, Raspberry Pi, or Computer Vision host.</div>';
      fillNodeTypes(types);
      window.lucide?.createIcons?.();
    } catch (error) {
      if (requestId !== cache.requestId) return;
      count.textContent = 'Unavailable';
      list.innerHTML = `<div class="labs-nodes-error">Could not load Nodes: ${esc(error.message)}</div>`;
    }
  }

  function fillNodeTypes(types) {
    const select = $('#labs-node-type');
    if (!select) return;
    if (!types.length) {
      select.innerHTML = '<option value="">No Node Types configured</option>';
      select.disabled = true;
      const hint = $('.labs-node-form-hint');
      if (hint) hint.textContent = 'No Node Types exist in dbo.Node_Types. Add a type first, then return here.';
      $('#labs-node-save').disabled = true;
      return;
    }
    select.disabled = false;
    $('#labs-node-save').disabled = false;
    select.innerHTML = '<option value="">Select node type…</option>' + types.map((type) => {
      const id = Number(pick(type, 'nodeTypeId', 'id'));
      return `<option value="${id}">${esc(pick(type, 'typeName', 'name'))}</option>`;
    }).join('');
  }

  function showFeedback(message, kind = 'info') {
    const feedback = $('#labs-node-feedback');
    if (!feedback) return;
    feedback.hidden = !message;
    feedback.className = `labs-node-feedback ${kind}`;
    feedback.textContent = message || '';
  }

  async function submitNode(event) {
    const form = event.target.closest('[data-node-form]');
    if (!form) return;
    event.preventDefault();
    const section = form.closest('.labs-nodes-section');
    const roomId = Number(section?.dataset.roomId);
    const codeInput = form.elements.nodeCode;
    const nodeCode = codeInput.value.trim().toLowerCase().replace(/\s+/g, '-');
    const nodeTypeId = Number(form.elements.nodeTypeId.value);
    const firmwareVersion = form.elements.firmwareVersion.value.trim();
    const button = $('#labs-node-save', form);
    if (!roomId || !nodeCode || !Number.isInteger(nodeTypeId) || nodeTypeId < 1) {
      showFeedback('Enter a Node code and choose a Node type.', 'error');
      return;
    }
    button.disabled = true;
    button.textContent = 'Saving…';
    showFeedback('Registering Node in CampusX…', 'info');
    try {
      const payload = await api('/nodes', {
        method: 'POST',
        body: JSON.stringify({
          roomId,
          nodeTypeId,
          nodeCode,
          firmwareVersion: firmwareVersion || null,
          configJson: { createdFrom: 'labs-page' },
        }),
      });
      const created = payload?.data || payload;
      const savedCode = pick(created, 'nodeCode') || nodeCode;
      form.reset();
      showFeedback(`${savedCode} was successfully registered in this lab. You can now add Devices under this Node.`, 'success');
      await loadNodes(roomId);
      const refreshedSection = $('#labs-nodes-section');
      const feedbackAfterRefresh = $('#labs-node-feedback', refreshedSection || document);
      if (feedbackAfterRefresh) {
        feedbackAfterRefresh.hidden = false;
        feedbackAfterRefresh.className = 'labs-node-feedback success';
        feedbackAfterRefresh.textContent = `${savedCode} was successfully registered in this lab. You can now add Devices under this Node.`;
      }
      const openForm = $('#labs-node-form');
      if (openForm) openForm.hidden = true;
    } catch (error) {
      showFeedback(error.message || 'Could not create Node.', 'error');
    } finally {
      const currentButton = $('#labs-node-save');
      if (currentButton) {
        currentButton.disabled = false;
        currentButton.textContent = 'Create Node';
      }
    }
  }

  document.addEventListener('click', (event) => {
    const add = event.target.closest('[data-node-add]');
    if (add) {
      const form = $('#labs-node-form');
      if (form) {
        form.hidden = !form.hidden;
        if (!form.hidden) $('#labs-node-form input[name="nodeCode"]')?.focus();
      }
      return;
    }
    if (event.target.closest('[data-node-cancel]')) {
      const form = $('#labs-node-form');
      if (form) form.hidden = true;
    }
  });
  document.addEventListener('submit', submitNode);

  document.addEventListener('DOMContentLoaded', () => {
    const detailHost = $('#lab-details');
    if (!detailHost) return;
    const observer = new MutationObserver(() => injectNodesPanel());
    observer.observe(detailHost, { childList: true, subtree: true });
    injectNodesPanel();
  });
})();
