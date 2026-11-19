'use strict';

const { sql, getPool } = require('../db/sqlserver');
const env = require('../config/env');
const { matchTopic } = require('../utils/mqttTopics');
const { emitData } = require('./eventHub');

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timeout', 'cancelled']);

function safeParseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function processCommandResponse(topic, rawMessage) {
  const match = matchTopic(env.commandResponseTopic, topic);
  if (!match) return null;
  const deviceCode = match.first;

  let response;
  try {
    response = JSON.parse(rawMessage.toString('utf8'));
  } catch {
    throw new Error('Command response is not valid JSON');
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Command response must be a JSON object');
  }

  const commandId = String(response.command_id ?? response.commandId ?? '');
  if (!/^\d+$/.test(commandId)) {
    throw new Error('command_id must match the numeric Commands.CommandId');
  }

  let success;
  if (typeof response.success === 'boolean') success = response.success;
  else if (response.status === 'completed') success = true;
  else if (response.status === 'failed') success = false;
  else throw new Error('Command response must include success:boolean or status completed/failed');

  const reportedState = response?.result?.state ?? response?.state;
  const normalizedState = typeof reportedState === 'string' ? reportedState.trim().toLowerCase() : '';
  const shouldPersistState = success && ['on', 'off'].includes(normalizedState);

  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  let stateEvent = null;
  let commandEvent = null;

  try {
    await tx.begin();

    // Lock the command row so two QoS-1 deliveries cannot both write an audit
    // entry or a device state row.
    const result = await tx.request()
      .input('commandId', sql.BigInt, commandId)
      .input('deviceCode', sql.NVarChar(100), deviceCode)
      .query(`
        SELECT c.CommandId, c.DeviceId, c.Status, c.CommandType,
               c.PayloadJson, c.RequestedBy, d.DeviceCode, d.DeviceName,
               r.RoomId, r.RoomCode, r.RoomName
        FROM dbo.Commands c WITH (UPDLOCK, HOLDLOCK)
        INNER JOIN dbo.Devices d ON d.DeviceId=c.DeviceId
        INNER JOIN dbo.Nodes n ON n.NodeId=d.NodeId
        LEFT JOIN dbo.Rooms r ON r.RoomId=n.RoomId
        WHERE c.CommandId=@commandId AND d.DeviceCode=@deviceCode
      `);
    const command = result.recordset[0];
    if (!command) throw new Error(`Command ${commandId} not found for device ${deviceCode}`);

    const existingStatus = String(command.Status || '').toLowerCase();
    if (TERMINAL_STATUSES.has(existingStatus)) {
      await tx.commit();
      return {
        ...command,
        commandId: command.CommandId,
        deviceCode: command.DeviceCode,
        deviceName: command.DeviceName,
        status: command.Status,
        response,
        duplicate: true,
        ignoredReason: 'command_already_terminal',
      };
    }

    const status = success ? 'completed' : 'failed';
    const updated = await tx.request()
      .input('commandId', sql.BigInt, commandId)
      .input('newStatus', sql.NVarChar(30), status)
      .query(`
        UPDATE dbo.Commands WITH (UPDLOCK, HOLDLOCK)
        SET Status=@newStatus, CompletedAt=SYSUTCDATETIME()
        OUTPUT inserted.CommandId AS commandId,
               inserted.DeviceId AS deviceId,
               inserted.Status AS status,
               inserted.CommandType AS commandType,
               inserted.PayloadJson AS payloadJson,
               inserted.RequestedBy AS requestedBy,
               inserted.CompletedAt AS completedAt
        WHERE CommandId=@commandId AND Status IN (N'pending', N'sent')
      `);

    const written = updated.recordset[0];
    if (!written) {
      await tx.commit();
      return {
        ...command,
        commandId: command.CommandId,
        deviceCode: command.DeviceCode,
        deviceName: command.DeviceName,
        status: command.Status,
        response,
        duplicate: true,
        ignoredReason: 'command_status_changed',
      };
    }

    const auditDetails = {
      requestedBy: command.RequestedBy || null,
      deviceCode: command.DeviceCode,
      deviceName: command.DeviceName,
      roomCode: command.RoomCode,
      roomName: command.RoomName,
      commandType: command.CommandType,
      payload: safeParseJson(command.PayloadJson, {}),
      response,
    };
    await tx.request()
      .input('action', sql.NVarChar(100), 'command_response')
      .input('entityType', sql.NVarChar(100), 'Command')
      .input('entityId', sql.NVarChar(100), commandId)
      .input('details', sql.NVarChar(sql.MAX), JSON.stringify(auditDetails))
      .query(`
        INSERT INTO dbo.Audit_Logs (Action, EntityType, EntityId, DetailsJson)
        VALUES (@action, @entityType, @entityId, @details)
      `);

    if (shouldPersistState) {
      const savedState = await tx.request()
        .input('deviceId', sql.Int, command.DeviceId)
        .input('stateCode', sql.NVarChar(100), 'relay_state')
        .input('stateValue', sql.NVarChar(250), normalizedState)
        .query(`
          INSERT INTO dbo.Device_States (DeviceId, StateCode, StateValue)
          OUTPUT inserted.StateId AS stateId,
                 inserted.DeviceId AS deviceId,
                 inserted.StateCode AS stateCode,
                 inserted.StateValue AS stateValue,
                 inserted.RecordedAt AS recordedAt
          VALUES (@deviceId, @stateCode, @stateValue)
        `);
      stateEvent = { ...savedState.recordset[0], deviceCode };
    }

    await tx.commit();
    commandEvent = {
      ...written,
      deviceCode: command.DeviceCode,
      deviceName: command.DeviceName,
      roomId: command.RoomId,
      roomCode: command.RoomCode,
      roomName: command.RoomName,
      response,
      duplicate: false,
    };
  } catch (error) {
    try { await tx.rollback(); } catch { /* ignore rollback errors */ }
    throw error;
  }

  if (stateEvent) emitData('device.state', stateEvent);
  emitData('command', commandEvent);
  return commandEvent;
}

module.exports = { processCommandResponse };
