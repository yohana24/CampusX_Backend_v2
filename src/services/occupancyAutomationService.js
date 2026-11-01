'use strict';

const { sql, poolPromise } = require('../db/sqlserver');
const env = require('../config/env');
const { publish } = require('./mqttClient');
const { emitData } = require('./eventHub');

let schemaReady;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const pool = await poolPromise;
      await pool.request().query(`
        IF COL_LENGTH('dbo.Commands', 'RequestedBy') IS NULL
          ALTER TABLE dbo.Commands ADD RequestedBy NVARCHAR(100) NULL;

        IF OBJECT_ID(N'dbo.Occupancy_Automation_Settings', N'U') IS NULL
        BEGIN
          CREATE TABLE dbo.Occupancy_Automation_Settings (
            RoomId INT NOT NULL CONSTRAINT PK_Occupancy_Automation_Settings PRIMARY KEY,
            IsEnabled BIT NOT NULL CONSTRAINT DF_Occupancy_Automation_IsEnabled DEFAULT (0),
            PersonThreshold INT NOT NULL CONSTRAINT DF_Occupancy_Automation_PersonThreshold DEFAULT (3),
            OffDelaySeconds INT NOT NULL CONSTRAINT DF_Occupancy_Automation_OffDelay DEFAULT (30),
            RestoreOnAboveThreshold BIT NOT NULL CONSTRAINT DF_Occupancy_Automation_Restore DEFAULT (1),
            FanDeviceCode NVARCHAR(100) NULL,
            LightDeviceCode NVARCHAR(100) NULL,
            CandidateState NVARCHAR(10) NULL,
            CandidateSince DATETIME2(3) NULL,
            LastObservedCount INT NULL,
            LastActionMessage NVARCHAR(250) NULL,
            LastActionAt DATETIME2(3) NULL,
            UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Occupancy_Automation_UpdatedAt DEFAULT (SYSUTCDATETIME()),
            CONSTRAINT FK_Occupancy_Automation_Rooms FOREIGN KEY (RoomId) REFERENCES dbo.Rooms(RoomId),
            CONSTRAINT CK_Occupancy_Automation_Threshold CHECK (PersonThreshold BETWEEN 0 AND 500),
            CONSTRAINT CK_Occupancy_Automation_Delay CHECK (OffDelaySeconds BETWEEN 5 AND 3600),
            CONSTRAINT CK_Occupancy_Automation_Candidate CHECK (CandidateState IS NULL OR CandidateState IN (N'on', N'off'))
          );
        END;
      `);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function parsePayloadState(payloadJson) {
  try {
    const payload = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson;
    const value = String(payload?.state || '').toLowerCase();
    return value === 'on' || value === 'off' ? value : null;
  } catch {
    return null;
  }
}

async function listRoomActuators(pool, roomId) {
  const result = await pool.request()
    .input('roomId', sql.Int, roomId)
    .query(`
      SELECT d.DeviceId AS deviceId, d.DeviceCode AS deviceCode,
             d.DeviceName AS deviceName, d.Status AS status,
             dt.Category AS category, dt.TypeName AS deviceType
      FROM dbo.Devices d
      INNER JOIN dbo.Nodes n ON n.NodeId = d.NodeId
      INNER JOIN dbo.Device_Types dt ON dt.DeviceTypeId = d.DeviceTypeId
      WHERE n.RoomId = @roomId AND d.IsActive = 1 AND n.IsActive = 1
        AND dt.Category = N'actuator'
      ORDER BY d.DeviceName;
    `);
  return result.recordset;
}

