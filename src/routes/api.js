'use strict';

const express = require('express');
const { sql, poolPromise } = require('../db/sqlserver');
const env = require('../config/env');
const { publish, client: mqttClient } = require('../services/mqttClient');
const { hub, emitData } = require('../services/eventHub');
const { HttpError, asyncHandler } = require('../middleware/errors');

const router = express.Router();
router.use('/occupancy-automation', require('./occupancyAutomation'));

function requiredString(value, field, max = 150) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${field} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}
function optionalInt(value, field, min = 1) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new HttpError(400, 'VALIDATION_ERROR', `${field} must be an integer >= ${min}`);
  return n;
}
function requiredInt(value, field) {
  const n = optionalInt(value, field);
  if (n === null) throw new HttpError(400, 'VALIDATION_ERROR', `${field} is required`);
  return n;
}
function optionalBoolean(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw new HttpError(400, 'VALIDATION_ERROR', `${field} must be true or false`);
}
function jsonString(value, field, nullable = true) {
  if (value === undefined || value === null) {
    if (!nullable) throw new HttpError(400, 'VALIDATION_ERROR', `${field} is required`);
    return null;
  }
  if (typeof value === 'string') {
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw new HttpError(400, 'VALIDATION_ERROR', `${field} must contain valid JSON`); }
    if (parsed === null || typeof parsed !== 'object') throw new HttpError(400, 'VALIDATION_ERROR', `${field} must be a JSON object or array`);
    return value;
  }
  if (typeof value !== 'object') throw new HttpError(400, 'VALIDATION_ERROR', `${field} must be a JSON object or array`);
  try { return JSON.stringify(value); } catch { throw new HttpError(400, 'VALIDATION_ERROR', `${field} must be JSON serializable`); }
}
function intQuery(value, name) { return value == null || value === '' ? null : requiredInt(value, name); }
function dateQuery(value, name) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'VALIDATION_ERROR', `${name} must be a valid date/time`);
  return date;
}
function limitQuery(value, fallback = 100, maximum = 500) {
  if (value == null || value === '') return fallback;
  const valueNum = Number(value);
  if (!Number.isInteger(valueNum) || valueNum < 1 || valueNum > maximum) {
    throw new HttpError(400, 'VALIDATION_ERROR', `limit must be an integer between 1 and ${maximum}`);
  }
  return valueNum;
}
function resultOk(res, data, extra = {}) { return res.json({ status: 'ok', ...extra, data }); }
function checkStatus(value, allowed, field) {
  if (!allowed.includes(value)) throw new HttpError(400, 'VALIDATION_ERROR', `${field} must be one of: ${allowed.join(', ')}`);
}

async function getRooms(pool, req) {
  const active = optionalBoolean(req.query.active, 'active');
  const result = await pool.request()
    .input('active', sql.Bit, active)
    .input('search', sql.NVarChar(150), req.query.search ? `%${String(req.query.search).slice(0, 140)}%` : null)
    .query(`
      SELECT RoomId AS id, RoomId AS roomId, RoomCode AS roomCode,
             RoomName AS name, RoomName AS roomName, RoomId AS lab_id, Capacity AS capacity,
             LocationDetails AS locationDetails, IsActive AS isActive
      FROM dbo.Rooms
      WHERE (@active IS NULL OR IsActive = @active)
        AND (@search IS NULL OR RoomCode LIKE @search OR RoomName LIKE @search)
      ORDER BY RoomName
    `);
  return result.recordset;
}

function commandCompatibility(row) {
  let payload = row.payloadJson;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { /* retain raw string */ }
  }
  return { ...row, id: row.commandId, device_id: row.deviceId, type: row.commandType, payload, created_at: row.createdAt, completed_at: row.completedAt };
}

function telemetryCompatibility(row) {
  let value = row.valueNumeric;
  if (value === null || value === undefined) value = row.valueText;
  if ((value === null || value === undefined) && row.valueJson != null) {
    try { value = JSON.parse(row.valueJson); } catch { value = row.valueJson; }
  }
  return {
    ...row,
    id: row.telemetryId,
    device_id: row.deviceId,
    lab_id: row.roomId,
    metric: row.metricCode,
    value,
    recorded_at: row.recordedAt,
  };
}

// Health and dashboard
router.get('/health', asyncHandler(async (req, res) => {
  let database = 'disconnected';
  try { const p = await poolPromise; await p.request().query('SELECT 1 AS ok'); database = 'connected'; } catch { /* returned in health status */ }
  return res.status(database === 'connected' ? 200 : 503).json({
    status: database === 'connected' ? 'ok' : 'degraded',
    service: 'campusx-backend', database,
    mqtt: mqttClient.connected ? 'connected' : 'disconnected',
    time: new Date().toISOString(),
  });
}));
router.get('/sqlserver/health', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const r = await pool.request().query(`SELECT DB_NAME() AS databaseName, COUNT(*) AS tableCount FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'`);
  return resultOk(res, r.recordset[0]);
}));
router.get('/dashboard/summary', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const r = await pool.request().query(`
    SELECT
      (SELECT COUNT(*) FROM dbo.Rooms WHERE IsActive=1) AS activeRooms,
      (SELECT COUNT(*) FROM dbo.Devices WHERE IsActive=1) AS activeDevices,
      (SELECT COUNT(*) FROM dbo.Devices WHERE IsActive=1 AND Status=N'online') AS onlineDevices,
      (SELECT COUNT(*) FROM dbo.Alerts WHERE Status IN (N'open', N'acknowledged')) AS openAlerts,
      (SELECT COUNT_BIG(*) FROM dbo.Telemetry WHERE ReceivedAt >= DATEADD(DAY,-1,SYSUTCDATETIME())) AS readingsLast24Hours
  `);
  const a = await pool.request().query(`SELECT TOP (10) AlertId AS alertId, RoomId AS roomId, DeviceId AS deviceId, AlertType AS alertType, Severity AS severity, Message AS message, Status AS status, CreatedAt AS createdAt FROM dbo.Alerts ORDER BY CreatedAt DESC`);
  return resultOk(res, { ...r.recordset[0], recentAlerts: a.recordset });
}));

