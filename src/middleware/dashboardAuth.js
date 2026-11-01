'use strict';

const crypto = require('node:crypto');
const { sql, poolPromise } = require('../db/sqlserver');

const COOKIE_NAME = 'campusx_session';
const loginAttempts = new Map();
let currentAccount = null;

function sessionHours() {
  const value = Number(process.env.DASHBOARD_SESSION_HOURS || 8);
  return Number.isFinite(value) ? Math.min(24, Math.max(1, value)) : 8;
}
function sessionMaxAgeSeconds() { return sessionHours() * 60 * 60; }
function sessionSecret() { return String(process.env.DASHBOARD_SESSION_SECRET || '').trim(); }
function cookieSecure() {
  return String(process.env.DASHBOARD_COOKIE_SECURE || 'false').toLowerCase() === 'true';
}
function isAuthConfigured() {
  return Boolean(currentAccount && sessionSecret().length >= 32);
}
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function parseCookies(header = '') {
  const result = Object.create(null);
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { result[name] = decodeURIComponent(value); } catch { result[name] = value; }
  }
  return result;
}
function sign(value) {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}
function createSession(account) {
  const now = Date.now();
  const expiresAt = now + sessionMaxAgeSeconds() * 1000;
  const payload = Buffer.from(JSON.stringify({
    accountId: account.accountId,
    username: account.username,
    sessionVersion: account.sessionVersion,
    issuedAt: now,
    expiresAt,
    nonce: crypto.randomBytes(12).toString('hex'),
  })).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, expiresAt };
}
function setSessionCookie(res, account) {
  const session = createSession(account);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(session.token)}`,
    'Path=/',
    `Max-Age=${sessionMaxAgeSeconds()}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (cookieSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
  res.setHeader('Cache-Control', 'no-store');
  return session.expiresAt;
}
function clearSessionCookie(res) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict'];
  if (cookieSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
  res.setHeader('Cache-Control', 'no-store');
}
function readSession(req) {
  if (!isAuthConfigured()) return null;
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token || typeof token !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined || !safeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (Number(data.accountId) !== currentAccount.accountId) return null;
    if (Number(data.sessionVersion) !== currentAccount.sessionVersion) return null;
    if (String(data.username).toLowerCase() !== currentAccount.username.toLowerCase()) return null;
    if (!Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) return null;
    return {
      accountId: currentAccount.accountId,
      username: currentAccount.username,
      expiresAt: data.expiresAt,
      issuedAt: data.issuedAt,
    };
  } catch {
    return null;
  }
}
function sessionMiddleware(req, res, next) {
  req.dashboardUser = readSession(req);
  next();
}
function clearLoginAttempt(ip) { loginAttempts.delete(ip); }
function checkLoginRate(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return { blocked: false };
  if (entry.blockedUntil && entry.blockedUntil > Date.now()) {
    return { blocked: true, retryAfter: Math.ceil((entry.blockedUntil - Date.now()) / 1000) };
  }
  if (entry.blockedUntil && entry.blockedUntil <= Date.now()) loginAttempts.delete(ip);
  return { blocked: false };
}
function recordFailedLogin(ip) {
  const current = loginAttempts.get(ip) || { failures: 0, blockedUntil: 0 };
  current.failures += 1;
  if (current.failures >= 5) {
    current.blockedUntil = Date.now() + 15 * 60 * 1000;
    current.failures = 0;
  }
  loginAttempts.set(ip, current);
}
function verifyPassword(password, encodedHash) {
  const value = String(encodedHash || '');
  const separator = value.indexOf(':');
  if (separator <= 0) return false;
  const saltHex = value.slice(0, separator);
  const expectedHex = value.slice(separator + 1);
  if (!/^[a-f0-9]{32,128}$/i.test(saltHex) || !/^[a-f0-9]{64,256}$/i.test(expectedHex)) return false;
  try {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}
function rejectCrossSite(req, res) {
  if (req.get('sec-fetch-site') === 'cross-site') {
    res.status(403).json({ status: 'error', error: { code: 'CROSS_SITE_REQUEST', message: 'Cross-site authentication requests are not allowed.' } });
    return true;
  }
  const origin = req.get('origin');
  const expectedOrigin = `${req.protocol}://${req.get('host')}`;
  if (origin && origin !== expectedOrigin) {
    res.status(403).json({ status: 'error', error: { code: 'INVALID_ORIGIN', message: 'Authentication request origin does not match this server.' } });
    return true;
  }
  return false;
}
function mapAccount(row) {
  if (!row) return null;
  return {
    accountId: Number(row.AccountId),
    username: String(row.Username),
    passwordHash: String(row.PasswordHash),
    sessionVersion: Number(row.SessionVersion || 1),
    createdAt: row.CreatedAt || null,
    updatedAt: row.UpdatedAt || null,
    lastLoginAt: row.LastLoginAt || null,
  };
}
async function loadAccount(pool) {
  const result = await pool.request().query(`
    SELECT TOP (1)
      AccountId, Username, PasswordHash, SessionVersion, CreatedAt, UpdatedAt, LastLoginAt
    FROM dbo.DashboardAccounts
    ORDER BY AccountId ASC
  `);
  currentAccount = mapAccount(result.recordset[0]);
  return currentAccount;
}
async function initializeDashboardAuth(existingPool) {
  // Email/SMTP features are intentionally disabled. Any legacy email columns in an
  // existing DashboardAccounts table are left untouched but are not read or used.
  const pool = existingPool || await poolPromise;
  await pool.request().query(`
    IF OBJECT_ID(N'dbo.DashboardAccounts', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.DashboardAccounts (
        AccountId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DashboardAccounts PRIMARY KEY,
        Username NVARCHAR(64) NOT NULL,
        PasswordHash NVARCHAR(300) NOT NULL,
        SessionVersion INT NOT NULL CONSTRAINT DF_DashboardAccounts_SessionVersion DEFAULT (1),
        CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_DashboardAccounts_CreatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedAt DATETIME2 NOT NULL CONSTRAINT DF_DashboardAccounts_UpdatedAt DEFAULT SYSUTCDATETIME(),
        LastLoginAt DATETIME2 NULL,
        CONSTRAINT UQ_DashboardAccounts_Username UNIQUE (Username)
      );
    END;
  `);

  let account = await loadAccount(pool);
  if (!account) {
    const bootstrapUsername = String(process.env.DASHBOARD_USERNAME || '').trim();
    const bootstrapHash = String(process.env.DASHBOARD_PASSWORD_HASH || '').trim();
    if (!bootstrapUsername || !bootstrapHash || sessionSecret().length < 32) {
      console.warn('[Auth] No dashboard account found. Configure bootstrap DASHBOARD_USERNAME, DASHBOARD_PASSWORD_HASH and DASHBOARD_SESSION_SECRET.');
      return false;
    }
    const split = bootstrapHash.indexOf(':');
    const salt = bootstrapHash.slice(0, split);
    const digest = bootstrapHash.slice(split + 1);
    if (!/^[A-Za-z0-9._@-]{3,64}$/.test(bootstrapUsername)) throw new Error('Bootstrap dashboard username has an invalid format.');
    if (split < 1 || !/^[a-f0-9]{32,128}$/i.test(salt) || !/^[a-f0-9]{64,256}$/i.test(digest)) {
      throw new Error('Bootstrap dashboard password hash has an invalid format. Re-run scripts/setup-dashboard-auth.ps1.');
    }
    await pool.request()
      .input('username', sql.NVarChar(64), bootstrapUsername)
      .input('passwordHash', sql.NVarChar(300), bootstrapHash)
      .query(`INSERT INTO dbo.DashboardAccounts (Username, PasswordHash) VALUES (@username, @passwordHash)`);
    account = await loadAccount(pool);
    console.log(`[Auth] Initial dashboard account migrated to SQL Server (${account.username}).`);
  }
  if (account && sessionSecret().length < 32) {
    throw new Error('DASHBOARD_SESSION_SECRET must contain at least 32 characters.');
  }
  if (account) console.log(`[Auth] Dashboard account ready: ${account.username}`);
  return Boolean(account);
}
function publicAccount(account = currentAccount) {
  if (!account) return null;
  return {
    accountId: account.accountId,
    accountCode: `CX-${String(account.accountId).padStart(4, '0')}`,
    username: account.username,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastLoginAt: account.lastLoginAt,
  };
}
async function loginHandler(req, res) {
  if (!isAuthConfigured()) {
    return res.status(503).json({ status: 'error', error: { code: 'AUTH_NOT_CONFIGURED', message: 'Dashboard account is not initialized. Check the root .env and restart the backend.' } });
  }
  if (rejectCrossSite(req, res)) return;
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const rate = checkLoginRate(ip);
  if (rate.blocked) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    return res.status(429).json({ status: 'error', error: { code: 'LOGIN_TEMPORARILY_BLOCKED', message: 'Too many failed attempts. Try again later.' } });
  }
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const validUser = safeEqual(username.toLowerCase(), currentAccount.username.toLowerCase());
  const validPassword = verifyPassword(password, currentAccount.passwordHash);
  if (!validUser || !validPassword) {
    recordFailedLogin(ip);
    return res.status(401).json({ status: 'error', error: { code: 'INVALID_CREDENTIALS', message: 'Username or password is incorrect.' } });
  }
  clearLoginAttempt(ip);
  const db = await poolPromise;
  await db.request().input('accountId', sql.Int, currentAccount.accountId)
    .query('UPDATE dbo.DashboardAccounts SET LastLoginAt = SYSUTCDATETIME() WHERE AccountId = @accountId');
  await loadAccount(db);
  const expiresAt = setSessionCookie(res, currentAccount);
  return res.json({ status: 'ok', user: { accountId: currentAccount.accountId, username: currentAccount.username }, expiresAt, redirectTo: '/dashboard' });
}
function logoutHandler(req, res) {
  if (rejectCrossSite(req, res)) return;
  clearSessionCookie(res);
  return res.json({ status: 'ok', message: 'Logged out.' });
}
function sessionHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthConfigured()) return res.status(503).json({ status: 'error', error: { code: 'AUTH_NOT_CONFIGURED', message: 'Dashboard authentication is not initialized.' } });
  if (!req.dashboardUser) return res.status(401).json({ status: 'error', error: { code: 'AUTH_REQUIRED', message: 'Please sign in to CampusX.' } });
  return res.json({ status: 'ok', user: { accountId: req.dashboardUser.accountId, username: req.dashboardUser.username }, expiresAt: req.dashboardUser.expiresAt });
}
function requireDashboardPage(req, res, next) {
  if (!isAuthConfigured()) return res.redirect('/login.html?setup=required');
  if (!req.dashboardUser) {
    const nextPath = encodeURIComponent(`${req.path}${req.url.includes('?') ? req.url.slice(req.path.length) : ''}`);
    return res.redirect(`/login.html?next=${nextPath}`);
  }
  next();
}
function requireDashboardApi(req, res, next) {
  if (req.path === '/health') return next();
  if (!isAuthConfigured()) return res.status(503).json({ status: 'error', error: { code: 'AUTH_NOT_CONFIGURED', message: 'Dashboard authentication is not initialized.' } });
  if (!req.dashboardUser) return res.status(401).json({ status: 'error', error: { code: 'AUTH_REQUIRED', message: 'Please sign in to CampusX.' } });
  next();
}