async function getOccupancyAutomationSettings(roomId) {
  await ensureSchema();
  const pool = await poolPromise;
  const room = await pool.request().input('roomId', sql.Int, roomId)
    .query('SELECT RoomId FROM dbo.Rooms WHERE RoomId=@roomId AND IsActive=1');
  if (!room.recordset.length) {
    const error = new Error('Selected room was not found or is inactive.');
    error.status = 404;
    throw error;
  }

  const actuators = await listRoomActuators(pool, roomId);
  const defaultFan = actuators.find((d) => String(d.DeviceCode).toLowerCase() === 'fan-relay-lab-01')
    || actuators.find((d) => /fan/i.test(`${d.DeviceCode} ${d.DeviceName}`))
    || null;
  const defaultLight = actuators.find((d) => /light|lamp/i.test(`${d.DeviceCode} ${d.DeviceName}`)) || null;

  await pool.request()
    .input('roomId', sql.Int, roomId)
    .input('defaultFan', sql.NVarChar(100), defaultFan?.deviceCode || null)
    .input('defaultLight', sql.NVarChar(100), defaultLight?.deviceCode || null)
    .query(`
      IF NOT EXISTS (
        SELECT 1 FROM dbo.Occupancy_Automation_Settings WITH (UPDLOCK, HOLDLOCK)
        WHERE RoomId=@roomId
      )
      BEGIN
        INSERT INTO dbo.Occupancy_Automation_Settings
          (RoomId, IsEnabled, PersonThreshold, OffDelaySeconds, RestoreOnAboveThreshold,
           FanDeviceCode, LightDeviceCode, LastActionMessage)
        VALUES (@roomId, 0, 3, 30, 1, @defaultFan, @defaultLight,
                N'Automation is disabled. Configure outputs and enable it to start.');
      END;
    `);

  const result = await pool.request().input('roomId', sql.Int, roomId).query(`
    SELECT RoomId AS roomId, IsEnabled AS isEnabled,
           PersonThreshold AS personThreshold, OffDelaySeconds AS offDelaySeconds,
           RestoreOnAboveThreshold AS restoreOnAboveThreshold,
           FanDeviceCode AS fanDeviceCode, LightDeviceCode AS lightDeviceCode,
           CandidateState AS candidateState, CandidateSince AS candidateSince,
           LastObservedCount AS lastObservedCount,
           LastActionMessage AS lastActionMessage, LastActionAt AS lastActionAt,
           UpdatedAt AS updatedAt
    FROM dbo.Occupancy_Automation_Settings WHERE RoomId=@roomId;
  `);

  return { settings: result.recordset[0], actuators };
}

async function validateActuator(pool, roomId, deviceCode, label) {
  if (!deviceCode) return null;
  const result = await pool.request()
    .input('roomId', sql.Int, roomId)
    .input('deviceCode', sql.NVarChar(100), deviceCode)
    .query(`
      SELECT TOP (1) d.DeviceId AS deviceId, d.DeviceCode AS deviceCode,
             d.DeviceName AS deviceName
      FROM dbo.Devices d
      INNER JOIN dbo.Nodes n ON n.NodeId=d.NodeId
      INNER JOIN dbo.Device_Types dt ON dt.DeviceTypeId=d.DeviceTypeId
      WHERE d.DeviceCode=@deviceCode AND n.RoomId=@roomId
        AND d.IsActive=1 AND n.IsActive=1 AND dt.Category=N'actuator';
    `);
  if (!result.recordset.length) {
    const error = new Error(`${label} must be an active actuator registered in the selected room.`);
    error.status = 400;
    throw error;
  }
  return result.recordset[0];
}