// Rooms (legacy /labs GET alias preserved for existing frontend clients)
router.get(['/rooms', '/labs'], asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const rows = await getRooms(pool, req);
  return resultOk(res, rows, { count: rows.length });
}));
router.post('/rooms', asyncHandler(async (req, res) => {
  const code = requiredString(req.body.roomCode ?? req.body.code, 'roomCode', 50);
  const name = requiredString(req.body.roomName ?? req.body.name, 'roomName', 150);
  const capacity = req.body.capacity == null ? null : Number(req.body.capacity);
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 0)) throw new HttpError(400, 'VALIDATION_ERROR', 'capacity must be a non-negative integer or null');
  const location = req.body.locationDetails == null ? null : requiredString(req.body.locationDetails, 'locationDetails', 250);
  const pool = await poolPromise;
  const r = await pool.request()
    .input('code', sql.NVarChar(50), code).input('name', sql.NVarChar(150), name)
    .input('capacity', sql.Int, capacity).input('location', sql.NVarChar(250), location)
    .query(`INSERT INTO dbo.Rooms(RoomCode,RoomName,Capacity,LocationDetails) OUTPUT inserted.RoomId AS roomId, inserted.RoomCode AS roomCode, inserted.RoomName AS roomName, inserted.Capacity AS capacity, inserted.LocationDetails AS locationDetails, inserted.IsActive AS isActive VALUES(@code,@name,@capacity,@location)`);
  emitData('room.created', r.recordset[0]);
  return res.status(201).json({ status: 'ok', data: r.recordset[0] });
}));
router.patch('/rooms/:id', asyncHandler(async (req, res) => {
  const id = requiredInt(req.params.id, 'roomId');
  const active = optionalBoolean(req.body.isActive, 'isActive');
  const name = req.body.roomName ?? req.body.name;
  const code = req.body.roomCode ?? req.body.code;
  const capacity = req.body.capacity;
  const location = req.body.locationDetails;
  if ([name, code, capacity, location, active].every((x) => x === undefined || x === null)) throw new HttpError(400, 'VALIDATION_ERROR', 'Provide at least one field to update');
  const pool = await poolPromise;
  const r = await pool.request()
    .input('id', sql.Int, id)
    .input('code', sql.NVarChar(50), code === undefined ? null : requiredString(code, 'roomCode', 50))
    .input('name', sql.NVarChar(150), name === undefined ? null : requiredString(name, 'roomName', 150))
    .input('capacity', sql.Int, capacity === undefined ? null : (capacity == null ? null : Number(capacity)))
    .input('location', sql.NVarChar(250), location === undefined ? null : (location == null ? null : String(location).slice(0, 250)))
    .input('active', sql.Bit, active)
    .input('hasCode', sql.Bit, code !== undefined).input('hasName', sql.Bit, name !== undefined)
    .input('hasCapacity', sql.Bit, capacity !== undefined).input('hasLocation', sql.Bit, location !== undefined)
    .input('hasActive', sql.Bit, active !== null)
    .query(`
      UPDATE dbo.Rooms SET
        RoomCode=CASE WHEN @hasCode=1 THEN @code ELSE RoomCode END,
        RoomName=CASE WHEN @hasName=1 THEN @name ELSE RoomName END,
        Capacity=CASE WHEN @hasCapacity=1 THEN @capacity ELSE Capacity END,
        LocationDetails=CASE WHEN @hasLocation=1 THEN @location ELSE LocationDetails END,
        IsActive=CASE WHEN @hasActive=1 THEN @active ELSE IsActive END
      OUTPUT inserted.RoomId AS roomId, inserted.RoomCode AS roomCode, inserted.RoomName AS roomName, inserted.Capacity AS capacity, inserted.LocationDetails AS locationDetails, inserted.IsActive AS isActive
      WHERE RoomId=@id
    `);
  if (!r.recordset.length) throw new HttpError(404, 'NOT_FOUND', 'Room not found');
  emitData('room.updated', r.recordset[0]);
  return resultOk(res, r.recordset[0]);
}));

// Node types, nodes, and device types
router.get('/node-types', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const r = await pool.request().query('SELECT NodeTypeId AS nodeTypeId, TypeName AS typeName FROM dbo.Node_Types ORDER BY TypeName');
  return resultOk(res, r.recordset, { count: r.recordset.length });
}));
router.post('/node-types', asyncHandler(async (req, res) => {
  const typeName = requiredString(req.body.typeName ?? req.body.name, 'typeName', 100);
  const pool = await poolPromise;
  const r = await pool.request().input('typeName', sql.NVarChar(100), typeName)
    .query('INSERT INTO dbo.Node_Types(TypeName) OUTPUT inserted.NodeTypeId AS nodeTypeId, inserted.TypeName AS typeName VALUES(@typeName)');
  return res.status(201).json({ status: 'ok', data: r.recordset[0] });
}));
router.get('/nodes', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const roomId = intQuery(req.query.roomId ?? req.query.labId, 'roomId');
  const r = await pool.request().input('roomId', sql.Int, roomId)
    .query(`SELECT n.NodeId AS nodeId, n.NodeCode AS nodeCode, n.RoomId AS roomId, r.RoomCode AS roomCode, r.RoomName AS roomName, n.NodeTypeId AS nodeTypeId, nt.TypeName AS nodeType, n.FirmwareVersion AS firmwareVersion, n.LastSeenAt AS lastSeenAt, n.IsActive AS isActive, n.ConfigJson AS configJson FROM dbo.Nodes n JOIN dbo.Rooms r ON r.RoomId=n.RoomId JOIN dbo.Node_Types nt ON nt.NodeTypeId=n.NodeTypeId WHERE (@roomId IS NULL OR n.RoomId=@roomId) ORDER BY n.NodeId DESC`);
  return resultOk(res, r.recordset, { count: r.recordset.length });
}));
router.post('/nodes', asyncHandler(async (req, res) => {
  const roomId = requiredInt(req.body.roomId, 'roomId');
  const nodeTypeId = requiredInt(req.body.nodeTypeId, 'nodeTypeId');
  const nodeCode = requiredString(req.body.nodeCode, 'nodeCode', 100);
  const firmware = req.body.firmwareVersion == null ? null : requiredString(req.body.firmwareVersion, 'firmwareVersion', 100);
  const configJson = jsonString(req.body.configJson, 'configJson');
  const pool = await poolPromise;
  const r = await pool.request().input('roomId', sql.Int, roomId).input('nodeTypeId', sql.Int, nodeTypeId)
    .input('nodeCode', sql.NVarChar(100), nodeCode).input('firmware', sql.NVarChar(100), firmware)
    .input('config', sql.NVarChar(sql.MAX), configJson)
    .query(`INSERT INTO dbo.Nodes(RoomId,NodeTypeId,NodeCode,FirmwareVersion,ConfigJson) OUTPUT inserted.NodeId AS nodeId, inserted.RoomId AS roomId, inserted.NodeTypeId AS nodeTypeId, inserted.NodeCode AS nodeCode, inserted.FirmwareVersion AS firmwareVersion, inserted.IsActive AS isActive VALUES(@roomId,@nodeTypeId,@nodeCode,@firmware,@config)`);
  emitData('node.created', r.recordset[0]);
  return res.status(201).json({ status: 'ok', data: r.recordset[0] });
}));
router.patch('/nodes/:id', asyncHandler(async (req, res) => {
  const id = requiredInt(req.params.id, 'nodeId');
  const roomId = req.body.roomId === undefined ? null : (req.body.roomId == null ? null : requiredInt(req.body.roomId, 'roomId'));
  const nodeTypeId = req.body.nodeTypeId === undefined ? null : (req.body.nodeTypeId == null ? null : requiredInt(req.body.nodeTypeId, 'nodeTypeId'));
  const nodeCode = req.body.nodeCode == null ? null : requiredString(req.body.nodeCode, 'nodeCode', 100);
  const firmware = req.body.firmwareVersion === undefined ? null : (req.body.firmwareVersion == null ? null : requiredString(req.body.firmwareVersion, 'firmwareVersion', 100));
  const active = optionalBoolean(req.body.isActive, 'isActive');
  const config = req.body.configJson === undefined ? null : jsonString(req.body.configJson, 'configJson');
  const hasFirmware = req.body.firmwareVersion !== undefined;
  const hasConfig = req.body.configJson !== undefined;
  if (roomId === null && nodeTypeId === null && nodeCode === null && !hasFirmware && active === null && !hasConfig) throw new HttpError(400, 'VALIDATION_ERROR', 'Provide at least one node field to update');
  const pool = await poolPromise;
  const r = await pool.request().input('id', sql.Int, id).input('roomId', sql.Int, roomId).input('nodeTypeId', sql.Int, nodeTypeId)
    .input('nodeCode', sql.NVarChar(100), nodeCode).input('firmware', sql.NVarChar(100), firmware).input('active', sql.Bit, active)
    .input('config', sql.NVarChar(sql.MAX), config)
    .input('hasRoom', sql.Bit, req.body.roomId !== undefined).input('hasType', sql.Bit, req.body.nodeTypeId !== undefined)
    .input('hasCode', sql.Bit, req.body.nodeCode !== undefined).input('hasFirmware', sql.Bit, hasFirmware)
    .input('hasActive', sql.Bit, active !== null).input('hasConfig', sql.Bit, hasConfig)
    .query(`UPDATE dbo.Nodes SET RoomId=CASE WHEN @hasRoom=1 THEN @roomId ELSE RoomId END, NodeTypeId=CASE WHEN @hasType=1 THEN @nodeTypeId ELSE NodeTypeId END, NodeCode=CASE WHEN @hasCode=1 THEN @nodeCode ELSE NodeCode END, FirmwareVersion=CASE WHEN @hasFirmware=1 THEN @firmware ELSE FirmwareVersion END, IsActive=CASE WHEN @hasActive=1 THEN @active ELSE IsActive END, ConfigJson=CASE WHEN @hasConfig=1 THEN @config ELSE ConfigJson END OUTPUT inserted.NodeId AS nodeId, inserted.RoomId AS roomId, inserted.NodeTypeId AS nodeTypeId, inserted.NodeCode AS nodeCode, inserted.FirmwareVersion AS firmwareVersion, inserted.IsActive AS isActive, inserted.ConfigJson AS configJson WHERE NodeId=@id`);
  if (!r.recordset.length) throw new HttpError(404, 'NOT_FOUND', 'Node not found');
  emitData('node.updated', r.recordset[0]);
  return resultOk(res, r.recordset[0]);
}));

