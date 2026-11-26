'use strict';

require('dotenv').config();

const env = require('../config/env');

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required. Set it in .env or the process environment.`);
  return value;
}

function booleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function optionalIntEnv(name) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer when set.`);
  }
  return value;
}

function odbcPart(key, value) {
  const text = typeof value === 'boolean'
    ? (value ? 'Yes' : 'No')
    : String(value ?? '');
  // ODBC braces quote values containing separators. A literal `}` is doubled.
  if (/[[\]{}();,?*=!@]/.test(text)) {
    return `${key}={${text.replace(/}/g, '}}')}`;
  }
  return `${key}=${text}`;
}

/**
 * SQL_SERVER accepts:
 *   host
 *   host\instance
 *   host,port
 *   host\instance,port
 * SQL_PORT overrides the parsed port.
 */
function parseServer(raw) {
  let host = String(raw).trim();
  let instanceName = null;
  let port = null;

  if (host.includes('\\')) {
    const [hostPart, instancePart] = host.split('\\', 2);
    host = hostPart;
    instanceName = instancePart || null;
  }
  if (host.includes(',')) {
    const [hostPart, portPart] = host.split(',', 2);
    host = hostPart;
    port = Number(portPart) || null;
  }
  const envPort = optionalIntEnv('SQL_PORT');
  if (envPort) port = envPort;

  return { host, instanceName, port };
}

const server = requiredEnv('SQL_SERVER');
const database = requiredEnv('SQL_DATABASE');
const encrypt = booleanEnv('SQL_ENCRYPT', false);
const trustServerCertificate = booleanEnv('SQL_TRUST_SERVER_CERTIFICATE', true);
// Tedious (pure JS) is the default so the server runs on Windows, Linux and
// Raspberry Pi without a native ODBC build. Windows integrated auth is kept
// only as an explicit legacy fallback for existing Windows-only setups.
const trustedConnection = booleanEnv('SQL_TRUSTED_CONNECTION', false);
const driver = process.env.SQL_DRIVER || 'ODBC Driver 18 for SQL Server';

const sqlUsername = String(process.env.SQL_USERNAME || '').trim();
const sqlPassword = String(process.env.SQL_PASSWORD || '');
if (!trustedConnection && (!sqlUsername || !sqlPassword)) {
  throw new Error(
    'SQL_USERNAME and SQL_PASSWORD are required when SQL_TRUSTED_CONNECTION=false. ' +
    'Use SQL authentication for Linux / Raspberry Pi deployments.'
  );
}

if (env.sqlPoolMin > env.sqlPoolMax) {
  throw new Error('SQL_POOL_MIN cannot be greater than SQL_POOL_MAX.');
}

const poolConfig = {
  max: env.sqlPoolMax,
  min: env.sqlPoolMin,
  idleTimeoutMillis: env.sqlPoolIdleTimeoutMs,
};

let sql;
let config;

if (trustedConnection) {
  // Windows-only legacy path. msnodesqlv8 is an optional dependency so Linux
  // and Raspberry Pi installs do not fail when the native module is absent.
  try {
    sql = require('mssql/msnodesqlv8');
  } catch (error) {
    throw new Error(
      'SQL_TRUSTED_CONNECTION=true needs the optional msnodesqlv8 module and ODBC Driver 18. ' +
      'For cross-platform deployments set SQL_TRUSTED_CONNECTION=false and use SQL_USERNAME/SQL_PASSWORD.'
    );
  }

  const connectionParts = [
    odbcPart('Driver', driver),
    odbcPart('Server', server),
    odbcPart('Database', database),
    odbcPart('Trusted_Connection', true),
    odbcPart('Encrypt', encrypt),
    odbcPart('TrustServerCertificate', trustServerCertificate),
  ];
  config = {
    connectionString: `${connectionParts.join(';')};`,
    connectionTimeout: env.sqlConnectionTimeoutMs,
    requestTimeout: env.sqlRequestTimeoutMs,
    pool: poolConfig,
    options: {
      encrypt,
      trustServerCertificate,
      trustedConnection: true,
    },
  };
} else {
  // Cross-platform path: mssql uses the pure-JS tedious TDS driver.
  sql = require('mssql');
  const { host, instanceName, port } = parseServer(server);
  config = {
    server: host,
    database,
    user: sqlUsername,
    password: sqlPassword,
    connectionTimeout: env.sqlConnectionTimeoutMs,
    requestTimeout: env.sqlRequestTimeoutMs,
    pool: poolConfig,
    options: {
      encrypt,
      trustServerCertificate,
      enableArithAbort: true,
      ...(instanceName ? { instanceName } : {}),
    },
    ...(port ? { port } : {}),
  };
}