async function saveOccupancyAutomationSettings(input) {
  await ensureSchema();
  const pool = await poolPromise;
  const fanCode = input.fanDeviceCode || null;
  const lightCode = input.lightDeviceCode || null;
  if (fanCode && lightCode && fanCode.toLowerCase() === lightCode.toLowerCase()) {
    const error = new Error('Fan and Light must use different actuator devices.');
    error.status = 400;
    throw error;
  }
  if (input.isEnabled && !fanCode && !lightCode) {
    const error = new Error('Select at least one registered actuator before enabling occupancy automation.');
    error.status = 400;
    throw error;
  }
  await validateActuator(pool, input.roomId, fanCode, 'Fan output');
  await validateActuator(pool, input.roomId, lightCode, 'Light output');

  await getOccupancyAutomationSettings(input.roomId);
  await pool.request()
    .input('roomId', sql.Int, input.roomId)
    .input('enabled', sql.Bit, input.isEnabled)
    .input('threshold', sql.Int, input.personThreshold)
    .input('delay', sql.Int, input.offDelaySeconds)
    .input('restore', sql.Bit, input.restoreOnAboveThreshold)
    .input('fan', sql.NVarChar(100), fanCode)
    .input('light', sql.NVarChar(100), lightCode)
    .query(`
      UPDATE dbo.Occupancy_Automation_Settings
      SET IsEnabled=@enabled, PersonThreshold=@threshold,
          OffDelaySeconds=@delay, RestoreOnAboveThreshold=@restore,
          FanDeviceCode=@fan, LightDeviceCode=@light,
          CandidateState=NULL, CandidateSince=NULL,
          LastActionMessage=CASE WHEN @enabled=1 THEN N'Settings saved. Waiting for fresh occupancy readings.' ELSE N'Automation is disabled.' END,
          LastActionAt=SYSUTCDATETIME(), UpdatedAt=SYSUTCDATETIME()
      WHERE RoomId=@roomId;
    `);
  return getOccupancyAutomationSettings(input.roomId);
}

async function setAutomationMessage(pool, roomId, message, count = null) {
  await pool.request()
    .input('roomId', sql.Int, roomId)
    .input('message', sql.NVarChar(250), message)
    .input('count', sql.Int, count)
    .query(`
      UPDATE dbo.Occupancy_Automation_Settings
      SET LastObservedCount=COALESCE(@count, LastObservedCount),
          LastActionMessage=@message, LastActionAt=SYSUTCDATETIME(), UpdatedAt=SYSUTCDATETIME()
      WHERE RoomId=@roomId;
    `);
}