router.get('/device-types', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const r = await pool.request().query('SELECT DeviceTypeId AS deviceTypeId, TypeName AS typeName, Category AS category, DefaultConfigJson AS defaultConfigJson FROM dbo.Device_Types ORDER BY TypeName');
  return resultOk(res, r.recordset, { count: r.recordset.length });
}));
router.post('/device-types', asyncHandler(async (req, res) => {
  const typeName = requiredString(req.body.typeName ?? req.body.name, 'typeName', 100);
  const category = requiredString(req.body.category, 'category', 50).toLowerCase();
  checkStatus(category, ['sensor', 'actuator', 'camera', 'other'], 'category');
  const configJson = jsonString(req.body.defaultConfigJson, 'defaultConfigJson');
  const pool = await poolPromise;
  const r = await pool.request().input('name', sql.NVarChar(100), typeName).input('category', sql.NVarChar(50), category).input('config', sql.NVarChar(sql.MAX), configJson)
    .query('INSERT INTO dbo.Device_Types(TypeName,Category,DefaultConfigJson) OUTPUT inserted.DeviceTypeId AS deviceTypeId, inserted.TypeName AS typeName, inserted.Category AS category, inserted.DefaultConfigJson AS defaultConfigJson VALUES(@name,@category,@config)');
  return res.status(201).json({ status: 'ok', data: r.recordset[0] });
}));

router.get('/devices', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const roomId = intQuery(req.query.roomId ?? req.query.labId, 'roomId');
  const nodeId = intQuery(req.query.nodeId, 'nodeId');
  const active = optionalBoolean(req.query.active, 'active');
  const status = req.query.status ? requiredString(req.query.status, 'status', 30) : null;
  if (status) checkStatus(status, ['unknown', 'online', 'offline', 'fault', 'maintenance'], 'status');
  const r = await pool.request().input('roomId', sql.Int, roomId).input('nodeId', sql.Int, nodeId)
    .input('active', sql.Bit, active).input('status', sql.NVarChar(30), status)
    .query(`SELECT d.DeviceId AS id, d.DeviceId AS deviceId, d.DeviceId AS device_id, d.DeviceCode AS deviceCode, d.DeviceCode AS device_code, d.DeviceName AS name, d.DeviceName AS deviceName, d.NodeId AS nodeId, n.NodeCode AS nodeCode, n.RoomId AS roomId, n.RoomId AS lab_id, r.RoomName AS roomName, d.DeviceTypeId AS deviceTypeId, dt.TypeName AS deviceType, dt.Category AS category, d.Status AS status, d.IsActive AS isActive, d.ConfigJson AS configJson, n.LastSeenAt AS lastSeenAt FROM dbo.Devices d JOIN dbo.Nodes n ON n.NodeId=d.NodeId JOIN dbo.Rooms r ON r.RoomId=n.RoomId JOIN dbo.Device_Types dt ON dt.DeviceTypeId=d.DeviceTypeId WHERE (@roomId IS NULL OR n.RoomId=@roomId) AND (@nodeId IS NULL OR d.NodeId=@nodeId) AND (@active IS NULL OR d.IsActive=@active) AND (@status IS NULL OR d.Status=@status) ORDER BY d.DeviceId DESC`);
  return resultOk(res, r.recordset, { count: r.recordset.length });
}));
router.post('/devices', asyncHandler(async (req, res) => {
  const nodeId = requiredInt(req.body.nodeId, 'nodeId');
  const deviceTypeId = requiredInt(req.body.deviceTypeId, 'deviceTypeId');
  const deviceCode = requiredString(req.body.deviceCode ?? req.body.device_id, 'deviceCode', 100);
  const deviceName = requiredString(req.body.deviceName ?? req.body.name ?? deviceCode, 'deviceName', 150);
  const configJson = jsonString(req.body.configJson, 'configJson');
  const pool = await poolPromise;
  const r = await pool.request().input('nodeId', sql.Int, nodeId).input('deviceTypeId', sql.Int, deviceTypeId)
    .input('deviceCode', sql.NVarChar(100), deviceCode).input('deviceName', sql.NVarChar(150), deviceName)
    .input('config', sql.NVarChar(sql.MAX), configJson)
    .query(`INSERT INTO dbo.Devices(NodeId,DeviceTypeId,DeviceCode,DeviceName,ConfigJson) OUTPUT inserted.DeviceId AS deviceId, inserted.NodeId AS nodeId, inserted.DeviceTypeId AS deviceTypeId, inserted.DeviceCode AS deviceCode, inserted.DeviceName AS deviceName, inserted.Status AS status, inserted.IsActive AS isActive VALUES(@nodeId,@deviceTypeId,@deviceCode,@deviceName,@config)`);
  emitData('device.created', r.recordset[0]);
  return res.status(201).json({ status: 'ok', data: r.recordset[0] });
}));
router.patch('/devices/:id', asyncHandler(async (req, res) => {
  const deviceId = requiredInt(req.params.id, 'deviceId');
  const active = optionalBoolean(req.body.isActive, 'isActive');
  const status = req.body.status == null ? null : requiredString(req.body.status, 'status', 30);
  if (status) checkStatus(status, ['unknown', 'online', 'offline', 'fault', 'maintenance'], 'status');
  const name = req.body.deviceName == null ? null : requiredString(req.body.deviceName, 'deviceName', 150);
  const configJson = req.body.configJson === undefined ? undefined : jsonString(req.body.configJson, 'configJson');
  if (active === null && status === null && name === null && configJson === undefined) throw new HttpError(400, 'VALIDATION_ERROR', 'Provide at least one field to update');
  const pool = await poolPromise;
  const r = await pool.request().input('id', sql.Int, deviceId).input('active', sql.Bit, active)
    .input('status', sql.NVarChar(30), status).input('name', sql.NVarChar(150), name)
    .input('config', sql.NVarChar(sql.MAX), configJson === undefined ? null : configJson)
    .input('hasActive', sql.Bit, active !== null).input('hasStatus', sql.Bit, status !== null)
    .input('hasName', sql.Bit, name !== null).input('hasConfig', sql.Bit, configJson !== undefined)
    .query(`UPDATE dbo.Devices SET IsActive=CASE WHEN @hasActive=1 THEN @active ELSE IsActive END, Status=CASE WHEN @hasStatus=1 THEN @status ELSE Status END, DeviceName=CASE WHEN @hasName=1 THEN @name ELSE DeviceName END, ConfigJson=CASE WHEN @hasConfig=1 THEN @config ELSE ConfigJson END OUTPUT inserted.DeviceId AS deviceId, inserted.DeviceCode AS deviceCode, inserted.DeviceName AS deviceName, inserted.Status AS status, inserted.IsActive AS isActive WHERE DeviceId=@id`);
  if (!r.recordset.length) throw new HttpError(404, 'NOT_FOUND', 'Device not found');
  emitData('device.updated', r.recordset[0]);
  return resultOk(res, r.recordset[0]);
}));