const authMode = trustedConnection ? 'windows' : 'sql';
const driverName = trustedConnection ? 'msnodesqlv8' : 'tedious';

let activePool = null;
let connectingPromise = null;
let lastFailure = null;
let lastFailureAt = 0;

async function createPool() {
  const candidate = new sql.ConnectionPool(config);
  candidate.on('error', (error) => {
    console.error('[SQL Server] Pool error:', error.message);
    if (activePool === candidate) activePool = null;
  });
  await candidate.connect();
  await candidate.request().query('SELECT 1 AS ok');
  return candidate;
}

async function getPool() {
  if (activePool?.connected) return activePool;
  if (connectingPromise) return connectingPromise;

  const now = Date.now();
  if (lastFailure && now - lastFailureAt < env.sqlRetryCooldownMs) {
    throw lastFailure;
  }

  connectingPromise = (async () => {
    try {
      if (activePool) {
        try { await activePool.close(); } catch { /* stale pool; discard */ }
        activePool = null;
      }
      const pool = await createPool();
      activePool = pool;
      lastFailure = null;
      lastFailureAt = 0;
      console.log(`[SQL Server] Connected to ${database} on ${server} (${driverName}, ${authMode} auth)`);
      return pool;
    } catch (error) {
      lastFailure = error;
      lastFailureAt = Date.now();
      console.error('[SQL Server] Connection failed:', error.message);
      throw error;
    } finally {
      connectingPromise = null;
    }
  })();

  return connectingPromise;
}

async function closePool() {
  // Wait for an in-flight connection before closing; otherwise a late-resolving
  // connect() could publish a pool after shutdown already cleaned up.
  if (connectingPromise) {
    try { await connectingPromise; } catch { /* connection already failed */ }
  }
  const pool = activePool;
  activePool = null;
  if (pool) {
    try { await pool.close(); } catch { /* already closed */ }
  }
}

function getPoolState() {
  return {
    connected: Boolean(activePool?.connected),
    connecting: Boolean(connectingPromise),
    driver: driverName,
    auth: authMode,
    lastError: lastFailure?.message || null,
  };
}

/**
 * Backwards-compatible thenable for the ~50 legacy `await poolPromise` calls.
 * Unlike a real Promise, it reconnects on every use instead of staying rejected.
 */
const poolPromise = {
  then(onFulfilled, onRejected) {
    return getPool().then(onFulfilled, onRejected);
  },
  catch(onRejected) {
    return getPool().catch(onRejected);
  },
  finally(onFinally) {
    return getPool().finally(onFinally);
  },
  get [Symbol.toStringTag]() {
    return 'Promise';
  },
};

const poolCompatibility = {
  get connected() { return Boolean(activePool?.connected); },
  get connecting() { return Boolean(connectingPromise); },
  request() {
    if (!activePool?.connected) {
      throw new Error('SQL pool is not connected. Use getPool() before issuing a request.');
    }
    return activePool.request();
  },
};

module.exports = {
  sql,
  configSummary: { server, database, driver: driverName, auth: authMode },
  getPool,
  closePool,
  getPoolState,
  poolPromise,
  get pool() { return poolCompatibility; },
};