async function sendAutomationCommand(pool, device, desiredState) {
  const latest = await pool.request().input('deviceId', sql.Int, device.deviceId).query(`
    SELECT TOP (1) CommandId AS commandId, Status AS status,
           PayloadJson AS payloadJson, CreatedAt AS createdAt
    FROM dbo.Commands
    WHERE DeviceId=@deviceId AND CommandType=N'set_state'
    ORDER BY CreatedAt DESC, CommandId DESC;
  `);
  const previous = latest.recordset[0];
  if (previous) {
    const previousStatus = String(previous.status || '').toLowerCase();
    const previousState = parsePayloadState(previous.payloadJson);
    if (previousStatus === 'pending' || previousStatus === 'sent') {
      return { deviceCode: device.deviceCode, status: 'in_progress', message: 'A previous command is still in progress.' };
    }
      const confirmedStateResult = await pool.request()
    .input('deviceId', sql.Int, device.deviceId)
    .query(`
      SELECT TOP (1) LOWER(StateValue) AS stateValue
      FROM dbo.Device_States
      WHERE DeviceId=@deviceId
        AND LOWER(StateCode) IN (N'relay_state', N'power_state', N'state')
      ORDER BY RecordedAt DESC, StateId DESC;
    `);
  const confirmedState = String(confirmedStateResult.recordset[0]?.stateValue || '').toLowerCase();
  if (confirmedState === desiredState) {
    return { deviceCode: device.deviceCode, status: 'already_set', message: `SQL Server confirms the relay is already ${desiredState}.` };
  }
if (previousStatus === 'completed' && previousState === desiredState) {
      return { deviceCode: device.deviceCode, status: 'already_set', message: `Already ${desiredState}.` };
    }
    if (previousStatus === 'failed') {
      const ageMs = previous.createdAt ? Date.now() - new Date(previous.createdAt).getTime() : Infinity;
      if (ageMs < 60_000) {
        return { deviceCode: device.deviceCode, status: 'recent_failure', message: 'A recent command failed; retry is paused briefly.' };
      }
    }
  }

  const payloadJson = JSON.stringify({ state: desiredState });
  const inserted = await pool.request()
    .input('deviceId', sql.Int, device.deviceId)
    .input('requestedBy', sql.NVarChar(100), 'Occupancy Automation')
    .input('payload', sql.NVarChar(sql.MAX), payloadJson)
    .query(`
      INSERT INTO dbo.Commands(DeviceId, UserId, RequestedBy, CommandType, PayloadJson, Status)
      OUTPUT inserted.CommandId AS commandId, inserted.DeviceId AS deviceId,
             inserted.CommandType AS commandType, inserted.PayloadJson AS payloadJson,
             inserted.Status AS status, inserted.CreatedAt AS createdAt
      VALUES(@deviceId, NULL, @requestedBy, N'set_state', @payload, N'pending');
    `);
  const command = inserted.recordset[0];
  const topic = `${env.commandTopicPrefix}/${encodeURIComponent(device.deviceCode)}/commands`;
  try {
    await publish(topic, {
      command_id: String(command.commandId),
      type: 'set_state',
      payload: { state: desiredState },
    });
    await pool.request().input('id', sql.BigInt, command.commandId).query(`
      UPDATE dbo.Commands SET Status=N'sent'
      WHERE CommandId=@id AND Status=N'pending';
    `);
    emitData('command', {
      ...command,
      status: 'sent',
      deviceCode: device.deviceCode,
      deviceName: device.deviceName,
      requestedBy: 'Occupancy Automation',
      topic,
    });
    return { deviceCode: device.deviceCode, commandId: command.commandId, status: 'sent', message: `Sent ${desiredState.toUpperCase()}.` };
  } catch (error) {
    await pool.request().input('id', sql.BigInt, command.commandId).query(`
      UPDATE dbo.Commands SET Status=N'failed', CompletedAt=SYSUTCDATETIME()
      WHERE CommandId=@id AND Status=N'pending';
    `);
    return { deviceCode: device.deviceCode, commandId: command.commandId, status: 'failed', message: error.message };
  }
}

