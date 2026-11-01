(() => {
  'use strict';
  const form = document.getElementById('login-form');
  const errorBox = document.getElementById('login-error');
  const submit = document.getElementById('login-submit');
  const passwordInput = document.getElementById('user-password');
  const toggle = document.getElementById('toggle-password');

  function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function safeNext(value) {
    if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/dashboard';
    return value;
  }

  const next = safeNext(new URLSearchParams(location.search).get('next'));

  if (toggle && passwordInput) {
    toggle.addEventListener('click', () => {
      const visible = passwordInput.type === 'password';
      passwordInput.type = visible ? 'text' : 'password';
      toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
      toggle.innerHTML = `<i data-lucide="${visible ? 'eye-off' : 'eye'}"></i>`;
      if (window.lucide) window.lucide.createIcons();
    });
  }

  fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' })
    .then((response) => {
      if (response.ok) location.replace(next);
    })
    .catch(() => {});

  if (form) form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (errorBox) { errorBox.hidden = true; errorBox.textContent = ''; }
    submit.disabled = true;
    submit.textContent = 'Authenticating…';

    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('user-email').value.trim(),
          password: passwordInput.value,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || `Login failed (${response.status}).`);
      passwordInput.value = '';
      location.replace(next || payload.redirectTo || '/dashboard');
    } catch (error) {
      showError(error.message || 'Unable to sign in. Check the backend and try again.');
      submit.disabled = false;
      submit.textContent = 'Sign in to CampusX →';
    }
  });
})();
