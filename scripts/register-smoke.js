'use strict';

/* End-to-end signup smoke test. Creates a uniquely named test account and deletes it. */
require('dotenv').config();

const crypto = require('node:crypto');
const { sql, poolPromise, closePool } = require('../src/db/sqlserver');

const base = `http://${process.env.HOST || '127.0.0.1'}:${Number(process.env.PORT || 3000)}`;
const email = `register.smoke.${Date.now()}.${crypto.randomBytes(3).toString('hex')}@campusx.test`;
const password = 'CampusXSmoke!2026';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function asJson(response) {
  try { return await response.json(); } catch { return null; }
}

(async () => {
  const page = await fetch(`${base}/register.html`);
  const html = await page.text();
  assert(page.status === 200 && html.includes('registerForm'), 'GET /register.html did not serve the signup form');
  console.log(`OK   register.html (${page.status})`);

  const headers = { 'Content-Type': 'application/json', Origin: base };
  const body = JSON.stringify({
    fullName: 'Register Smoke Test',
    universityEmail: email,
    password,
    confirmPassword: password,
  });

  const registration = await fetch(`${base}/auth/register`, { method: 'POST', headers, body });
  const created = await asJson(registration);
  const cookie = (registration.headers.get('set-cookie') || '').split(';')[0];
  assert(registration.status === 201 && created?.status === 'ok', `POST /auth/register failed: ${registration.status}`);
  assert(cookie.startsWith('campusx_session='), 'Registration did not set the session cookie');
  assert(created.user?.email === email, 'Registration response returned the wrong email');
  console.log(`OK   register -> account #${created.user.accountId}`);

  const session = await fetch(`${base}/auth/session`, { headers: { Cookie: cookie } });
  const sessionBody = await asJson(session);
  assert(session.status === 200 && sessionBody?.user?.accountId === created.user.accountId, 'Session cookie was not accepted');
  console.log('OK   authenticated session');

  const dashboard = await fetch(`${base}/dashboard`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert(dashboard.status === 200, 'Signed-in user could not open /dashboard');
  console.log('OK   dashboard access');

  const duplicate = await fetch(`${base}/auth/register`, { method: 'POST', headers, body });
  const duplicateBody = await asJson(duplicate);
  assert(duplicate.status === 409 && duplicateBody?.error?.code === 'ACCOUNT_EXISTS', 'Duplicate signup was not rejected');
  console.log('OK   duplicate signup rejected');

  const logout = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Origin: base, Cookie: cookie } });
  assert(logout.status === 200 && /Max-Age=0/i.test(logout.headers.get('set-cookie') || ''), 'Logout did not clear the cookie');
  const anonymous = await fetch(`${base}/auth/session`);
  assert(anonymous.status === 401, 'Anonymous /auth/session should return 401');
  console.log('OK   logout clears access');

  for (const username of [email, created.user.username]) {
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username, password }),
    });
    const loginBody = await asJson(login);
    assert(login.status === 200 && loginBody?.user?.accountId === created.user.accountId, `Login with ${username} failed`);
  }
  console.log('OK   login by email and username');

  const pool = await poolPromise;
  const found = await pool.request()
    .input('email', sql.NVarChar(320), email)
    .query('SELECT AccountId, Username, Email FROM dbo.DashboardAccounts WHERE Email = @email');
  assert(found.recordset.length === 1, 'Test account was not written to SQL Server');
  await pool.request()
    .input('email', sql.NVarChar(320), email)
    .query('DELETE FROM dbo.DashboardAccounts WHERE Email = @email');
  console.log(`OK   SQL row verified and test account ${email} deleted`);
  await closePool();
})().catch(async (error) => {
  console.error('FAIL register-smoke:', error?.stack || error);
  try {
    const pool = await poolPromise;
    await pool.request().input('email', sql.NVarChar(320), email).query('DELETE FROM dbo.DashboardAccounts WHERE Email = @email');
    console.log(`Cleanup attempted for ${email}`);
    await closePool();
  } catch {}
  process.exitCode = 1;
});