// Generic measurement dictionary and device capabilities
router.patch('/device-types/:id', asyncHandler(async (req, res) => {
  const id = requiredInt(req.params.id, 'deviceTypeId');
  const typeName = req.body.typeName == null ? null : requiredString(req.body.typeName, 'typeName', 100);
  const category = req.body.category == null ? null : requiredString(req.body.category, 'category', 50).toLowerCase();
  if (category) checkStatus(category, ['sensor', 'actuator', 'camera', 'other'], 'category');
  const config = req.body.defaultConfigJson === undefined ? null : jsonString(req.body.defaultConfigJson, 'defaultConfigJson');
  const hasConfig = req.body.defaultConfigJson !== undefined;
  if (typeName === null && category === null && !hasConfig) throw new HttpError(400, 'VALIDATION_ERROR', 'Provide a field to update');
  const pool = await poolPromise;
  const r = await pool.request().input('id', sql.Int, id).input('name', sql.NVarChar(100), typeName).input('category', sql.NVarChar(50), category).input('config', sql.NVarChar(sql.MAX), config)
    .input('hasName', sql.Bit, typeName !== null).input('hasCategory', sql.Bit, category !== null).input('hasConfig', sql.Bit, hasConfig)
    .query(`UPDATE dbo.Device_Types SET TypeName=CASE WHEN @hasName=1 THEN @name ELSE TypeName END, Category=CASE WHEN @hasCategory=1 THEN @category ELSE Category END, DefaultConfigJson=CASE WHEN @hasConfig=1 THEN @config ELSE DefaultConfigJson END OUTPUT inserted.DeviceTypeId AS deviceTypeId, inserted.TypeName AS typeName, inserted.Category AS category, inserted.DefaultConfigJson AS defaultConfigJson WHERE DeviceTypeId=@id`);
  if (!r.recordset.length) throw new HttpError(404, 'NOT_FOUND', 'Device type not found');
  return resultOk(res, r.recordset[0]);
}));

router.get('/metrics', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const r = await pool.request().query('SELECT MetricId AS metricId, MetricCode AS metricCode, DisplayName AS displayName, DefaultUnit AS defaultUnit, DataType AS dataType, MetadataJson AS metadataJson FROM dbo.Metrics ORDER BY DisplayName');
  return resultOk(res, r.recordset, { count: r.recordset.length });
}));
router.post('/metrics', asyncHandler(async (req, res) => {
  const metricCode = requiredString(req.body.metricCode, 'metricCode', 100);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(metricCode)) throw new HttpError(400, 'VALIDATION_ERROR', 'metricCode may contain letters, numbers, underscore, dot, colon and hyphen only');
  const displayName = requiredString(req.body.displayName, 'displayName', 150);
  const defaultUnit = req.body.defaultUnit == null ? null : requiredString(req.body.defaultUnit, 'defaultUnit', 30);
  const dataType = String(req.body.dataType || 'numeric').toLowerCase();
  checkStatus(dataType, ['numeric', 'text', 'json', 'boolean'], 'dataType');
  const metadataJson = jsonString(req.body.metadataJson, 'metadataJson');
  const pool = await poolPromise;
  const r = await pool.request().input('code', sql.NVarChar(100), metricCode).input('name', sql.NVarChar(150), displayName)
    .input('unit', sql.NVarChar(30), defaultUnit).input('dataType', sql.NVarChar(30), dataType).input('metadata', sql.NVarChar(sql.MAX), metadataJson)
    .query('INSERT INTO dbo.Metrics(MetricCode,DisplayName,DefaultUnit,DataType,MetadataJson) OUTPUT inserted.MetricId AS metricId, inserted.MetricCode AS metricCode, inserted.DisplayName AS displayName, inserted.DefaultUnit AS defaultUnit, inserted.DataType AS dataType, inserted.MetadataJson AS metadataJson VALUES(@code,@name,@unit,@dataType,@metadata)');
  emitData('metric.created', r.recordset[0]);
  return res.status(201).json({ status: 'ok', data: r.recordset[0] });
}));
router.patch('/metrics/:id', asyncHandler(async (req, res) => {
  const id = requiredInt(req.params.id, 'metricId');
  const metricCode = req.body.metricCode == null ? null : requiredString(req.body.metricCode, 'metricCode', 100);
  if (metricCode && !/^[a-zA-Z0-9_.:-]+$/.test(metricCode)) throw new HttpError(400, 'VALIDATION_ERROR', 'metricCode may contain letters, numbers, underscore, dot, colon and hyphen only');
  const displayName = req.body.displayName == null ? null : requiredString(req.body.displayName, 'displayName', 150);
  const unit = req.body.defaultUnit === undefined ? null : (req.body.defaultUnit == null ? null : requiredString(req.body.defaultUnit, 'defaultUnit', 30));
  const dataType = req.body.dataType == null ? null : String(req.body.dataType).toLowerCase();
  if (dataType) checkStatus(dataType, ['numeric', 'text', 'json', 'boolean'], 'dataType');
  const metadata = req.body.metadataJson === undefined ? null : jsonString(req.body.metadataJson, 'metadataJson');
  const hasUnit = req.body.defaultUnit !== undefined;
  const hasMetadata = req.body.metadataJson !== undefined;
  if (metricCode === null && displayName === null && !hasUnit && dataType === null && !hasMetadata) throw new HttpError(400, 'VALIDATION_ERROR', 'Provide a field to update');
  const pool = await poolPromise;
  const r = await pool.request().input('id', sql.Int, id).input('code', sql.NVarChar(100), metricCode).input('name', sql.NVarChar(150), displayName)
    .input('unit', sql.NVarChar(30), unit).input('dataType', sql.NVarChar(30), dataType).input('metadata', sql.NVarChar(sql.MAX), metadata)
    .input('hasCode', sql.Bit, metricCode !== null).input('hasName', sql.Bit, displayName !== null).input('hasUnit', sql.Bit, hasUnit)
    .input('hasType', sql.Bit, dataType !== null).input('hasMetadata', sql.Bit, hasMetadata)
    .query(`UPDATE dbo.Metrics SET MetricCode=CASE WHEN @hasCode=1 THEN @code ELSE MetricCode END, DisplayName=CASE WHEN @hasName=1 THEN @name ELSE DisplayName END, DefaultUnit=CASE WHEN @hasUnit=1 THEN @unit ELSE DefaultUnit END, DataType=CASE WHEN @hasType=1 THEN @dataType ELSE DataType END, MetadataJson=CASE WHEN @hasMetadata=1 THEN @metadata ELSE MetadataJson END OUTPUT inserted.MetricId AS metricId, inserted.MetricCode AS metricCode, inserted.DisplayName AS displayName, inserted.DefaultUnit AS defaultUnit, inserted.DataType AS dataType, inserted.MetadataJson AS metadataJson WHERE MetricId=@id`);
  if (!r.recordset.length) throw new HttpError(404, 'NOT_FOUND', 'Metric not found');
  emitData('metric.updated', r.recordset[0]);
  return resultOk(res, r.recordset[0]);
}));

router.get('/device-capabilities', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const deviceTypeId = intQuery(req.query.deviceTypeId, 'deviceTypeId');
  const r = await pool.request().input('deviceTypeId', sql.Int, deviceTypeId)
    .query(`SELECT dc.CapabilityId AS capabilityId, dc.DeviceTypeId AS deviceTypeId, dt.TypeName AS deviceType, dc.MetricId AS metricId, m.MetricCode AS metricCode, m.DisplayName AS displayName, dc.CapabilityType AS capabilityType, dc.ConfigJson AS configJson FROM dbo.Device_Capabilities dc JOIN dbo.Device_Types dt ON dt.DeviceTypeId=dc.DeviceTypeId JOIN dbo.Metrics m ON m.MetricId=dc.MetricId WHERE (@deviceTypeId IS NULL OR dc.DeviceTypeId=@deviceTypeId) ORDER BY dt.TypeName,m.DisplayName`);
  return resultOk(res, r.recordset, { count: r.recordset.length });
}));
router.post('/device-capabilities', asyncHandler(async (req, res) => {
  const deviceTypeId = requiredInt(req.body.deviceTypeId, 'deviceTypeId');
  const metricId = requiredInt(req.body.metricId, 'metricId');
  const capabilityType = String(req.body.capabilityType || 'read').toLowerCase();
  checkStatus(capabilityType, ['read', 'write', 'event'], 'capabilityType');
  const configJson = jsonString(req.body.configJson, 'configJson');
  const pool = await poolPromise;
  const r = await pool.request().input('deviceTypeId', sql.Int, deviceTypeId).input('metricId', sql.Int, metricId)
    .input('capabilityType', sql.NVarChar(30), capabilityType).input('config', sql.NVarChar(sql.MAX), configJson)
    .query(`INSERT INTO dbo.Device_Capabilities(DeviceTypeId,MetricId,CapabilityType,ConfigJson) OUTPUT inserted.CapabilityId AS capabilityId, inserted.DeviceTypeId AS deviceTypeId, inserted.MetricId AS metricId, inserted.CapabilityType AS capabilityType, inserted.ConfigJson AS configJson VALUES(@deviceTypeId,@metricId,@capabilityType,@config)`);
  return res.status(201).json({ status: 'ok', data: r.recordset[0] });
}));

