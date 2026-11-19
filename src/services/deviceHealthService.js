'use strict';

const { sql, poolPromise } = require('../db/sqlserver');
const env = require('../config/env');
const { emitData } = require('./eventHub');

let offlineTimer = null;
let commandTimer = null;
let offlineRunning = false;
let commandRunning = false;

async function sweepOfflineDevices() {
  if (offlineRunning) return;
  offlineRunning = true;
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
    offlineRunning = false;
  }
}

async function sweepTimedOutCommands() {
  if (commandRunning) return;
  commandRunning = true;
  try {
    const pool = await poolPromise;
    const result = await pool.request()
      .input('timeoutSeconds', sql.Int, env.commandTimeoutSeconds)
      .query(`
        UPDATE c
        SET Status = N'timeout', CompletedAt = SYSUTCDATETIME()
        OUTPUT inserted.CommandId AS commandId,
               inserted.DeviceId AS deviceId,
               d.DeviceCode AS deviceCode,
               d.DeviceName AS deviceName,
               inserted.CommandType AS commandType,
               inserted.PayloadJson AS payloadJson,
               inserted.Status AS status,
               inserted.RequestedBy AS requestedBy,
               inserted.CompletedAt AS completedAt
        FROM dbo.Commands c
        INNER JOIN dbo.Devices d ON d.DeviceId = c.DeviceId
        WHERE c.Status IN (N'pending', N'sent')
          AND c.CreatedAt < DATEADD(SECOND, -@timeoutSeconds, SYSUTCDATETIME())
      `);
    for (const row of result.recordset) {
      emitData('command', { ...row, timedOut: true });
    }
    if (result.recordset.length) {
      console.log(`[Command timeout] Marked ${result.recordset.length} stale command(s) as timeout.`);
    }
  } catch (error) {
    console.error('[Command timeout] Sweep failed:', error.message);
  } finally {
    commandRunning = false;
  }
}

function startDeviceHealthService() {
  if (offlineTimer) return;
  offlineTimer = setInterval(sweepOfflineDevices, env.deviceSweepIntervalSeconds * 1000);
  offlineTimer.unref();
  commandTimer = setInterval(sweepTimedOutCommands, env.commandTimeoutSweepSeconds * 1000);
  commandTimer.unref();
  void sweepOfflineDevices();
  // Clean up old pending/sent rows on boot so automation cannot stay blocked
  // forever by a command whose device response was never received.
  void sweepTimedOutCommands();
}

function stopDeviceHealthService() {
  if (offlineTimer) clearInterval(offlineTimer);
  if (commandTimer) clearInterval(commandTimer);
  offlineTimer = null;
  commandTimer = null;
}

module.exports = {
  startDeviceHealthService,
  stopDeviceHealthService,
  sweepOfflineDevices,
  sweepTimedOutCommands,
};
