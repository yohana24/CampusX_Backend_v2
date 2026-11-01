'use strict';

const { sql, poolPromise } = require('../db/sqlserver');
const env = require('../config/env');
const { emitData } = require('./eventHub');

let timer = null;
let running = false;

async function sweepOfflineDevices() {
  if (running) return;
  running = true;
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('offlineSeconds', sql.Int, env.deviceOfflineSeconds)
      .query(`
        UPDATE d
        SET Status = N'offline'
        OUTPUT inserted.DeviceId, inserted.DeviceCode, deleted.Status AS previousStatus
        FROM dbo.Devices d
        INNER JOIN dbo.Nodes n ON n.NodeId = d.NodeId
        WHERE d.IsActive = 1 AND d.Status = N'online'
          AND (n.LastSeenAt IS NULL OR n.LastSeenAt < DATEADD(SECOND, -@offlineSeconds, SYSUTCDATETIME()))
      `);
    for (const row of result.recordset) emitData('device.status', { deviceId: row.DeviceId, deviceCode: row.DeviceCode, status: 'offline' });
  } catch (error) {
    console.error('[Device health] Offline sweep failed:', error.message);
  } finally {
    running = false;
  }
}

function startDeviceHealthService() {
  if (timer) return;
  timer = setInterval(sweepOfflineDevices, env.deviceSweepIntervalSeconds * 1000);
  timer.unref();
  void sweepOfflineDevices();
}

function stopDeviceHealthService() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startDeviceHealthService, stopDeviceHealthService, sweepOfflineDevices };