router.patch('/device-capabilities/:id', asyncHandler(async (req, res) => {
  const id = requiredInt(req.params.id, 'capabilityId');
  const capabilityType = req.body.capabilityType == null ? null : String(req.body.capabilityType).toLowerCase();
  if (capabilityType) checkStatus(capabilityType, ['read', 'write', 'event'], 'capabilityType');
  const config = req.body.configJson === undefined ? null : jsonString(req.body.configJson, 'configJson');
  const hasConfig = req.body.configJson !== undefined;
  if (!capabilityType && !hasConfig) throw new HttpError(400, 'VALIDATION_ERROR', 'Provide capabilityType and/or configJson');
  const pool = await poolPromise;
  const r = await pool.request().input('id', sql.Int, id).input('type', sql.NVarChar(30), capabilityType).input('config', sql.NVarChar(sql.MAX), config)
    .input('hasType', sql.Bit, capabilityType !== null).input('hasConfig', sql.Bit, hasConfig)
    .query(`UPDATE dbo.Device_Capabilities SET CapabilityType=CASE WHEN @hasType=1 THEN @type ELSE CapabilityType END, ConfigJson=CASE WHEN @hasConfig=1 THEN @config ELSE ConfigJson END OUTPUT inserted.CapabilityId AS capabilityId, inserted.DeviceTypeId AS deviceTypeId, inserted.MetricId AS metricId, inserted.CapabilityType AS capabilityType, inserted.ConfigJson AS configJson WHERE CapabilityId=@id`);
  if (!r.recordset.length) throw new HttpError(404, 'NOT_FOUND', 'Device capability not found');
  return resultOk(res, r.recordset[0]);
}));

// Alert rules — thresholds are stored in SQL, so adding a new rule does not change JS.
router.get('/alert-rules', asyncHandler(async (req, res) => {
  const pool = await poolPromise;
  const metricId = intQuery(req.query.metricId, 'metricId');
  const roomId = intQuery(req.query.roomId, 'roomId');
  const r = await pool.request().input('metricId', sql.Int, metricId).input('roomId', sql.Int, roomId)
    .query(`SELECT ar.RuleId AS ruleId, ar.MetricId AS metricId, m.MetricCode AS metricCode, ar.RoomId AS roomId, r.RoomName AS roomName, ar.RuleName AS ruleName, ar.Operator AS operator, ar.Threshold AS threshold, ar.DurationSeconds AS durationSeconds, ar.IsEnabled AS isEnabled, ar.ConfigJson AS configJson FROM dbo.Alert_Rules ar JOIN dbo.Metrics m ON m.MetricId=ar.MetricId LEFT JOIN dbo.Rooms r ON r.RoomId=ar.RoomId WHERE (@metricId IS NULL OR ar.MetricId=@metricId) AND (@roomId IS NULL OR ar.RoomId=@roomId OR ar.RoomId IS NULL) ORDER BY ar.MetricId, ar.Threshold`);
  return resultOk(res, r.recordset, { count: r.recordset.length });
}));
router.post('/alert-rules', asyncHandler(async (req, res) => {
  const metricId = requiredInt(req.body.metricId, 'metricId');
  const roomId = req.body.roomId == null ? null : requiredInt(req.body.roomId, 'roomId');
  const ruleName = requiredString(req.body.ruleName, 'ruleName', 150);
  const operator = requiredString(req.body.operator, 'operator', 10);
  checkStatus(operator, ['>', '>=', '<', '<=', '=', '!=', 'changed'], 'operator');
  const threshold = req.body.threshold == null ? null : Number(req.body.threshold);
  if (operator !== 'changed' && (threshold === null || !Number.isFinite(threshold))) throw new HttpError(400, 'VALIDATION_ERROR', 'threshold must be numeric for this operator');
  const durationSeconds = req.body.durationSeconds == null ? 0 : Number(req.body.durationSeconds);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 0) throw new HttpError(400, 'VALIDATION_ERROR', 'durationSeconds must be a non-negative integer');
  const isEnabled = req.body.isEnabled === undefined ? true : optionalBoolean(req.body.isEnabled, 'isEnabled');
  const configJson = jsonString(req.body.configJson, 'configJson');
  if (configJson) {
    const config = JSON.parse(configJson);
    if (config.severity != null) checkStatus(config.severity, ['info', 'warning', 'critical'], 'configJson.severity');
  }
  const pool = await poolPromise;
  const r = await pool.request().input('metricId', sql.Int, metricId).input('roomId', sql.Int, roomId)
    .input('name', sql.NVarChar(150), ruleName).input('operator', sql.NVarChar(10), operator)
    .input('threshold', sql.Decimal(18, 6), threshold).input('duration', sql.Int, durationSeconds)
    .input('enabled', sql.Bit, isEnabled).input('config', sql.NVarChar(sql.MAX), configJson)
    .query(`INSERT INTO dbo.Alert_Rules(MetricId,RoomId,RuleName,Operator,Threshold,DurationSeconds,IsEnabled,ConfigJson) OUTPUT inserted.RuleId AS ruleId, inserted.MetricId AS metricId, inserted.RoomId AS roomId, inserted.RuleName AS ruleName, inserted.Operator AS operator, inserted.Threshold AS threshold, inserted.DurationSeconds AS durationSeconds, inserted.IsEnabled AS isEnabled, inserted.ConfigJson AS configJson VALUES(@metricId,@roomId,@name,@operator,@threshold,@duration,@enabled,@config)`);
  emitData('alert-rule.created', r.recordset[0]);
  return res.status(201).json({ status: 'ok', data: r.recordset[0] });
}));
router.patch('/alert-rules/:id', asyncHandler(async (req, res) => {
  const id = requiredInt(req.params.id, 'ruleId');
  const enabled = optionalBoolean(req.body.isEnabled, 'isEnabled');
  const name = req.body.ruleName == null ? null : requiredString(req.body.ruleName, 'ruleName', 150);
  const metricId = req.body.metricId === undefined ? null : (req.body.metricId == null ? null : requiredInt(req.body.metricId, 'metricId'));
  const roomId = req.body.roomId === undefined ? null : (req.body.roomId == null ? null : requiredInt(req.body.roomId, 'roomId'));
  const operator = req.body.operator == null ? null : requiredString(req.body.operator, 'operator', 10);
  if (operator) checkStatus(operator, ['>', '>=', '<', '<=', '=', '!=', 'changed'], 'operator');
  const threshold = req.body.threshold === undefined ? null : (req.body.threshold == null ? null : Number(req.body.threshold));
  if (threshold !== null && !Number.isFinite(threshold)) throw new HttpError(400, 'VALIDATION_ERROR', 'threshold must be numeric');
  if (operator && operator !== 'changed' && req.body.threshold === undefined) {
    // Existing threshold remains valid when only operator is changed.
  } else if (operator && operator !== 'changed' && threshold === null) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'threshold is required for this operator');
  }
  const duration = req.body.durationSeconds === undefined ? null : Number(req.body.durationSeconds);
  if (duration !== null && (!Number.isInteger(duration) || duration < 0)) throw new HttpError(400, 'VALIDATION_ERROR', 'durationSeconds must be a non-negative integer');
  const config = req.body.configJson === undefined ? null : jsonString(req.body.configJson, 'configJson');
  const hasConfig = req.body.configJson !== undefined;
  if (config) {
    const parsed = JSON.parse(config);
    if (parsed.severity != null) checkStatus(parsed.severity, ['info', 'warning', 'critical'], 'configJson.severity');
  }
  const hasEnabled = enabled !== null;
  const hasName = name !== null;
  const hasMetric = req.body.metricId !== undefined;
  const hasRoom = req.body.roomId !== undefined;
  const hasOperator = operator !== null;
  const hasThreshold = req.body.threshold !== undefined;
  const hasDuration = req.body.durationSeconds !== undefined;
  if (![hasEnabled, hasName, hasConfig, hasMetric, hasRoom, hasOperator, hasThreshold, hasDuration].some(Boolean)) throw new HttpError(400, 'VALIDATION_ERROR', 'Provide at least one field to update');
  const pool = await poolPromise;
  const r = await pool.request().input('id', sql.Int, id).input('enabled', sql.Bit, enabled).input('name', sql.NVarChar(150), name)
    .input('config', sql.NVarChar(sql.MAX), config).input('metricId', sql.Int, metricId).input('roomId', sql.Int, roomId)
    .input('operator', sql.NVarChar(10), operator).input('threshold', sql.Decimal(18, 6), threshold).input('duration', sql.Int, duration)
    .input('hasEnabled', sql.Bit, hasEnabled).input('hasName', sql.Bit, hasName).input('hasConfig', sql.Bit, hasConfig)
    .input('hasMetric', sql.Bit, hasMetric).input('hasRoom', sql.Bit, hasRoom).input('hasOperator', sql.Bit, hasOperator)
    .input('hasThreshold', sql.Bit, hasThreshold).input('hasDuration', sql.Bit, hasDuration)
    .query(`UPDATE dbo.Alert_Rules SET IsEnabled=CASE WHEN @hasEnabled=1 THEN @enabled ELSE IsEnabled END, RuleName=CASE WHEN @hasName=1 THEN @name ELSE RuleName END, ConfigJson=CASE WHEN @hasConfig=1 THEN @config ELSE ConfigJson END, MetricId=CASE WHEN @hasMetric=1 THEN @metricId ELSE MetricId END, RoomId=CASE WHEN @hasRoom=1 THEN @roomId ELSE RoomId END, Operator=CASE WHEN @hasOperator=1 THEN @operator ELSE Operator END, Threshold=CASE WHEN @hasThreshold=1 THEN @threshold ELSE Threshold END, DurationSeconds=CASE WHEN @hasDuration=1 THEN @duration ELSE DurationSeconds END OUTPUT inserted.RuleId AS ruleId, inserted.MetricId AS metricId, inserted.RoomId AS roomId, inserted.RuleName AS ruleName, inserted.Operator AS operator, inserted.Threshold AS threshold, inserted.DurationSeconds AS durationSeconds, inserted.IsEnabled AS isEnabled, inserted.ConfigJson AS configJson WHERE RuleId=@id`);
  if (!r.recordset.length) throw new HttpError(404, 'NOT_FOUND', 'Alert rule not found');
  emitData('alert-rule.updated', r.recordset[0]);
  return resultOk(res, r.recordset[0]);
}));