async function evaluateOccupancyAutomation({ deviceCode, count, receivedAt }) {
  const numericCount = Number(count);
  if (!deviceCode || !Number.isInteger(numericCount) || numericCount < 0) return null;
  // This function is called only for a newly inserted people_count row.
  // Duplicate telemetry messages are skipped by telemetryService before this point.

  await ensureSchema();
  const pool = await poolPromise;
  const source = await pool.request().input('deviceCode', sql.NVarChar(100), deviceCode).query(`
    SELECT TOP (1) d.DeviceId AS deviceId, d.DeviceCode AS deviceCode, n.RoomId AS roomId
    FROM dbo.Devices d
    INNER JOIN dbo.Nodes n ON n.NodeId=d.NodeId
    WHERE d.DeviceCode=@deviceCode AND d.IsActive=1 AND n.IsActive=1;
  `);
  const cvDevice = source.recordset[0];
  if (!cvDevice) return null;

  const result = await pool.request().input('roomId', sql.Int, cvDevice.roomId).query(`
    SELECT IsEnabled AS isEnabled, PersonThreshold AS personThreshold,
           OffDelaySeconds AS offDelaySeconds, RestoreOnAboveThreshold AS restoreOnAboveThreshold,
           FanDeviceCode AS fanDeviceCode, LightDeviceCode AS lightDeviceCode
    FROM dbo.Occupancy_Automation_Settings WHERE RoomId=@roomId;
  `);
  const settings = result.recordset[0];
  if (!settings || !settings.isEnabled) return null;

  let desiredState = null;
  if (numericCount <= Number(settings.personThreshold)) desiredState = 'off';
  else if (settings.restoreOnAboveThreshold) desiredState = 'on';

  if (!desiredState) {
    await pool.request().input('roomId', sql.Int, cvDevice.roomId).input('count', sql.Int, numericCount).query(`
      UPDATE dbo.Occupancy_Automation_Settings
      SET CandidateState=NULL, CandidateSince=NULL, LastObservedCount=@count,
          LastActionMessage=N'Occupancy is above the OFF threshold. Automatic restore is disabled.',
          LastActionAt=SYSUTCDATETIME(), UpdatedAt=SYSUTCDATETIME()
      WHERE RoomId=@roomId;
    `);
    return null;
  }

  const candidate = await pool.request()
    .input('roomId', sql.Int, cvDevice.roomId)
    .input('desired', sql.NVarChar(10), desiredState)
    .input('count', sql.Int, numericCount)
    .query(`
      DECLARE @now DATETIME2(3)=SYSUTCDATETIME();
      UPDATE dbo.Occupancy_Automation_Settings
      SET CandidateSince=CASE WHEN CandidateState=@desired AND CandidateSince IS NOT NULL
                              THEN CandidateSince ELSE @now END,
          CandidateState=@desired, LastObservedCount=@count,
          LastActionMessage=N'Checking that the occupancy condition remains stable.',
          LastActionAt=@now, UpdatedAt=@now
      OUTPUT DATEDIFF(SECOND, inserted.CandidateSince, @now) AS elapsedSeconds,
             inserted.OffDelaySeconds AS offDelaySeconds
      WHERE RoomId=@roomId;
    `);
  const timing = candidate.recordset[0];
  if (!timing) return null;
  if (Number(timing.elapsedSeconds) < Number(timing.offDelaySeconds)) return { roomId: cvDevice.roomId, desiredState, status: 'confirming' };

  const outputs = [settings.fanDeviceCode, settings.lightDeviceCode].filter(Boolean);
  const outcomes = [];
  for (const code of outputs) {
    const targetResult = await pool.request()
      .input('roomId', sql.Int, cvDevice.roomId)
      .input('deviceCode', sql.NVarChar(100), code)
      .query(`
        SELECT TOP (1) d.DeviceId AS deviceId, d.DeviceCode AS deviceCode,
               d.DeviceName AS deviceName
        FROM dbo.Devices d
        INNER JOIN dbo.Nodes n ON n.NodeId=d.NodeId
        INNER JOIN dbo.Device_Types dt ON dt.DeviceTypeId=d.DeviceTypeId
        WHERE d.DeviceCode=@deviceCode AND n.RoomId=@roomId
          AND d.IsActive=1 AND n.IsActive=1 AND dt.Category=N'actuator';
      `);
    if (!targetResult.recordset.length) {
      outcomes.push({ deviceCode: code, status: 'not_registered', message: 'Configured actuator is no longer active in this room.' });
      continue;
    }
    outcomes.push(await sendAutomationCommand(pool, targetResult.recordset[0], desiredState));
  }

  const sent = outcomes.filter((item) => item.status === 'sent').length;
  const details = outcomes.map((item) => `${item.deviceCode}: ${item.message}`).join(' | ');
  const summary = sent
    ? `Occupancy ${numericCount} (threshold ${settings.personThreshold}): ${details}`
    : (details || 'No actuator output is configured.');
  await setAutomationMessage(pool, cvDevice.roomId, summary.slice(0, 250), numericCount);
  emitData('occupancy.automation', {
    roomId: cvDevice.roomId,
    count: numericCount,
    threshold: Number(settings.personThreshold),
    desiredState,
    outcomes,
  });
  console.log(`[Occupancy Automation] Room ${cvDevice.roomId}: count=${numericCount}, target=${desiredState}, ${summary}`);
  return { roomId: cvDevice.roomId, count: numericCount, desiredState, outcomes };
}

module.exports = {
  ensureSchema,
  getOccupancyAutomationSettings,
  saveOccupancyAutomationSettings,
  evaluateOccupancyAutomation,
};
