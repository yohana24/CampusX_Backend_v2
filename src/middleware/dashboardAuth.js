'use strict';

const crypto = require('node:crypto');
const { sql, poolPromise } = require('../db/sqlserver');
const env = require('../config/env');

const COOKIE_NAME = 'campusx_session';
const loginAttempts = new Map();
const registrationAttempts = new Map();
const MAX_ATTEMPT_KEYS = 5000;
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
const MAX_REGISTRATIONS_PER_IP = 5;

// SQL is the source of truth. These maps are a read-only cache used to resolve
// session cookies and login identifiers without a database round-trip.
const accountsById = new Map();
const accountsByUsername = new Map(); // lowercase username -> account
const accountsByEmail = new Map(); // lowercase email -> account
let emailColumnPresent = false;
let authTablesReady = false;

function sessionMaxAgeSeconds() { return env.dashboardSessionHours * 60 * 60; }
function sessionSecret() { return env.dashboardSessionSecret; }
function cookieSecure() { return env.dashboardCookieSecure; }
function firstAccount() {
  return accountsById.values().next().value || null;
}
function isAuthConfigured() {
  return Boolean(firstAccount() && sessionSecret().length >= 32);
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
    const account = accountsById.get(Number(data.accountId));
    if (!account) return null;
    if (Number(data.sessionVersion) !== account.sessionVersion) return null;
    if (String(data.username).toLowerCase() !== account.username.toLowerCase()) return null;
    if (!Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) return null;
    return {
      accountId: account.accountId,
      username: account.username,
      email: account.email,
      fullName: account.fullName,
      role: account.role,
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
function pruneAttemptMap(map) {
  if (map.size <= MAX_ATTEMPT_KEYS) return;
  let toRemove = map.size - MAX_ATTEMPT_KEYS + 1;
  for (const key of map.keys()) {
    map.delete(key);
    if (--toRemove <= 0) break;
  }
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
  pruneAttemptMap(loginAttempts);
}
function checkRegistrationRate(ip) {
  const entry = registrationAttempts.get(ip);
  if (!entry || entry.expiresAt <= Date.now()) return { blocked: false };
  if (entry.count >= MAX_REGISTRATIONS_PER_IP) {
    return { blocked: true, retryAfter: Math.ceil((entry.expiresAt - Date.now()) / 1000) };
  }
  return { blocked: false };
}
function recordRegistrationAttempt(ip) {
  const now = Date.now();
  const current = registrationAttempts.get(ip);
  const entry = !current || current.expiresAt <= now
    ? { count: 0, expiresAt: now + REGISTRATION_WINDOW_MS }
    : current;
  entry.count += 1;
  registrationAttempts.set(ip, entry);
  pruneAttemptMap(registrationAttempts);
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
  const expectedOrigin = env.publicOrigin || `${req.protocol}://${req.get('host')}`;
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
    email: row.Email ? String(row.Email) : null,
    fullName: row.FullName ? String(row.FullName) : null,
    role: row.Role === 'admin' ? 'admin' : 'user',
    sessionVersion: Number(row.SessionVersion || 1),
    createdAt: row.CreatedAt || null,
    updatedAt: row.UpdatedAt || null,
    lastLoginAt: row.LastLoginAt || null,
  };
}
function cacheAccounts(rows) {
  accountsById.clear();
  accountsByUsername.clear();
  accountsByEmail.clear();
  for (const row of rows) {
    const account = mapAccount(row);
    if (!account) continue;
    accountsById.set(account.accountId, account);
    accountsByUsername.set(account.username.toLowerCase(), account);
    if (account.email) accountsByEmail.set(account.email.toLowerCase(), account);
  }
}
async function ensureDashboardTable(pool) {
  // Legacy email columns, when present, are left untouched. Column additions and
  // the check constraint are separate batches: SQL Server compiles a batch before
  // executing it, so a CHECK (Role ...) cannot see a Role column added in the
  // same batch.
  await pool.request().query(`
    IF OBJECT_ID(N'dbo.DashboardAccounts', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.DashboardAccounts (
        AccountId INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DashboardAccounts PRIMARY KEY,
        Username NVARCHAR(64) NOT NULL,
        PasswordHash NVARCHAR(300) NOT NULL,
        Email NVARCHAR(320) NULL,
        FullName NVARCHAR(100) NULL,
        Role NVARCHAR(20) NOT NULL CONSTRAINT DF_DashboardAccounts_Role DEFAULT (N'user')
          CONSTRAINT CK_DashboardAccounts_Role CHECK (Role IN (N'user', N'admin')),
        SessionVersion INT NOT NULL CONSTRAINT DF_DashboardAccounts_SessionVersion DEFAULT (1),
        CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_DashboardAccounts_CreatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedAt DATETIME2 NOT NULL CONSTRAINT DF_DashboardAccounts_UpdatedAt DEFAULT SYSUTCDATETIME(),
        LastLoginAt DATETIME2 NULL,
        CONSTRAINT UQ_DashboardAccounts_Username UNIQUE (Username)
      );
    END;
    ELSE
    BEGIN
      IF COL_LENGTH(N'dbo.DashboardAccounts', N'Email') IS NULL
        ALTER TABLE dbo.DashboardAccounts ADD Email NVARCHAR(320) NULL;
      IF COL_LENGTH(N'dbo.DashboardAccounts', N'FullName') IS NULL
        ALTER TABLE dbo.DashboardAccounts ADD FullName NVARCHAR(100) NULL;
      IF COL_LENGTH(N'dbo.DashboardAccounts', N'Role') IS NULL
        ALTER TABLE dbo.DashboardAccounts ADD Role NVARCHAR(20) NOT NULL
          CONSTRAINT DF_DashboardAccounts_Role DEFAULT (N'user');
    END;
  `);
  await pool.request().query(`
    IF COL_LENGTH(N'dbo.DashboardAccounts', N'Role') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sys.check_constraints
         WHERE parent_object_id = OBJECT_ID(N'dbo.DashboardAccounts') AND name = N'CK_DashboardAccounts_Role'
       )
      ALTER TABLE dbo.DashboardAccounts ADD CONSTRAINT CK_DashboardAccounts_Role
        CHECK (Role IN (N'user', N'admin'));
  `);
  await pool.request().query(`
    IF COL_LENGTH(N'dbo.DashboardAccounts', N'Email') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM sys.indexes
         WHERE object_id = OBJECT_ID(N'dbo.DashboardAccounts') AND name = N'UX_DashboardAccounts_Email'
       )
    BEGIN
      CREATE UNIQUE INDEX UX_DashboardAccounts_Email
        ON dbo.DashboardAccounts(Email) WHERE Email IS NOT NULL;
    END;
  `);
  authTablesReady = true;
}
async function detectEmailColumn(pool) {
  const result = await pool.request().query(`SELECT COL_LENGTH(N'dbo.DashboardAccounts', N'Email') AS EmailLength`);
  emailColumnPresent = Number(result.recordset[0]?.EmailLength) > 0;
  return emailColumnPresent;
}
async function loadAccounts(pool) {
  const emailField = emailColumnPresent ? ', Email' : ', NULL AS Email';
  const result = await pool.request().query(`
    SELECT AccountId, Username, PasswordHash, SessionVersion, CreatedAt, UpdatedAt, LastLoginAt,
           FullName, Role${emailField}
    FROM dbo.DashboardAccounts
    ORDER BY AccountId ASC
  `);
  cacheAccounts(result.recordset);
  return firstAccount();
}
async function ensureAdminAccount(pool) {
  const explicitUsername = env.dashboardAdminUsername;
  const explicitEmail = env.dashboardAdminEmail;
  if (explicitUsername || explicitEmail) {
    const request = pool.request();
    const conditions = [];
    if (explicitUsername) {
      request.input('adminUsername', sql.NVarChar(64), explicitUsername);
      conditions.push('Username = @adminUsername');
    }
    if (explicitEmail) {
      request.input('adminEmail', sql.NVarChar(320), explicitEmail);
      conditions.push('Email = @adminEmail');
    }
    // When both are configured they must identify the same account; a partial
    // match must not promote an unrelated account by accident.
    const where = conditions.join(' AND ');
    await request.query(`
      UPDATE dbo.DashboardAccounts SET Role = N'admin', UpdatedAt = SYSUTCDATETIME()
      WHERE ${where}
    `);
    const check = await pool.request().query(`SELECT COUNT(*) AS AdminCount FROM dbo.DashboardAccounts WHERE Role = N'admin'`);
    if (Number(check.recordset[0]?.AdminCount) === 0) {
      console.warn('[Auth] DASHBOARD_ADMIN_USERNAME/EMAIL did not match an existing account; no admin was promoted.');
    }
    return;
  }
  const count = await pool.request().query(`SELECT COUNT(*) AS AdminCount FROM dbo.DashboardAccounts WHERE Role = N'admin'`);
  if (Number(count.recordset[0]?.AdminCount) > 0) return;
  const request = pool.request();
  let where = '1 = 1';
  if (env.dashboardUsername) {
    request.input('bootstrapUsername', sql.NVarChar(64), env.dashboardUsername);
    where = 'Username = @bootstrapUsername';
  }
  const promoted = await request.query(`
    UPDATE TOP (1) dbo.DashboardAccounts
    SET Role = N'admin', UpdatedAt = SYSUTCDATETIME()
    WHERE ${where};
    SELECT TOP (1) Username FROM dbo.DashboardAccounts WHERE Role = N'admin' ORDER BY AccountId ASC;
  `);
  const name = promoted.recordset[0]?.Username;
  if (name) console.log(`[Auth] Promoted first dashboard account to admin (${name}).`);
}

async function initializeDashboardAuth(existingPool) {
  const pool = existingPool || await poolPromise;
  await ensureDashboardTable(pool);
  await detectEmailColumn(pool);
  let account = await loadAccounts(pool);
  if (!account) {
    const bootstrapUsername = env.dashboardUsername;
    const bootstrapHash = env.dashboardPasswordHash;
    if (!bootstrapUsername || !bootstrapHash || sessionSecret().length < 32) {
      console.warn('[Auth] No dashboard account found. Configure bootstrap DASHBOARD_USERNAME, DASHBOARD_PASSWORD_HASH and DASHBOARD_SESSION_SECRET, or use /register.html.');
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
    account = await loadAccounts(pool);
    console.log(`[Auth] Initial dashboard account migrated to SQL Server (${account.username}).`);
  }
  await ensureAdminAccount(pool);
  account = await loadAccounts(pool);
  if (account && sessionSecret().length < 32) {
    throw new Error('DASHBOARD_SESSION_SECRET must contain at least 32 characters.');
  }
  if (account) console.log(`[Auth] Dashboard accounts ready: ${accountsById.size} (${account.username})`);
  return Boolean(account);
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
  const key = username.toLowerCase();
  let account = accountsByUsername.get(key) || accountsByEmail.get(key);
  if (!account) {
    // Accounts may be created directly in SQL by an administrator. Refresh the
    // read-only cache once so a valid login is not rejected as stale data.
    const db = await poolPromise;
    await loadAccounts(db);
    account = accountsByUsername.get(key) || accountsByEmail.get(key);
  }
  if (!account || !verifyPassword(password, account.passwordHash)) {
    recordFailedLogin(ip);
    return res.status(401).json({ status: 'error', error: { code: 'INVALID_CREDENTIALS', message: 'Username or password is incorrect.' } });
  }
  clearLoginAttempt(ip);
  const db = await poolPromise;
  await db.request().input('accountId', sql.Int, account.accountId)
    .query('UPDATE dbo.DashboardAccounts SET LastLoginAt = SYSUTCDATETIME() WHERE AccountId = @accountId');
  await loadAccounts(db);
  const fresh = accountsById.get(account.accountId) || account;
  const expiresAt = setSessionCookie(res, fresh);
  return res.json({
    status: 'ok',
    user: { accountId: fresh.accountId, username: fresh.username, email: fresh.email, fullName: fresh.fullName, role: fresh.role },
    expiresAt,
    redirectTo: '/dashboard',
  });
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
  return res.json({
    status: 'ok',
    user: {
      accountId: req.dashboardUser.accountId,
      username: req.dashboardUser.username,
      email: req.dashboardUser.email,
      fullName: req.dashboardUser.fullName,
      role: req.dashboardUser.role,
    },
    expiresAt: req.dashboardUser.expiresAt,
  });
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

const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{3,64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function usernameFromEmail(email, fullName) {
  if (email.length <= 64 && USERNAME_PATTERN.test(email)) return email;
  let candidate = String(email).split('@')[0] || '';
  candidate = candidate
    .replace(/[^A-Za-z0-9._-]/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 64);
  if (candidate.length < 3) {
    const fromName = String(fullName || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '.')
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 48);
    candidate = `${candidate}${fromName}`.replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 64);
  }
  if (candidate.length < 3) candidate = `cx${crypto.randomBytes(3).toString('hex')}`;
  return candidate;
}
async function registerHandler(req, res) {
  if (!env.dashboardRegistrationEnabled) {
    return res.status(403).json({ status: 'error', error: { code: 'REGISTRATION_DISABLED', message: 'Dashboard registration is disabled by the administrator.' } });
  }
  if (rejectCrossSite(req, res)) return;
  if (sessionSecret().length < 32) {
    return res.status(503).json({ status: 'error', error: { code: 'AUTH_NOT_CONFIGURED', message: 'DASHBOARD_SESSION_SECRET must be configured before accounts can be created.' } });
  }
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const rate = checkRegistrationRate(ip);
  if (rate.blocked) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    return res.status(429).json({ status: 'error', error: { code: 'REGISTRATION_TEMPORARILY_BLOCKED', message: 'Too many signup attempts. Try again later.' } });
  }
  recordRegistrationAttempt(ip);

  const fullName = String(req.body?.fullName ?? '').trim();
  const email = String(req.body?.universityEmail ?? req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const confirmPassword = String(req.body?.confirmPassword ?? '');

  if (fullName.length < 2 || fullName.length > 100) {
    return res.status(400).json({ status: 'error', error: { code: 'INVALID_FULL_NAME', message: 'Full name must be between 2 and 100 characters.' } });
  }
  if (!EMAIL_PATTERN.test(email) || email.length > 320) {
    return res.status(400).json({ status: 'error', error: { code: 'INVALID_EMAIL', message: 'Enter a valid university email address.' } });
  }
  if (password.length < 12 || password.length > 128) {
    return res.status(400).json({ status: 'error', error: { code: 'INVALID_PASSWORD_LENGTH', message: 'Password must be between 12 and 128 characters.' } });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ status: 'error', error: { code: 'PASSWORD_MISMATCH', message: 'Password and confirmation do not match.' } });
  }

  const username = usernameFromEmail(email, fullName);
  if (accountsByUsername.has(username.toLowerCase()) || accountsByEmail.has(email)) {
    return res.status(409).json({ status: 'error', error: { code: 'ACCOUNT_EXISTS', message: 'An account with this email or username already exists.' } });
  }

  const pool = await poolPromise;
  if (!authTablesReady) await ensureDashboardTable(pool);
  if (!emailColumnPresent) await detectEmailColumn(pool);
  const passwordHash = hashPassword(password);
  try {
    if (emailColumnPresent) {
      await pool.request()
        .input('username', sql.NVarChar(64), username)
        .input('passwordHash', sql.NVarChar(300), passwordHash)
        .input('email', sql.NVarChar(320), email)
        .input('fullName', sql.NVarChar(100), fullName)
        .query(`INSERT INTO dbo.DashboardAccounts (Username, PasswordHash, Email, FullName) VALUES (@username, @passwordHash, @email, @fullName)`);
    } else {
      await pool.request()
        .input('username', sql.NVarChar(64), username)
        .input('passwordHash', sql.NVarChar(300), passwordHash)
        .input('fullName', sql.NVarChar(100), fullName)
        .query(`INSERT INTO dbo.DashboardAccounts (Username, PasswordHash, FullName) VALUES (@username, @passwordHash, @fullName)`);
    }
  } catch (error) {
    if (error.number === 2627 || error.number === 2601) {
      return res.status(409).json({ status: 'error', error: { code: 'ACCOUNT_EXISTS', message: 'An account with this email or username already exists.' } });
    }
    throw error;
  }

  await loadAccounts(pool);
  const account = accountsByUsername.get(username.toLowerCase()) || firstAccount();
  await pool.request().input('accountId', sql.Int, account.accountId)
    .query('UPDATE dbo.DashboardAccounts SET LastLoginAt = SYSUTCDATETIME() WHERE AccountId = @accountId');
  await loadAccounts(pool);
  const fresh = accountsById.get(account.accountId) || account;
  const expiresAt = setSessionCookie(res, fresh);
  return res.status(201).json({
    status: 'ok',
    message: 'Account created and signed in.',
    user: { accountId: fresh.accountId, username: fresh.username, email: fresh.email, fullName: fresh.fullName, role: fresh.role },
    expiresAt,
    redirectTo: '/dashboard',
  });
}

