
'use strict';

require('dotenv').config();

const app = require('./app');
const env = require('./config/env');

const { poolPromise, pool } = require('./db/sqlserver');

const {
  startMqttService,
  client: mqttClient
} = require('./services/mqttService');

const {
  startDeviceHealthService,
  stopDeviceHealthService
} = require('./services/deviceHealthService');

const {
  initializeDashboardAuth,
  isAuthConfigured
} = require('./middleware/dashboardAuth');

let server;
let shuttingDown = false;

async function main() {
  try {
    // 1. Connect to SQL Server
    const sqlPool = await poolPromise;

    await sqlPool.request().query('SELECT 1 AS connected');

    console.log(
      `[SQL Server] Connected to ${process.env.SQL_DATABASE || 'CampusX'}`
    );

    // 2. Initialize Dashboard account before HTTP starts
    await initializeDashboardAuth(sqlPool);

    console.log('[Auth] Dashboard authentication initialized.');

    // 3. Start MQTT and device health services
    startMqttService();
    startDeviceHealthService();

    // 4. Start HTTP server
    server = app.listen(env.port, env.host, () => {
      console.log(
        `[HTTP] CampusX Backend listening at http://${env.host}:${env.port}`
      );

      if (!isAuthConfigured()) {
        console.warn(
          '[Security] Dashboard account is not initialized. ' +
          'Check the root .env bootstrap values.'
        );
      }

      if (!env.apiKey) {
        console.warn(
          '[Security] API_KEY is empty. ' +
          'Keep HOST on loopback during development.'
        );
      }
    });

  } catch (error) {
    console.error(
      '[Startup] Backend did not start:',
      error.message
    );

    process.exitCode = 1;

    try {
      mqttClient.end(true);
    } catch {}

    try {
      await pool.close();
    } catch {}
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(`[Shutdown] ${signal} received`);

  stopDeviceHealthService();

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  await new Promise((resolve) => {
    mqttClient.end(false, {}, resolve);
  });

  try {
    await pool.close();
  } catch {}

  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

// Start application
void main();
