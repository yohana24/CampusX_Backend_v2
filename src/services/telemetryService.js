'use strict';

const { sql, pool } = require('../db/sqlserver');
const env = require('../config/env');
const { evaluateMetricRules } = require('./alertEngine');
const { emitData } = require('./eventHub');

function parsePayload(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (Buffer.byteLength(text, 'utf8') > env.maxMqttPayloadBytes) throw new Error('MQTT payload exceeds configured size limit');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid JSON MQTT payload'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Payload must be a JSON object');
  return data;
}

function validateReading(reading, index) {
  if (!reading || typeof reading !== 'object' || Array.isArray(reading)) throw new Error(`Reading ${index} must be an object`);
  if (typeof reading.metric !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(reading.metric)) throw new Error(`Reading ${index} has an invalid metric code`);
  const perReadingDevice = reading.device_id ?? reading.deviceCode ?? reading.device_code;
  if (perReadingDevice != null && (typeof perReadingDevice !== 'string' || !perReadingDevice.trim())) throw new Error(`Reading ${index} has an invalid device code`);
  if (reading.unit != null && typeof reading.unit !== 'string') throw new Error(`Reading ${index} unit must be a string`);
}

function prepareStoredValue(metric, value) {
  const type = String(metric.DataType || 'numeric').toLowerCase();
  if (type === 'numeric') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Metric '${metric.MetricCode}' expects a finite numeric value`);
    return { ValueNumeric: value, ValueText: null, ValueJson: null, numericValue: value };
  }
  if (type === 'text') {
    if (typeof value !== 'string') throw new Error(`Metric '${metric.MetricCode}' expects a string value`);
    if (value.length > 1000) throw new Error(`Metric '${metric.MetricCode}' text value is too long`);
    return { ValueNumeric: null, ValueText: value, ValueJson: null, numericValue: null };
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`Metric '${metric.MetricCode}' expects true or false`);
    return { ValueNumeric: null, ValueText: value ? 'true' : 'false', ValueJson: null, numericValue: null };
  }
  if (type === 'json') {
    if (value === null || typeof value !== 'object') throw new Error(`Metric '${metric.MetricCode}' expects a JSON object or array`);
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error(`Metric '${metric.MetricCode}' expects a JSON value`);
    return { ValueNumeric: null, ValueText: null, ValueJson: json, numericValue: null };
  }
  throw new Error(`Unsupported DataType '${metric.DataType}' for metric '${metric.MetricCode}'`);
}

async function processTelemetryMessage(topic, rawMessage) {
  const data = parsePayload(rawMessage);
  const topicMatch = /^smart-campus\/devices\/([^/]+)\/telemetry$/.exec(topic);
  const defaultDeviceCode = (typeof data.device_id === 'string' && data.device_id.trim())
    || (typeof data.deviceCode === 'string' && data.deviceCode.trim())
    || (typeof data.device_code === 'string' && data.device_code.trim())
    || (topicMatch && decodeURIComponent(topicMatch[1]))
    || null;
  const nodeCode = typeof data.node_code === 'string' && data.node_code.trim() ? data.node_code.trim() : null;

  if (!Array.isArray(data.readings) || data.readings.length < 1 || data.readings.length > env.maxReadingsPerMessage) {
    throw new Error(`readings must contain between 1 and ${env.maxReadingsPerMessage} items`);
  }
  data.readings.forEach(validateReading);
  if (!defaultDeviceCode && !data.readings.some((x) => x.device_id || x.deviceCode || x.device_code)) {
    throw new Error('Payload needs device_id or a device id on every reading');
  }

  const messageId = typeof data.message_id === 'string' && data.message_id.trim()
    ? data.message_id.trim().slice(0, 100)
    : (typeof data.messageId === 'string' && data.messageId.trim() ? data.messageId.trim().slice(0, 100) : null);
  const recordedAt = data.recorded_at && !Number.isNaN(Date.parse(data.recorded_at))
    ? new Date(data.recorded_at)
    : (data.timestamp && !Number.isNaN(Date.parse(data.timestamp)) ? new Date(data.timestamp) : new Date());

  const transaction = new sql.Transaction(pool);
  const saved = [];
  const alertEvents = [];
  const devices = new Map();
  const telemetryByDevice = new Map();

  try {
    await transaction.begin();

    for (const reading of data.readings) {
      const readingDeviceCode = String(reading.device_id || reading.deviceCode || reading.device_code || defaultDeviceCode || '').trim();
      if (!readingDeviceCode) throw new Error(`Reading for metric '${reading.metric}' is missing its device_id`);

      let device = devices.get(readingDeviceCode);
      if (!device) {
        const deviceResult = await transaction.request()
          .input('deviceCode', sql.NVarChar(100), readingDeviceCode)
          .input('nodeCode', sql.NVarChar(100), nodeCode)
          .query(`
            SELECT d.DeviceId, d.DeviceCode, d.DeviceName, d.DeviceTypeId,
                   n.NodeId, n.NodeCode, n.RoomId
            FROM dbo.Devices d
            INNER JOIN dbo.Nodes n ON n.NodeId = d.NodeId
            INNER JOIN dbo.Rooms r ON r.RoomId = n.RoomId
            WHERE d.DeviceCode = @deviceCode
              AND d.IsActive = 1 AND n.IsActive = 1 AND r.IsActive = 1
              AND (@nodeCode IS NULL OR n.NodeCode = @nodeCode)
          `);
        device = deviceResult.recordset[0];
        if (!device) throw new Error(`Device '${readingDeviceCode}' not found/inactive, or not attached to node '${nodeCode || ''}'`);
        devices.set(readingDeviceCode, device);
        telemetryByDevice.set(readingDeviceCode, []);
      }

      const metricResult = await transaction.request()
        .input('metricCode', sql.NVarChar(100), reading.metric)
        .query('SELECT MetricId, MetricCode, DefaultUnit, DataType FROM dbo.Metrics WHERE MetricCode = @metricCode');
      const metric = metricResult.recordset[0];
      if (!metric) throw new Error(`Metric '${reading.metric}' is not registered in dbo.Metrics`);
      const stored = prepareStoredValue(metric, reading.value);

      let previousValue = null;
      if (stored.numericValue != null) {
        const previousResult = await transaction.request()
          .input('deviceId', sql.Int, device.DeviceId)
          .input('metricId', sql.Int, metric.MetricId)
          .query(`SELECT TOP (1) ValueNumeric FROM dbo.Telemetry WHERE DeviceId=@deviceId AND MetricId=@metricId AND ValueNumeric IS NOT NULL ORDER BY TelemetryId DESC`);
        previousValue = previousResult.recordset.length ? Number(previousResult.recordset[0].ValueNumeric) : null;
      }

      // A repeated message_id makes ingestion idempotent per device + metric.
      if (messageId) {
        const duplicate = await transaction.request()
          .input('deviceId', sql.Int, device.DeviceId).input('metricId', sql.Int, metric.MetricId)
          .input('messageId', sql.NVarChar(100), messageId)
          .query('SELECT TOP (1) TelemetryId FROM dbo.Telemetry WHERE DeviceId=@deviceId AND MetricId=@metricId AND MessageId=@messageId');
        if (duplicate.recordset.length) continue;
      }

      const inserted = await transaction.request()
        .input('deviceId', sql.Int, device.DeviceId).input('metricId', sql.Int, metric.MetricId)
        .input('valueNumeric', sql.Decimal(18, 6), stored.ValueNumeric)
        .input('valueText', sql.NVarChar(1000), stored.ValueText)
        .input('valueJson', sql.NVarChar(sql.MAX), stored.ValueJson)
        .input('recordedAt', sql.DateTime2(3), recordedAt)
        .input('messageId', sql.NVarChar(100), messageId)
        .query(`
          INSERT INTO dbo.Telemetry(DeviceId,MetricId,ValueNumeric,ValueText,ValueJson,RecordedAt,MessageId)
          OUTPUT inserted.TelemetryId, inserted.DeviceId, inserted.MetricId,
                 inserted.ValueNumeric, inserted.ValueText, inserted.ValueJson,
                 inserted.RecordedAt, inserted.ReceivedAt, inserted.MessageId
          VALUES(@deviceId,@metricId,@valueNumeric,@valueText,@valueJson,@recordedAt,@messageId)
        `);
      const row = inserted.recordset[0];
      const publicReading = { ...row, deviceId: device.DeviceId, deviceCode: device.DeviceCode, metricId: metric.MetricId, metricCode: metric.MetricCode, unit: metric.DefaultUnit };
      saved.push(publicReading);
      telemetryByDevice.get(readingDeviceCode).push(publicReading);

      if (stored.numericValue != null) {
        const alertEvent = await evaluateMetricRules({ transaction, device, metric, value: stored.numericValue, previousValue, recordedAt });
        if (alertEvent) alertEvents.push(alertEvent);
      }
    }

    // Refresh last-seen and online state for every unique device represented in the batch.
    for (const device of devices.values()) {
      await transaction.request()
        .input('deviceId', sql.Int, device.DeviceId).input('nodeId', sql.Int, device.NodeId)
        .query(`UPDATE dbo.Devices SET Status=N'online' WHERE DeviceId=@deviceId; UPDATE dbo.Nodes SET LastSeenAt=SYSUTCDATETIME() WHERE NodeId=@nodeId;`);
    }
    await transaction.commit();
  } catch (error) {
    try { await transaction.rollback(); } catch { /* transaction may already be aborted */ }
    throw error;
  }

  for (const [deviceCode, readings] of telemetryByDevice.entries()) {
    if (readings.length) {
      const device = devices.get(deviceCode);
      emitData('telemetry', { deviceCode, deviceId: device.DeviceId, roomId: device.RoomId, readings });
    }
  }
  for (const event of alertEvents) emitData('alert', event);
  for (const device of devices.values()) emitData('device.status', { deviceCode: device.DeviceCode, deviceId: device.DeviceId, status: 'online' });

  return {
    device: devices.values().next().value || { DeviceCode: defaultDeviceCode || 'unknown' },
    devicesCount: devices.size,
    savedCount: saved.length,
    duplicateSkipped: data.readings.length - saved.length,
    readings: saved,
    alerts: alertEvents,
  };
}

module.exports = { processTelemetryMessage };