async function getAccountHandler(req, res) {
  if (!isAuthConfigured()) return res.status(503).json({ status: 'error', error: { code: 'AUTH_NOT_CONFIGURED', message: 'Dashboard authentication is not initialized.' } });
  if (!req.dashboardUser) return res.status(401).json({ status: 'error', error: { code: 'AUTH_REQUIRED', message: 'Please sign in.' } });
  const pool = await poolPromise;
  const result = await pool.request().input('accountId', sql.Int, req.dashboardUser.accountId).query(`
    SELECT AccountId, Username, FullName, Role${emailColumnPresent ? ', Email' : ', NULL AS Email'}, CreatedAt, UpdatedAt, LastLoginAt
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
      email: row.Email || null,
      fullName: row.FullName || null,
      role: row.Role === 'admin' ? 'admin' : 'user',
      createdAt: row.CreatedAt || null,
      updatedAt: row.UpdatedAt || null,
      lastLoginAt: row.LastLoginAt || null,
      sessionExpiresAt: req.dashboardUser.expiresAt,
    },
  });
}
async function updateCredentialsHandler(req, res) {
  if (rejectCrossSite(req, res)) return;
  const account = accountsById.get(Number(req.dashboardUser?.accountId));
  if (!account || !req.dashboardUser || req.dashboardUser.accountId !== account.accountId) return res.status(401).json({ status: 'error', error: { code: 'AUTH_REQUIRED', message: 'Please sign in again.' } });
  const currentPassword = String(req.body?.currentPassword || '');
  const requestedUsername = req.body?.username === undefined ? account.username : String(req.body.username).trim();
  const newPassword = String(req.body?.newPassword || '');
  if (!verifyPassword(currentPassword, account.passwordHash)) return res.status(401).json({ status: 'error', error: { code: 'CURRENT_PASSWORD_INCORRECT', message: 'Current password is incorrect.' } });
  if (!USERNAME_PATTERN.test(requestedUsername)) return res.status(400).json({ status: 'error', error: { code: 'INVALID_USERNAME', message: 'Username must be 3-64 characters using letters, numbers, dot, underscore, @ or hyphen.' } });
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
    const fresh = mapAccount(updated.recordset[0]);
    await loadAccounts(pool);
    const expiresAt = setSessionCookie(res, fresh);
    return res.json({
      status: 'ok',
      message: 'Account credentials updated. Other active sessions have been revoked.',
      user: { accountId: fresh.accountId, username: fresh.username, email: fresh.email, fullName: fresh.fullName, role: fresh.role },
      expiresAt,
    });
  } catch (error) {
    if (error.number === 2627 || error.number === 2601) return res.status(409).json({ status: 'error', error: { code: 'USERNAME_ALREADY_EXISTS', message: 'This username is already in use.' } });
    throw error;
  }
}
function publicAdminAccount(row) {
  return {
    accountId: Number(row.AccountId),
    accountCode: `CX-${String(row.AccountId).padStart(4, '0')}`,
    username: String(row.Username),
    email: row.Email ? String(row.Email) : null,
    fullName: row.FullName ? String(row.FullName) : null,
    role: row.Role === 'admin' ? 'admin' : 'user',
    createdAt: row.CreatedAt || null,
    updatedAt: row.UpdatedAt || null,
    lastLoginAt: row.LastLoginAt || null,
  };
}
async function countAdminAccounts(pool) {
  const result = await pool.request().query(`SELECT COUNT(*) AS AdminCount FROM dbo.DashboardAccounts WHERE Role = N'admin'`);
  return Number(result.recordset[0]?.AdminCount || 0);
}
function requireAdminApi(req, res, next) {
  if (!req.dashboardUser) return res.status(401).json({ status: 'error', error: { code: 'AUTH_REQUIRED', message: 'Please sign in.' } });
  if (req.dashboardUser.role !== 'admin') {
    return res.status(403).json({ status: 'error', error: { code: 'ADMIN_REQUIRED', message: 'Administrator access is required.' } });
  }
  next();
}
function requireAdminPage(req, res, next) {
  if (!req.dashboardUser) {
    const nextPath = encodeURIComponent(`${req.path}${req.url.includes('?') ? req.url.slice(req.path.length) : ''}`);
    return res.redirect(`/login.html?next=${nextPath}`);
  }
  if (req.dashboardUser.role !== 'admin') return res.redirect('/dashboard?admin=denied');
  next();
}
async function adminListAccountsHandler(req, res) {
  const pool = await poolPromise;
  await ensureDashboardTable(pool);
  const result = await pool.request().query(`
    SELECT AccountId, Username, Email, FullName, Role, CreatedAt, UpdatedAt, LastLoginAt
    FROM dbo.DashboardAccounts
    ORDER BY AccountId ASC
  `);
  const accounts = result.recordset.map(publicAdminAccount);
  return res.set('Cache-Control', 'no-store').json({ status: 'ok', count: accounts.length, accounts });
}
async function adminUpdateAccountHandler(req, res) {
  if (rejectCrossSite(req, res)) return;
  const accountId = Number(req.params.id);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return res.status(400).json({ status: 'error', error: { code: 'VALIDATION_ERROR', message: 'A valid account id is required.' } });
  }
  const pool = await poolPromise;
  await ensureDashboardTable(pool);
  const found = await pool.request()
    .input('accountId', sql.Int, accountId)
    .query(`SELECT AccountId, Username, Email, FullName, Role FROM dbo.DashboardAccounts WHERE AccountId = @accountId`);
  if (!found.recordset.length) {
    return res.status(404).json({ status: 'error', error: { code: 'ACCOUNT_NOT_FOUND', message: 'Dashboard account was not found.' } });
  }
  const target = found.recordset[0];
  const currentRole = target.Role === 'admin' ? 'admin' : 'user';
  const username = req.body?.username === undefined ? String(target.Username) : String(req.body.username).trim();
  const emailRaw = req.body?.email === undefined ? (target.Email || '') : String(req.body.email ?? '').trim().toLowerCase();
  const email = emailRaw || null;
  const fullNameRaw = req.body?.fullName === undefined ? (target.FullName || '') : String(req.body.fullName ?? '').trim();
  const fullName = fullNameRaw || null;
  const role = req.body?.role === undefined ? currentRole : String(req.body.role).trim().toLowerCase();
  const newPassword = String(req.body?.newPassword || '');

  if (!USERNAME_PATTERN.test(username)) {
    return res.status(400).json({ status: 'error', error: { code: 'INVALID_USERNAME', message: 'Username must be 3-64 characters using letters, numbers, dot, underscore, @ or hyphen.' } });
  }
  if (email && (!EMAIL_PATTERN.test(email) || email.length > 320)) {
    return res.status(400).json({ status: 'error', error: { code: 'INVALID_EMAIL', message: 'Enter a valid email address or leave it empty.' } });
  }
  if (fullName && fullName.length > 100) {
    return res.status(400).json({ status: 'error', error: { code: 'INVALID_FULL_NAME', message: 'Full name must be at most 100 characters.' } });
  }
  if (role !== 'user' && role !== 'admin') {
    return res.status(400).json({ status: 'error', error: { code: 'INVALID_ROLE', message: 'Role must be user or admin.' } });
  }
  if (newPassword && (newPassword.length < 12 || newPassword.length > 128)) {
    return res.status(400).json({ status: 'error', error: { code: 'INVALID_PASSWORD_LENGTH', message: 'Password must be between 12 and 128 characters.' } });
  }
  if (currentRole === 'admin' && role !== 'admin' && await countAdminAccounts(pool) <= 1) {
    return res.status(400).json({ status: 'error', error: { code: 'LAST_ADMIN', message: 'At least one administrator account must remain.' } });
  }

  const sets = [
    'Username = @username',
    'Email = @email',
    'FullName = @fullName',
    'Role = @role',
    'SessionVersion = SessionVersion + 1',
    'UpdatedAt = SYSUTCDATETIME()',
  ];
  const request = pool.request()
    .input('accountId', sql.Int, accountId)
    .input('username', sql.NVarChar(64), username)
    .input('email', sql.NVarChar(320), email)
    .input('fullName', sql.NVarChar(100), fullName)
    .input('role', sql.NVarChar(20), role);
  if (newPassword) {
    sets.push('PasswordHash = @passwordHash');
    request.input('passwordHash', sql.NVarChar(300), hashPassword(newPassword));
  }
  try {
    const updated = await request.query(`
      UPDATE dbo.DashboardAccounts
      SET ${sets.join(', ')}
      OUTPUT inserted.AccountId, inserted.Username, inserted.Email, inserted.FullName, inserted.Role,
             inserted.CreatedAt, inserted.UpdatedAt, inserted.LastLoginAt
      WHERE AccountId = @accountId
    `);
    await loadAccounts(pool);
    const isSelf = accountId === Number(req.dashboardUser.accountId);
    let refreshedUser;
    if (isSelf) {
      // Editing your own account bumps SessionVersion. Refresh the current
      // session in the same response so the admin page keeps working without
      // a manual logout/login round-trip.
      const fresh = accountsById.get(accountId) || mapAccount(updated.recordset[0]);
      setSessionCookie(res, fresh);
      refreshedUser = {
        accountId: fresh.accountId,
        username: fresh.username,
        email: fresh.email,
        fullName: fresh.fullName,
        role: fresh.role,
      };
    }
    return res.json({
      status: 'ok',
      message: 'Account updated. Older sessions were revoked.',
      account: publicAdminAccount(updated.recordset[0]),
      ...(refreshedUser ? { user: refreshedUser } : {}),
    });
  } catch (error) {
    if (error.number === 2627 || error.number === 2601) {
      return res.status(409).json({ status: 'error', error: { code: 'ACCOUNT_CONFLICT', message: 'That username or email is already in use.' } });
    }
    throw error;
  }
}
async function adminDeleteAccountHandler(req, res) {
  if (rejectCrossSite(req, res)) return;
  const accountId = Number(req.params.id);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return res.status(400).json({ status: 'error', error: { code: 'VALIDATION_ERROR', message: 'A valid account id is required.' } });
  }
  if (accountId === Number(req.dashboardUser.accountId)) {
    return res.status(400).json({ status: 'error', error: { code: 'CANNOT_DELETE_SELF', message: 'You cannot delete the account you are signed in with.' } });
  }
  const pool = await poolPromise;
  await ensureDashboardTable(pool);
  const found = await pool.request()
    .input('accountId', sql.Int, accountId)
    .query(`SELECT AccountId, Username, Role FROM dbo.DashboardAccounts WHERE AccountId = @accountId`);
  if (!found.recordset.length) {
    return res.status(404).json({ status: 'error', error: { code: 'ACCOUNT_NOT_FOUND', message: 'Dashboard account was not found.' } });
  }
  if (found.recordset[0].Role === 'admin' && await countAdminAccounts(pool) <= 1) {
    return res.status(400).json({ status: 'error', error: { code: 'LAST_ADMIN', message: 'At least one administrator account must remain.' } });
  }
  await pool.request().input('accountId', sql.Int, accountId)
    .query('DELETE FROM dbo.DashboardAccounts WHERE AccountId = @accountId');
  await loadAccounts(pool);
  return res.json({ status: 'ok', message: `Account ${found.recordset[0].Username} was deleted.` });
}

module.exports = {
  isAuthConfigured,
  initializeDashboardAuth,
  sessionMiddleware,
  loginHandler,
  registerHandler,
  logoutHandler,
  sessionHandler,
  requireDashboardPage,
  requireDashboardApi,
  requireAdminPage,
  requireAdminApi,
  getAccountHandler,
  updateCredentialsHandler,
  adminListAccountsHandler,
  adminUpdateAccountHandler,
  adminDeleteAccountHandler,
};