// Telemetry history and latest point per device + metric.
function telemetryFilters(req) {
  return {
    roomId: intQuery(req.query.roomId ?? req.query.labId, 'roomId'),
    deviceId: intQuery(req.query.deviceId, 'deviceId'),
    metricCode: req.query.metric ? requiredString(req.query.metric, 'metric', 100) : null,
    from: dateQuery(req.query.from, 'from'),
    to: dateQuery(req.query.to, 'to'),
  };
}
function bindTelemetryFilters(request, f) {
  return request.input('roomId', sql.Int, f.roomId).input('deviceId', sql.Int, f.deviceId)
    .input('metricCode', sql.NVarChar(100), f.metricCode).input('fromDate', sql.DateTime2(3), f.from)
    .input('toDate', sql.DateTime2(3), f.to);
}
router.get('/telemetry/latest', asyncHandler(async (req, res) => {
  const f = telemetryFilters(req);
  const pool = await poolPromise;
  const request = bindTelemetryFilters(pool.request(), f);
  const r = await request.query(`
    WITH Ranked AS (
      SELECT t.TelemetryId AS telemetryId, t.DeviceId AS deviceId, d.DeviceCode AS deviceCode,
             d.DeviceName AS deviceName, n.RoomId AS roomId, r.RoomName AS roomName,
             m.MetricId AS metricId, m.MetricCode AS metricCode, m.DisplayName AS displayName,
             COALESCE(m.DefaultUnit, N'') AS unit, t.ValueNumeric AS valueNumeric,
             t.ValueText AS valueText, t.ValueJson AS valueJson, t.RecordedAt AS recordedAt,
             t.ReceivedAt AS receivedAt,
             ROW_NUMBER() OVER(PARTITION BY t.DeviceId,t.MetricId ORDER BY t.RecordedAt DESC,t.TelemetryId DESC) AS rn
      FROM dbo.Telemetry t JOIN dbo.Devices d ON d.DeviceId=t.DeviceId
      JOIN dbo.Nodes n ON n.NodeId=d.NodeId JOIN dbo.Rooms r ON r.RoomId=n.RoomId
      JOIN dbo.Metrics m ON m.MetricId=t.MetricId
      WHERE (@roomId IS NULL OR n.RoomId=@roomId) AND (@deviceId IS NULL OR t.DeviceId=@deviceId)
        AND (@metricCode IS NULL OR m.MetricCode=@metricCode)
        AND (@fromDate IS NULL OR t.RecordedAt >= @fromDate) AND (@toDate IS NULL OR t.RecordedAt <= @toDate)
    ) SELECT * FROM Ranked WHERE rn=1 ORDER BY recordedAt DESC
  `);
  return resultOk(res, r.recordset.map(telemetryCompatibility), { count: r.recordset.length });
}));
router.get('/telemetry', asyncHandler(async (req, res) => {
  const f = telemetryFilters(req);
  if (f.from && f.to && f.from > f.to) throw new HttpError(400, 'VALIDATION_ERROR', 'from must be before or equal to to');
  const limit = limitQuery(req.query.limit, 100, 500);
  const pool = await poolPromise;
  const request = bindTelemetryFilters(pool.request(), f).input('limit', sql.Int, limit);
  const r = await request.query(`
    SELECT TOP (@limit) t.TelemetryId AS telemetryId, t.DeviceId AS deviceId,
      d.DeviceCode AS deviceCode, d.DeviceName AS deviceName, n.RoomId AS roomId,
      r.RoomName AS roomName, m.MetricId AS metricId, m.MetricCode AS metricCode,
      m.DisplayName AS displayName, m.DefaultUnit AS unit, m.DataType AS dataType,
      t.ValueNumeric AS valueNumeric, t.ValueText AS valueText, t.ValueJson AS valueJson,
      t.RecordedAt AS recordedAt, t.ReceivedAt AS receivedAt, t.MessageId AS messageId
    FROM dbo.Telemetry t JOIN dbo.Devices d ON d.DeviceId=t.DeviceId
    JOIN dbo.Nodes n ON n.NodeId=d.NodeId JOIN dbo.Rooms r ON r.RoomId=n.RoomId
    JOIN dbo.Metrics m ON m.MetricId=t.MetricId
    WHERE (@roomId IS NULL OR n.RoomId=@roomId) AND (@deviceId IS NULL OR t.DeviceId=@deviceId)
      AND (@metricCode IS NULL OR m.MetricCode=@metricCode)
      AND (@fromDate IS NULL OR t.RecordedAt >= @fromDate) AND (@toDate IS NULL OR t.RecordedAt <= @toDate)
    ORDER BY t.RecordedAt DESC,t.TelemetryId DESC
  `);
  return resultOk(res, r.recordset.map(telemetryCompatibility), { count: r.recordset.length, limit });
}));

