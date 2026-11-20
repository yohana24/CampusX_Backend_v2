(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const modal = $('#admin-modal');
  const form = $('#admin-edit-form');
  let editingId = null;
  let accounts = [];

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  function showError(message) {
    const box = $('#admin-error');
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
  }

  function showFormError(message) {
    const box = $('#admin-form-error');
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.status !== 'ok') {
      throw new Error(payload?.error?.message || `Request failed (HTTP ${response.status})`);
    }
    return payload;
  }

  function render(list) {
    const body = $('#admin-accounts-body');
    const count = $('#admin-account-count');
    if (!body) return;
    accounts = list;
    count.textContent = `${accounts.length} account${accounts.length === 1 ? '' : 's'} in dbo.DashboardAccounts`;
    if (!accounts.length) {
      body.innerHTML = '<tr><td colspan="7" class="admin-empty">No dashboard accounts found.</td></tr>';
      return;
    }
    body.innerHTML = accounts.map((account) => {
      const roleClass = account.role === 'admin' ? 'is-admin' : 'is-user';
      return `<tr>
        <td>${escapeHtml(account.accountCode)}</td>
        <td><strong>${escapeHtml(account.username)}</strong></td>
        <td>${escapeHtml(account.fullName || '—')}</td>
        <td>${escapeHtml(account.email || '—')}</td>
        <td><span class="admin-role ${roleClass}">${escapeHtml(account.role)}</span></td>
        <td>${escapeHtml(formatDate(account.lastLoginAt))}</td>
        <td>
          <div class="admin-actions">
            <button class="btn-secondary-sm" type="button" data-edit="${account.accountId}"><i data-lucide="pencil"></i> Edit</button>
            <button class="btn-secondary-sm admin-delete" type="button" data-delete="${account.accountId}"><i data-lucide="trash-2"></i> Delete</button>
          </div>
        </td>
      </tr>`;
    }).join('');
    if (window.lucide) window.lucide.createIcons();
  }

  async function load() {
    const state = $('#admin-load-state');
    try {
      if (state) state.textContent = 'LOADING';
      const payload = await api('/auth/admin/accounts');
      render(payload.accounts || []);
      if (state) state.textContent = 'SYNCED';
      showError('');
    } catch (error) {
      if (state) state.textContent = 'ERROR';
      showError(error.message);
    }
  }

  function openModal(account) {
    editingId = account.accountId;
    $('#admin-modal-title').textContent = `Edit ${account.username}`;
    $('#admin-modal-subtitle').textContent = `${account.accountCode} • changes revoke active sessions`;
    $('#admin-edit-fullname').value = account.fullName || '';
    $('#admin-edit-username').value = account.username || '';
    $('#admin-edit-email').value = account.email || '';
    $('#admin-edit-role').value = account.role === 'admin' ? 'admin' : 'user';
    $('#admin-edit-password').value = '';
    showFormError('');
    modal.hidden = false;
  }

  function closeModal() {
    editingId = null;
    modal.hidden = true;
    showFormError('');
  }

  async function save(event) {
    event.preventDefault();
    if (!editingId) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const payload = {
        fullName: $('#admin-edit-fullname').value.trim(),
        username: $('#admin-edit-username').value.trim(),
        email: $('#admin-edit-email').value.trim(),
        role: $('#admin-edit-role').value,
      };
      const password = $('#admin-edit-password').value;
      if (password) payload.newPassword = password;
      await api(`/auth/admin/accounts/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      closeModal();
      await load();
    } catch (error) {
      showFormError(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function remove(accountId, username) {
    if (!window.confirm(`Delete dashboard account "${username}"? This cannot be undone.`)) return;
    try {
      await api(`/auth/admin/accounts/${accountId}`, { method: 'DELETE' });
      await load();
    } catch (error) {
      showError(error.message);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#admin-refresh')?.addEventListener('click', load);
    form?.addEventListener('submit', save);
    modal?.querySelectorAll('[data-close-modal]').forEach((element) => {
      element.addEventListener('click', closeModal);
    });
    $('#admin-accounts-body')?.addEventListener('click', async (event) => {
      const editButton = event.target.closest('[data-edit]');
      if (editButton) {
        const id = Number(editButton.dataset.edit);
        const account = accounts.find((item) => item.accountId === id);
        if (account) openModal(account);
        return;
      }
      const deleteButton = event.target.closest('[data-delete]');
      if (deleteButton) {
        const id = Number(deleteButton.dataset.delete);
        const account = accounts.find((item) => item.accountId === id);
        if (account) await remove(id, account.username);
      }
    });
    $('#mobile-menu-btn')?.addEventListener('click', () => $('.sidebar')?.classList.toggle('cx-sidebar-open'));
    load();
  });
})();