async function getAccountHandler(req, res) {
  if (!isAuthConfigured() || !req.dashboardUser) return res.status(401).json({ status: 'error', error: { code: 'AUTH_REQUIRED', message: 'Please sign in.' } });
  const pool = await poolPromise;
  const result = await pool.request().input('accountId', sql.Int, req.dashboardUser.accountId).query(`
    SELECT AccountId, Username, CreatedAt, UpdatedAt, LastLoginAt
    FROM dbo.DashboardAccounts WHERE AccountId = @accountId
  `);
  if (!result.recordset.length) return res.status(404).json({ status: 'error', error: { code: 'ACCOUNT_NOT_FOUND', message: 'Dashboard account was not found.' } });
  const row = result.recordset[0];
  return res.set('Cache-Control', 'no-store').json({
    status: 'ok',
    account: {
      accountId: Number(row.AccountId),
      accountCode: `CX-${String(row.AccountId).padStart(4, '0')}`,
      username: row.Username,
      createdAt: row.CreatedAt || null,
      updatedAt: row.UpdatedAt || null,
      lastLoginAt: row.LastLoginAt || null,
      sessionExpiresAt: req.dashboardUser.expiresAt,
    },
  });
}
async function updateCredentialsHandler(req, res) {
  if (rejectCrossSite(req, res)) return;
  const account = currentAccount;
  if (!account || !req.dashboardUser || req.dashboardUser.accountId !== account.accountId) return res.status(401).json({ status: 'error', error: { code: 'AUTH_REQUIRED', message: 'Please sign in again.' } });
  const currentPassword = String(req.body?.currentPassword || '');
  const requestedUsername = req.body?.username === undefined ? account.username : String(req.body.username).trim();
  const newPassword = String(req.body?.newPassword || '');
  if (!verifyPassword(currentPassword, account.passwordHash)) return res.status(401).json({ status: 'error', error: { code: 'CURRENT_PASSWORD_INCORRECT', message: 'Current password is incorrect.' } });
  if (!/^[A-Za-z0-9._@-]{3,64}$/.test(requestedUsername)) return res.status(400).json({ status: 'error', error: { code: 'INVALID_USERNAME', message: 'Username must be 3-64 characters using letters, numbers, dot, underscore, @ or hyphen.' } });
  const usernameChanged = requestedUsername.toLowerCase() !== account.username.toLowerCase();
  const passwordChanged = newPassword.length > 0;
  if (!usernameChanged && !passwordChanged) return res.status(400).json({ status: 'error', error: { code: 'NO_ACCOUNT_CHANGES', message: 'Enter a new username or a new password.' } });
  if (passwordChanged && (newPassword.length < 12 || newPassword.length > 128)) return res.status(400).json({ status: 'error', error: { code: 'INVALID_PASSWORD_LENGTH', message: 'New password must be between 12 and 128 characters.' } });
  const nextHash = passwordChanged ? hashPassword(newPassword) : account.passwordHash;
  const pool = await poolPromise;
  try {
    const updated = await pool.request()
      .input('accountId', sql.Int, account.accountId)
      .input('username', sql.NVarChar(64), requestedUsername)
      .input('passwordHash', sql.NVarChar(300), nextHash)
      .query(`
        UPDATE dbo.DashboardAccounts
        SET Username = @username,
            PasswordHash = @passwordHash,
            SessionVersion = SessionVersion + 1,
            UpdatedAt = SYSUTCDATETIME()
        OUTPUT inserted.AccountId, inserted.Username, inserted.PasswordHash,
               inserted.SessionVersion, inserted.CreatedAt, inserted.UpdatedAt, inserted.LastLoginAt
        WHERE AccountId = @accountId
      `);
    currentAccount = mapAccount(updated.recordset[0]);
    const expiresAt = setSessionCookie(res, currentAccount);
    return res.json({
      status: 'ok',
      message: 'Account credentials updated. Other active sessions have been revoked.',
      user: { accountId: currentAccount.accountId, username: currentAccount.username },
      expiresAt,
    });
  } catch (error) {
    if (error.number === 2627 || error.number === 2601) return res.status(409).json({ status: 'error', error: { code: 'USERNAME_ALREADY_EXISTS', message: 'This username is already in use.' } });
    throw error;
  }
}
function getCachedAccount() { return publicAccount(currentAccount); }
function getCurrentAccountInternal() { return currentAccount; }

module.exports = {
  isAuthConfigured,
  initializeDashboardAuth,
  sessionMiddleware,
  loginHandler,
  logoutHandler,
  sessionHandler,
  requireDashboardPage,
  requireDashboardApi,
  publicAccount: getCachedAccount,
  getCurrentAccountInternal,
  getAccountHandler,
  updateCredentialsHandler,
};
