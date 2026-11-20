'use strict';

/* End-to-end admin account governance smoke test. Creates temporary SQL accounts and deletes them. */
require('dotenv').config();

const crypto = require('node:crypto');
const { sql, poolPromise, closePool } = require('../src/db/sqlserver');

const baseUrl = `http://${process.env.HOST || '127.0.0.1'}:${Number(process.env.PORT || 3000)}`;
const password = `AdminSmoke!${crypto.randomBytes(8).toString('hex')}`;
const suffix = `${Date.now()}.${crypto.randomBytes(3).toString('hex')}`;
const adminEmail = `admin.smoke.${suffix}@campusx.test`;
const userEmail = `user.smoke.${suffix}@campusx.test`;
const tempEmails = [adminEmail, userEmail];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function hashPassword(value) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(value, salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}
function sessionCookie(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  return (values.find((value) => value.startsWith('campusx_session=')) || '').split(';')[0];
}
async function request(path, { method = 'GET', cookie = '', body } = {}) {
  const headers = { accept: 'application/json', origin: baseUrl };
  if (cookie) headers.cookie = cookie;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload, cookie: sessionCookie(response) };
}
async function insertAccount(pool, email, role) {
  await pool.request()
    .input('username', sql.NVarChar(64), email)
    .input('passwordHash', sql.NVarChar(300), hashPassword(password))
    .input('email', sql.NVarChar(320), email)
    .input('fullName', sql.NVarChar(100), role === 'admin' ? 'Admin Smoke Test' : 'User Smoke Test')
    .input('role', sql.NVarChar(20), role)
    .query(`INSERT INTO dbo.DashboardAccounts (Username, PasswordHash, Email, FullName, Role)
            VALUES (@username, @passwordHash, @email, @fullName, @role)`);
}
async function cleanup() {
  try {
    const pool = await poolPromise;
    for (const email of tempEmails) {
      await pool.request()
        .input('email', sql.NVarChar(320), email)
        .query('DELETE FROM dbo.DashboardAccounts WHERE Email = @email');
    }
    console.log(`OK   temporary accounts deleted (${tempEmails.length})`);
    await closePool();
  } catch (error) {
    console.error('WARN admin-smoke cleanup:', error.message);
  }
}

(async () => {
  const pool = await poolPromise;
  await insertAccount(pool, adminEmail, 'admin');
  await insertAccount(pool, userEmail, 'user');
  console.log('OK   temporary admin + user accounts created in SQL');

  const login = await request('/auth/login', { method: 'POST', body: { username: adminEmail, password } });
  assert(login.response.ok && login.payload?.user?.role === 'admin', `Admin login failed: ${login.response.status}`);
  assert(login.cookie.startsWith('campusx_session='), 'Admin login did not set a session cookie');
  console.log('OK   admin login');

  const listed = await request('/auth/admin/accounts', { cookie: login.cookie });
  assert(listed.response.ok && Array.isArray(listed.payload.accounts), `Account list failed: ${listed.response.status}`);
  assert(!JSON.stringify(listed.payload).includes('PasswordHash'), 'Account list leaked a password hash');
  const adminRow = listed.payload.accounts.find((item) => item.email === adminEmail);
  const userRow = listed.payload.accounts.find((item) => item.email === userEmail);
  assert(adminRow && userRow, 'Temporary accounts were not listed');
  console.log(`OK   account list (${listed.payload.count} accounts, no password hashes)`);

  const edited = await request(`/auth/admin/accounts/${userRow.accountId}`, {
    method: 'PATCH',
    cookie: login.cookie,
    body: { fullName: 'Admin Smoke Edited', role: 'user' },
  });
  assert(edited.response.ok && edited.payload?.account?.fullName === 'Admin Smoke Edited', `Account edit failed: ${edited.response.status}`);
  console.log('OK   admin edited a user account');

  const selfEdit = await request(`/auth/admin/accounts/${adminRow.accountId}`, {
    method: 'PATCH',
    cookie: login.cookie,
    body: { fullName: 'Admin Smoke Self' },
  });
  assert(selfEdit.response.ok && selfEdit.payload?.user?.fullName === 'Admin Smoke Self', `Self edit failed: ${selfEdit.response.status}`);
  assert(selfEdit.cookie.startsWith('campusx_session='), 'Self edit did not refresh the session cookie');
  const sessionAfterEdit = await request('/auth/session', { cookie: selfEdit.cookie });
  assert(sessionAfterEdit.response.ok, `Refreshed session was rejected: ${sessionAfterEdit.response.status}`);
  console.log('OK   self-edit refreshed the session without logout');

  const removed = await request(`/auth/admin/accounts/${userRow.accountId}`, { method: 'DELETE', cookie: selfEdit.cookie });
  assert(removed.response.ok, `Account delete failed: ${removed.response.status}`);
  console.log('OK   admin deleted a user account');

  const selfDelete = await request(`/auth/admin/accounts/${adminRow.accountId}`, { method: 'DELETE', cookie: selfEdit.cookie });
  assert(selfDelete.response.status === 400 && selfDelete.payload?.error?.code === 'CANNOT_DELETE_SELF', 'Self-delete was not blocked');
  console.log('OK   self-delete blocked');

  const forbidden = await request('/auth/admin/accounts', {});
  assert(forbidden.response.status === 401, 'Anonymous admin request should be 401');
  console.log('OK   anonymous admin request rejected');

  await cleanup();
})().catch(async (error) => {
  console.error('FAIL admin-smoke:', error?.stack || error);
  await cleanup();
  process.exitCode = 1;
});
