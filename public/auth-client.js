(() => {
  'use strict';
  const loginUrl = () => `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
  let redirected = false;

  async function verifySession() {
    if (redirected) return false;
    try {
      const response = await fetch('/auth/session', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        redirected = true;
        location.replace(loginUrl());
        return false;
      }
      const payload = await response.json();
      const username = payload?.user?.username || 'CampusX Operator';
      const name = document.querySelector('.user-profile .user-info strong');
      if (name) name.textContent = username;
      return true;
    } catch {
      return false;
    }
  }

  async function logout() {
    const button = document.getElementById('cx-logout');
    if (button) button.disabled = true;
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      sessionStorage.removeItem('campusx_api_key');
      location.replace('/login.html');
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!(await verifySession())) return;
    const header = document.querySelector('.header-right-group');
    if (header && !document.getElementById('cx-logout')) {
      const button = document.createElement('button');
      button.id = 'cx-logout';
      button.type = 'button';
      button.className = 'cx-logout-btn';
      button.innerHTML = '<i data-lucide="log-out"></i><span>Sign out</span>';
      button.addEventListener('click', logout);
      header.appendChild(button);
      if (window.lucide) window.lucide.createIcons();
    }
  });
})();