// Alerts with filters and lifecycle endpoints.
router.get('/alerts', asyncHandler(async (req, res) => {
  const status = req.query.status ? requiredString(req.query.status, 'status', 30) : null;
  const severity = req.query.severity ? requiredString(req.query.severity, 'severity', 30) : null;
  if (status) checkStatus(status, ['open', 'acknowledged', 'resolved', 'closed'], 'status');
  if (severity) checkStatus(severity, ['info', 'warning', 'critical'], 'severity');
  const roomId = intQuery(req.query.roomId ?? req.query.labId, 'roomId');
  const deviceId = intQuery(req.query.deviceId, 'deviceId');
  const limit = limitQuery(req.query.limit, 100, 500);
  const pool = await poolPromise;
  const r = await pool.request().input('status', sql.NVarChar(30), status).input('severity', sql.NVarChar(30), severity)
    .input('roomId', sql.Int, roomId).input('deviceId', sql.Int, deviceId).input('limit', sql.Int, limit)
    .query(`SELECT TOP (@limit) a.AlertId AS alertId, a.RoomId AS roomId, r.RoomName AS roomName, a.DeviceId AS deviceId, d.DeviceName AS deviceName, d.DeviceCode AS deviceCode, a.AlertType AS alertType, a.Severity AS severity, a.Message AS message, a.Status AS status, a.CreatedAt AS createdAt, a.ResolvedAt AS resolvedAt FROM dbo.Alerts a LEFT JOIN dbo.Rooms r ON r.RoomId=a.RoomId LEFT JOIN dbo.Devices d ON d.DeviceId=a.DeviceId WHERE (@status IS NULL OR a.Status=@status) AND (@severity IS NULL OR a.Severity=@severity) AND (@roomId IS NULL OR a.RoomId=@roomId) AND (@deviceId IS NULL OR a.DeviceId=@deviceId) ORDER BY a.CreatedAt DESC,a.AlertId DESC`);
  const alerts = r.recordset.map((a) => ({ ...a, id: a.alertId, lab_id: a.roomId, device_id: a.deviceId, type: a.alertType, created_at: a.createdAt, resolved_at: a.resolvedAt, device_name: a.deviceName, lab_name: a.roomName }));
  return resultOk(res, alerts, { count: alerts.length, limit });
}));
router.get('/alerts/:id', asyncHandler(async (req, res) => {
  const id = requiredInt(req.params.id, 'alertId');
  const pool = await poolPromise;
  const r = await pool.request().input('id', sql.BigInt, id).query('SELECT AlertId AS alertId, RoomId AS roomId, DeviceId AS deviceId, ResolvedByUserId AS resolvedByUserId, AlertType AS alertType, Severity AS severity, Message AS message, Status AS status, CreatedAt AS createdAt, ResolvedAt AS resolvedAt FROM dbo.Alerts WHERE AlertId=@id');
  if (!r.recordset.length) throw new HttpError(404, 'NOT_FOUND', 'Alert not found');
  return resultOk(res, r.recordset[0]);
}));
router.patch('/alerts/:id', asyncHandler(async (req, res) => {
  const id = requiredInt(req.params.id, 'alertId');
  const status = requiredString(req.body.status, 'status', 30);
  checkStatus(status, ['open', 'acknowledged', 'resolved', 'closed'], 'status');
  const pool = await poolPromise;
  const r = await pool.request().input('id', sql.BigInt, id).input('status', sql.NVarChar(30), status)
    .query(`UPDATE dbo.Alerts SET Status=@status, ResolvedAt=CASE WHEN @status IN (N'resolved',N'closed') THEN COALESCE(ResolvedAt,SYSUTCDATETIME()) ELSE NULL END OUTPUT inserted.AlertId AS alertId, inserted.DeviceId AS deviceId, inserted.RoomId AS roomId, inserted.AlertType AS alertType, inserted.Severity AS severity, inserted.Message AS message, inserted.Status AS status, inserted.CreatedAt AS createdAt, inserted.ResolvedAt AS resolvedAt WHERE AlertId=@id`);
  if (!r.recordset.length) throw new HttpError(404, 'NOT_FOUND', 'Alert not found');
  emitData('alert', { action: 'status_changed', alert: r.recordset[0] });
  return resultOk(res, r.recordset[0]);
}));

// Commands; sender identity is taken from the authenticated CampusX session, never from request JSON.
router.post('/commands', asyncHandler(async (req, res) => {
  const commandType = requiredString(req.body.commandType ?? req.body.type, 'commandType', 100);
  const payloadJson = jsonString(req.body.payload ?? {}, 'payload', false);
  const deviceId = req.body.deviceId == null ? null : requiredInt(req.body.deviceId, 'deviceId');
  const deviceCode = req.body.deviceCode == null ? null : requiredString(req.body.deviceCode, 'deviceCode', 100);
  if (deviceId === null && deviceCode === null) throw new HttpError(400, 'VALIDATION_ERROR', 'deviceId or deviceCode is required');

  const requestedBy = String(req.dashboardUser?.username || '').trim();
  if (!requestedBy) throw new HttpError(401, 'AUTH_REQUIRED', 'A signed-in CampusX user is required to send commands');

  const pool = await poolPromise;
  const find = await pool.request()
    .input('deviceId', sql.Int, deviceId)
    .input('deviceCode', sql.NVarChar(100), deviceCode)
    .query(`
      SELECT TOP (1)
        d.DeviceId, d.DeviceCode, d.DeviceName, d.IsActive,
        n.IsActive AS nodeActive,
        r.RoomId, r.RoomCode, r.RoomName
      FROM dbo.Devices d
      INNER JOIN dbo.Nodes n ON n.NodeId=d.NodeId
      LEFT JOIN dbo.Rooms r ON r.RoomId=n.RoomId
      WHERE (@deviceId IS NOT NULL AND d.DeviceId=@deviceId)
         OR (@deviceCode IS NOT NULL AND d.DeviceCode=@deviceCode)
    `);
  const device = find.recordset[0];
  if (!device || !device.IsActive || !device.nodeActive) throw new HttpError(404, 'NOT_FOUND', 'Device not found or inactive');

  const insert = await pool.request()
    .input('deviceId', sql.Int, device.DeviceId)
    .input('type', sql.NVarChar(100), commandType)
    .input('payload', sql.NVarChar(sql.MAX), payloadJson)
    .input('requestedBy', sql.NVarChar(100), requestedBy)
    .query(`
      INSERT INTO dbo.Commands(DeviceId, UserId, RequestedBy, CommandType, PayloadJson, Status)
      OUTPUT inserted.CommandId AS commandId,
             inserted.DeviceId AS deviceId,
             inserted.RequestedBy AS requestedBy,
             inserted.CommandType AS commandType,
             inserted.PayloadJson AS payloadJson,
             inserted.Status AS status,
             inserted.CreatedAt AS createdAt
      VALUES(@deviceId, NULL, @requestedBy, @type, @payload, N'pending')
    `);
  const command = insert.recordset[0];
  const topic = `${env.commandTopicPrefix}/${encodeURIComponent(device.DeviceCode)}/commands`;

  // Best-effort audit entry. The Commands row itself remains the primary command history.
  try {
    const details = JSON.stringify({
      requestedBy,
      deviceCode: device.DeviceCode,
      deviceName: device.DeviceName,
      roomId: device.RoomId,
      roomCode: device.RoomCode,
      roomName: device.RoomName,
      commandType,
      payload: JSON.parse(payloadJson),
      topic,
    });
    await pool.request()
      .input('action', sql.NVarChar(100), 'command_sent')
      .input('entityType', sql.NVarChar(100), 'Command')
      .input('entityId', sql.NVarChar(100), String(command.commandId))
      .input('details', sql.NVarChar(sql.MAX), details)
      .query(`INSERT INTO dbo.Audit_Logs(Action, EntityType, EntityId, DetailsJson) VALUES(@action,@entityType,@entityId,@details)`);
  } catch (auditError) {
    console.warn('[Audit] Command was created but its Audit_Logs entry failed:', auditError.message);
  }

  try {
    await publish(topic, {
      command_id: String(command.commandId),
      type: commandType,
      payload: JSON.parse(payloadJson),
    });
    const sent = await pool.request()
      .input('id', sql.BigInt, command.commandId)
      .query(`
        UPDATE dbo.Commands SET Status=N'sent'
        OUTPUT inserted.CommandId AS commandId,
               inserted.DeviceId AS deviceId,
               inserted.RequestedBy AS requestedBy,
               inserted.CommandType AS commandType,
               inserted.PayloadJson AS payloadJson,
               inserted.Status AS status,
               inserted.CreatedAt AS createdAt,
               inserted.CompletedAt AS completedAt
        WHERE CommandId=@id AND Status=N'pending'
      `);
    const value = sent.recordset[0] || command;
    const eventData = {
      ...value,
      deviceCode: device.DeviceCode,
      deviceName: device.DeviceName,
      roomId: device.RoomId,
      roomCode: device.RoomCode,
      roomName: device.RoomName,
      topic,
    };
    emitData('command', eventData);
    return res.status(201).json({ status: 'ok', message: 'Command published; awaiting device response', data: eventData });
  } catch (error) {
    await pool.request()
      .input('id', sql.BigInt, command.commandId)
      .query(`UPDATE dbo.Commands SET Status=N'failed', CompletedAt=SYSUTCDATETIME() WHERE CommandId=@id AND Status IN (N'pending',N'sent')`);
    throw new HttpError(503, 'MQTT_PUBLISH_FAILED', `Command was saved but MQTT publish failed: ${error.message}`);
  }
}));

