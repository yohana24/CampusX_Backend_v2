'use strict';

require('dotenv').config();

const path = require('node:path');
const mqtt = require('mqtt');
const env = require(path.join(__dirname, '..', 'src', 'config', 'env'));
const { getPool, closePool } = require(path.join(__dirname, '..', 'src', 'db', 'sqlserver'));

async function checkSql() {
  const started = Date.now();
  const pool = await getPool();
  const result = await pool.request().query('SELECT @@SERVERNAME AS serverName, DB_NAME() AS databaseName');
  const row = result.recordset[0] || {};
  console.log(`PASS SQL Server  ${row.serverName} / ${row.databaseName} (${Date.now() - started} ms)`);
}

function checkMqtt() {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(env.mqttUrl, {
      clientId: `campusx-check-${process.pid}-${Math.random().toString(16).slice(2)}`,
      connectTimeout: env.mqttConnectTimeoutMs,
      reconnectPeriod: 0,
      clean: true,
      ...(env.mqttUsername ? { username: env.mqttUsername, password: env.mqttPassword } : {}),
    });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      client.end(true, {}, () => {
        if (error) reject(error);
        else resolve();
      });
    };
    client.once('connect', () => {
      console.log(`PASS MQTT         ${env.mqttUrl}`);
      finish();
    });
    client.once('error', (error) => finish(error));
    setTimeout(() => finish(new Error(`MQTT connect timed out after ${env.mqttConnectTimeoutMs} ms`)), env.mqttConnectTimeoutMs + 1000).unref?.();
  });
}

(async () => {
  let failed = false;
  try {
    await checkSql();
  } catch (error) {
    failed = true;
    console.error(`FAIL SQL Server  ${error.message}`);
  }
  try {
    await checkMqtt();
  } catch (error) {
    failed = true;
    console.error(`FAIL MQTT         ${error.message}`);
  }
  await closePool();
  process.exitCode = failed ? 1 : 0;
})();
