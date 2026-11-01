'use strict';

const { sql } = require('../db/sqlserver');

const severityRank = { info: 1, warning: 2, critical: 3 };

function parseRuleConfig(configJson) {
  if (!configJson) return {};
  try { return JSON.parse(configJson); } catch { return {}; }
}

function isRuleActive(operator, value, threshold, previousValue) {
  switch (operator) {
    case '>': return threshold != null && value > threshold;
    case '>=': return threshold != null && value >= threshold;
    case '<': return threshold != null && value < threshold;
    case '<=': return threshold != null && value <= threshold;
    case '=': return threshold != null && value === Number(threshold);
    case '!=': return threshold != null && value !== Number(threshold);
    case 'changed': return previousValue != null && value !== previousValue;
    default: return false;
  }
}

async function evaluateMetricRules({ transaction, device, metric, value, previousValue, recordedAt }) {
  // Rules are data, not source code: adding a metric/device/rule does not require a backend edit.
  const ruleResult = await transaction.request()
    .input('metricId', sql.Int, metric.MetricId)
    .input('roomId', sql.Int, device.RoomId)
    .query(`
      SELECT RuleId, RuleName, Operator, Threshold, DurationSeconds, ConfigJson
      FROM dbo.Alert_Rules
      WHERE MetricId = @metricId
        AND IsEnabled = 1
        AND (RoomId IS NULL OR RoomId = @roomId)
    `);

  const activeRules = [];
  for (const rule of ruleResult.recordset) {
    let active = isRuleActive(rule.Operator, value, rule.Threshold, previousValue);

    // For sustained threshold rules, require samples covering the whole duration
    // and require every sample in the window to keep satisfying the condition.
    if (active && Number(rule.DurationSeconds) > 0 && rule.Operator !== 'changed') {
      const cutoff = new Date(new Date(recordedAt).getTime() - Number(rule.DurationSeconds) * 1000);
      const history = await transaction.request()
        .input('deviceId', sql.Int, device.DeviceId)
        .input('metricId', sql.Int, metric.MetricId)
        .input('cutoff', sql.DateTime2(3), cutoff)
        .input('recordedAt', sql.DateTime2(3), recordedAt)
        .query(`
          SELECT ValueNumeric, RecordedAt
          FROM dbo.Telemetry
          WHERE DeviceId=@deviceId AND MetricId=@metricId
            AND ValueNumeric IS NOT NULL
            AND RecordedAt >= @cutoff AND RecordedAt <= @recordedAt
          ORDER BY RecordedAt ASC, TelemetryId ASC
        `);
      const samples = history.recordset;
      active = samples.length > 0
        && new Date(samples[0].RecordedAt).getTime() <= cutoff.getTime()
        && samples.every((sample) => isRuleActive(rule.Operator, Number(sample.ValueNumeric), rule.Threshold, null));
    }
    if (!active) continue;
    const config = parseRuleConfig(rule.ConfigJson);
    const severity = Object.hasOwn(severityRank, config.severity) ? config.severity : 'warning';
    activeRules.push({ ...rule, severity, rank: severityRank[severity] });
  }
  activeRules.sort((a, b) => b.rank - a.rank);

  const alertType = `metric_${metric.MetricId}_threshold`;
  const existingResult = await transaction.request()
    .input('deviceId', sql.Int, device.DeviceId)
    .input('alertType', sql.NVarChar(100), alertType)
    .query(`
      SELECT TOP (1) AlertId, Status
      FROM dbo.Alerts
      WHERE DeviceId = @deviceId
        AND AlertType = @alertType
        AND Status IN (N'open', N'acknowledged')
      ORDER BY CreatedAt DESC
    `);
  const existing = existingResult.recordset[0];

  if (activeRules.length === 0) {
    if (!existing) return null;
    const resolved = await transaction.request()
      .input('alertId', sql.BigInt, existing.AlertId)
      .query(`
        UPDATE dbo.Alerts
        SET Status = N'resolved', ResolvedAt = SYSUTCDATETIME()
        OUTPUT inserted.AlertId, inserted.RoomId, inserted.DeviceId,
               inserted.AlertType, inserted.Severity, inserted.Message,
               inserted.Status, inserted.CreatedAt, inserted.ResolvedAt
        WHERE AlertId = @alertId
      `);
    return resolved.recordset[0] ? { action: 'resolved', alert: resolved.recordset[0] } : null;
  }

  const strongest = activeRules[0];
  const message = `${strongest.RuleName}: ${metric.MetricCode} = ${value}${metric.DefaultUnit ? ` ${metric.DefaultUnit}` : ''}`;
  if (existing) {
    const updated = await transaction.request()
      .input('alertId', sql.BigInt, existing.AlertId)
      .input('severity', sql.NVarChar(30), strongest.severity)
      .input('message', sql.NVarChar(1000), message)
      .query(`
        UPDATE dbo.Alerts
        SET Severity = @severity, Message = @message
        OUTPUT inserted.AlertId, inserted.RoomId, inserted.DeviceId,
               inserted.AlertType, inserted.Severity, inserted.Message,
               inserted.Status, inserted.CreatedAt, inserted.ResolvedAt
        WHERE AlertId = @alertId
      `);
    return updated.recordset[0] ? { action: 'updated', alert: updated.recordset[0] } : null;
  }

  const inserted = await transaction.request()
    .input('roomId', sql.Int, device.RoomId)
    .input('deviceId', sql.Int, device.DeviceId)
    .input('alertType', sql.NVarChar(100), alertType)
    .input('severity', sql.NVarChar(30), strongest.severity)
    .input('message', sql.NVarChar(1000), message)
    .query(`
      INSERT INTO dbo.Alerts (RoomId, DeviceId, AlertType, Severity, Message, Status)
      OUTPUT inserted.AlertId, inserted.RoomId, inserted.DeviceId,
             inserted.AlertType, inserted.Severity, inserted.Message,
             inserted.Status, inserted.CreatedAt, inserted.ResolvedAt
      VALUES (@roomId, @deviceId, @alertType, @severity, @message, N'open')
    `);
  return inserted.recordset[0] ? { action: 'created', alert: inserted.recordset[0] } : null;
}

module.exports = { evaluateMetricRules };