router.get('/commands', asyncHandler(async (req, res) => {
  const deviceId = intQuery(req.query.deviceId, 'deviceId');
  const roomId = intQuery(req.query.roomId, 'roomId');
  const status = req.query.status ? requiredString(req.query.status, 'status', 30) : null;
  if (status) checkStatus(status, ['pending', 'sent', 'completed', 'failed', 'timeout', 'cancelled'], 'status');
  const limit = limitQuery(req.query.limit, 100, 500);
  const offset = optionalInt(req.query.offset, 'offset', 0) ?? 0;
  const pool = await poolPromise;

  const filters = `
    FROM dbo.Commands c
    INNER JOIN dbo.Devices d ON d.DeviceId=c.DeviceId
    INNER JOIN dbo.Nodes n ON n.NodeId=d.NodeId
    LEFT JOIN dbo.Rooms r ON r.RoomId=n.RoomId
    WHERE (@deviceId IS NULL OR c.DeviceId=@deviceId)
      AND (@roomId IS NULL OR r.RoomId=@roomId)
      AND (@status IS NULL OR c.Status=@status)
  `;
  const totalResult = await pool.request()
    .input('deviceId', sql.Int, deviceId)
    .input('roomId', sql.Int, roomId)
    .input('status', sql.NVarChar(30), status)
    .query(`SELECT COUNT_BIG(1) AS total ${filters}`);

  const r = await pool.request()
    .input('deviceId', sql.Int, deviceId)
    .input('roomId', sql.Int, roomId)
    .input('status', sql.NVarChar(30), status)
    .input('limit', sql.Int, limit)
    .input('offset', sql.Int, offset)
    .query(`
      SELECT
        c.CommandId AS commandId,
        c.DeviceId AS deviceId,
        d.DeviceCode AS deviceCode,
        d.DeviceName AS deviceName,
        r.RoomId AS roomId,
        r.RoomCode AS roomCode,
        r.RoomName AS roomName,
        c.UserId AS userId,
        c.RequestedBy AS requestedBy,
        c.CommandType AS commandType,
        c.PayloadJson AS payloadJson,
        c.Status AS status,
        c.CreatedAt AS createdAt,
        c.CompletedAt AS completedAt
      ${filters}
      ORDER BY c.CreatedAt DESC,c.CommandId DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

  const total = Number(totalResult.recordset[0]?.total || 0);
  const data = r.recordset.map(commandCompatibility);
  return resultOk(res, data, {
    count: data.length,
    limit,
    offset,
    total,
    page: Math.floor(offset / limit) + 1,
    totalPages: Math.ceil(total / limit),
  });
}));
// Generic states for relays, fans, controllers, and future actuators.
router.get('/states', asyncHandler(async (req, res) => {
  const deviceId = intQuery(req.query.deviceId, 'deviceId');
  const limit = limitQuery(req.query.limit, 100, 500);
  const pool = await poolPromise;
  const r = await pool.request().input('deviceId', sql.Int, deviceId).input('limit', sql.Int, limit)
    .query(`SELECT TOP (@limit) s.StateId AS stateId, s.DeviceId AS deviceId, d.DeviceCode AS deviceCode, s.StateCode AS stateCode, s.StateValue AS stateValue, s.RecordedAt AS recordedAt FROM dbo.Device_States s JOIN dbo.Devices d ON d.DeviceId=s.DeviceId WHERE (@deviceId IS NULL OR s.DeviceId=@deviceId) ORDER BY s.RecordedAt DESC,s.StateId DESC`);
  return resultOk(res, r.recordset, { count: r.recordset.length });
}));
router.post('/states', asyncHandler(async (req, res) => {
  const deviceId = req.body.deviceId == null ? null : requiredInt(req.body.deviceId, 'deviceId');
  const deviceCode = req.body.deviceCode == null ? null : requiredString(req.body.deviceCode, 'deviceCode', 100);
  if (deviceId === null && deviceCode === null) throw new HttpError(400, 'VALIDATION_ERROR', 'deviceId or deviceCode is required');
  const stateCode = requiredString(req.body.stateCode, 'stateCode', 100);
  const stateValue = requiredString(String(req.body.stateValue ?? ''), 'stateValue', 250);
  const pool = await poolPromise;
  const ins = await pool.request().input('deviceId', sql.Int, deviceId).input('deviceCode', sql.NVarChar(100), deviceCode)
    .input('stateCode', sql.NVarChar(100), stateCode).input('stateValue', sql.NVarChar(250), stateValue)
    .query(`INSERT INTO dbo.Device_States(DeviceId,StateCode,StateValue) OUTPUT inserted.StateId AS stateId, inserted.DeviceId AS deviceId, inserted.StateCode AS stateCode, inserted.StateValue AS stateValue, inserted.RecordedAt AS recordedAt SELECT TOP (1) d.DeviceId,@stateCode,@stateValue FROM dbo.Devices d WHERE (@deviceId IS NOT NULL AND d.DeviceId=@deviceId) OR (@deviceCode IS NOT NULL AND d.DeviceCode=@deviceCode)`);
  if (!ins.recordset.length) throw new HttpError(404, 'NOT_FOUND', 'Device not found');
  emitData('device.state', ins.recordset[0]);
  return res.status(201).json({ status: 'ok', data: ins.recordset[0] });
}));

// Live server-sent event stream for a dashboard; MQTT remains the device uplink.
router.get('/stream', (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`event: ready\ndata: ${JSON.stringify({ status: 'ok', message: 'CampusX event stream connected' })}\n\n`);
  const requestedTypes = req.query.types ? String(req.query.types).split(',').map((x) => x.trim()).filter(Boolean) : null;
  const onData = (event) => {
    if (requestedTypes && !requestedTypes.includes(event.type)) return;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(`: heartbeat ${Date.now()}\n\n`); }, 20000);
  heartbeat.unref();
  hub.on('data', onData);
  req.on('close', () => { clearInterval(heartbeat); hub.off('data', onData); });
});

router.use((req, res, next) => next(new HttpError(404, 'ROUTE_NOT_FOUND', `No route: ${req.method} ${req.originalUrl}`)));

module.exports = router;
