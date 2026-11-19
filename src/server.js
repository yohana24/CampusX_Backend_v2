'use strict';

require('dotenv').config();

const app = require('./app');
const env = require('./config/env');
const { getPool, closePool } = require('./db/sqlserver');
const { closeStreams } = require('./routes/api');

const { startMqttService } = require('./services/mqttService');
const { endClient } = require('./services/mqttClient');

const {
  startDeviceHealthService,
  stopDeviceHealthService,
} = require('./services/deviceHealthService');

const {
  initializeDashboardAuth,
  isAuthConfigured,
} = require('./middleware/dashboardAuth');

let server;
let shuttingDown = false;

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function initializeAuthWithRetry() {
  let attempt = 0;
  while (!shuttingDown) {
    attempt += 1;
    try {
      const pool = await getPool();
      await initializeDashboardAuth(pool);
      console.log('[Auth] Dashboard authentication initialized.');
      return;
    } catch (error) {
      if (shuttingDown) return;
      const waitMs = Math.min(10000, 1000 * attempt);
      console.warn(`[Auth] Not ready (attempt ${attempt}): ${error.message}. Retrying in ${waitMs} ms.`);
      await delay(waitMs);
    }
  }
}

function listenHttp() {
  server = app.listen(env.port, env.host, () => {
    console.log(`[HTTP] CampusX Backend listening at http://${env.host}:${env.port}`);
    console.log(`[HTTP] Docs: http://${env.host}:${env.port}/docs`);
    if (!isAuthConfigured()) {
      console.warn('[Security] Dashboard auth is still initializing; API returns 503 until SQL Server is ready.');
    }
    if (!env.apiKey) {
      console.warn('[Security] API_KEY is empty. Keep HOST on loopback during development.');
    }
  });
  server.on('error', (error) => {
    console.error('[HTTP] Listen failed:', error.message);
    process.exitCode = 1;
  });
}

function closeHttpServer() {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, env.httpShutdownTimeoutMs);
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[Shutdown] ${signal} received`);
  const forceExit = setTimeout(() => {
    console.error('[Shutdown] Timed out; forcing exit.');
    process.exit(1);
  }, env.forceExitTimeoutMs);
  forceExit.unref?.();

  stopDeviceHealthService();
  // Tell live dashboards to reconnect elsewhere instead of holding HTTP open.
  closeStreams('server_shutdown');
  await closeHttpServer();
  await endClient(false, env.mqttShutdownTimeoutMs);
  await closePool();

  clearTimeout(forceExit);
  console.log('[Shutdown] Clean shutdown complete.');
  process.exitCode = 0;
  // Let stdout flush and let the event loop drain naturally. If something
  // keeps it alive (for example an open stdin pipe), force exit shortly after.
  const finalExit = setTimeout(() => process.exit(0), 1000);
  finalExit.unref?.();
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
// Ctrl+Break is the Windows equivalent and is the only one of the three that
// Node can deliver reliably to a child process on this platform.
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => { void shutdown('SIGBREAK'); });
}

// HTTP and MQTT start immediately. SQL Server may be slow or temporarily
// unavailable; /api/v1/health reports 'degraded' while auth retries in the
// background and every DB call reconnects through getPool().
listenHttp();
startMqttService();
startDeviceHealthService();
void initializeAuthWithRetry();

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled rejection:', reason?.stack || reason?.message || String(reason));
});
