'use strict';

const crypto = require('node:crypto');
const os = require('node:os');

function numberFromEnv(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name] ?? fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function booleanFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function listFromEnv(name, fallback = '') {
  return String(process.env[name] ?? fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function expandTemplate(value) {
  const hostname = String(os.hostname() || 'campusx-host')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 40);
  return String(value)
    .replaceAll('${process.pid}', String(process.pid))
    .replaceAll('${hostname}', hostname)
    .replaceAll('${random}', crypto.randomBytes(4).toString('hex'));
}

function mqttClientId() {
  const configured = String(process.env.MQTT_CLIENT_ID || '').trim();
  const template = configured || 'campusx-backend-${process.pid}-${random}';
  let id = expandTemplate(template);
  // A fixed client ID makes every restart kick the previous session off the
  // broker. Inject uniqueness unless the operator already asked for it.
  if (!template.includes('${process.pid}') && !template.includes('${random}')) {
    id += `-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  }
  return id.slice(0, 128);
}

const host = String(process.env.HOST || '127.0.0.1').trim();
const apiKey = String(process.env.API_KEY || '').trim();
const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(host);

if (!isLoopback && !apiKey) {
  throw new Error('Set API_KEY before binding the API to a non-local HOST.');
}

const commandTypes = listFromEnv('COMMAND_TYPES', '');
const corsOrigins = listFromEnv(
  'CORS_ORIGINS',
  'http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173'
);

module.exports = Object.freeze({
  host,
  port: numberFromEnv('PORT', 3000, 1, 65535),
  nodeEnv: process.env.NODE_ENV || 'development',
  apiKey,
  corsOrigins,

  mqttUrl: process.env.MQTT_URL || 'mqtt://localhost:1883',
  mqttUsername: process.env.MQTT_USERNAME || '',
  mqttPassword: process.env.MQTT_PASSWORD || '',
  telemetryTopic: process.env.MQTT_TELEMETRY_TOPIC || 'smart-campus/telemetry',
  deviceTelemetryTopic: process.env.MQTT_DEVICE_TELEMETRY_TOPIC || 'smart-campus/devices/+/telemetry',
  commandResponseTopic: process.env.MQTT_COMMAND_RESPONSE_TOPIC || 'smart-campus/devices/+/command-response',
  commandTopicPrefix: process.env.MQTT_COMMAND_TOPIC_PREFIX || 'smart-campus/devices',
  mqttClientId: mqttClientId(),
  mqttQos: numberFromEnv('MQTT_QOS', 1, 0, 2),
  mqttConnectTimeoutMs: numberFromEnv('MQTT_CONNECT_TIMEOUT_MS', 10000, 1000, 120000),
  mqttReconnectPeriodMs: numberFromEnv('MQTT_RECONNECT_PERIOD_MS', 3000, 500, 120000),
  mqttPublishTimeoutMs: numberFromEnv('MQTT_PUBLISH_TIMEOUT_MS', 10000, 500, 120000),
  mqttWaitForConnectMs: numberFromEnv('MQTT_WAIT_FOR_CONNECT_MS', 5000, 100, 120000),

  deviceOfflineSeconds: numberFromEnv('DEVICE_OFFLINE_SECONDS', 90, 1, 86400),
  deviceSweepIntervalSeconds: numberFromEnv('DEVICE_SWEEP_INTERVAL_SECONDS', 20, 1, 86400),
  commandTimeoutSeconds: numberFromEnv('COMMAND_TIMEOUT_SECONDS', 120, 5, 86400),
  commandTimeoutSweepSeconds: numberFromEnv('COMMAND_TIMEOUT_SWEEP_SECONDS', 30, 1, 3600),
  cvScriptTimeoutMs: numberFromEnv('CV_SCRIPT_TIMEOUT_MS', 120000, 1000, 600000),
  cvOperationWaitMs: numberFromEnv('CV_OPERATION_WAIT_MS', 150000, 1000, 600000),
  maxReadingsPerMessage: numberFromEnv('MAX_READINGS_PER_MESSAGE', 100, 1, 1000),
  maxMqttPayloadBytes: numberFromEnv('MAX_MQTT_PAYLOAD_BYTES', 65536, 256, 10 * 1024 * 1024),
  telemetryMaxFutureSeconds: numberFromEnv('TELEMETRY_MAX_FUTURE_SECONDS', 300, 0, 86400),
  telemetryMaxPastSeconds: numberFromEnv('TELEMETRY_MAX_PAST_SECONDS', 30 * 86400, 60, 365 * 86400),

  sqlConnectionTimeoutMs: numberFromEnv('SQL_CONNECTION_TIMEOUT_MS', 15000, 1000, 300000),
  sqlRequestTimeoutMs: numberFromEnv('SQL_REQUEST_TIMEOUT_MS', 30000, 1000, 600000),
  sqlPoolMax: numberFromEnv('SQL_POOL_MAX', 10, 1, 200),
  sqlPoolMin: numberFromEnv('SQL_POOL_MIN', 0, 0, 200),
  sqlPoolIdleTimeoutMs: numberFromEnv('SQL_POOL_IDLE_TIMEOUT_MS', 30000, 1000, 3600000),
  sqlRetryCooldownMs: numberFromEnv('SQL_RETRY_COOLDOWN_MS', 2000, 100, 60000),

  commandTypes,

  httpShutdownTimeoutMs: numberFromEnv('HTTP_SHUTDOWN_TIMEOUT_MS', 5000, 100, 60000),
  mqttShutdownTimeoutMs: numberFromEnv('MQTT_SHUTDOWN_TIMEOUT_MS', 5000, 100, 60000),
  forceExitTimeoutMs: numberFromEnv('FORCE_EXIT_TIMEOUT_MS', 15000, 1000, 120000),

  strictHealth: booleanFromEnv('STRICT_HEALTH', false),
  publicOrigin: String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, ''),
  jsonBodyLimit: String(process.env.JSON_BODY_LIMIT || '1mb').trim(),
  dashboardRegistrationEnabled: booleanFromEnv('DASHBOARD_REGISTRATION_ENABLED', true),
  dashboardSessionSecret: String(process.env.DASHBOARD_SESSION_SECRET || '').trim(),
  dashboardSessionHours: numberFromEnv('DASHBOARD_SESSION_HOURS', 8, 1, 24),
  dashboardCookieSecure: booleanFromEnv('DASHBOARD_COOKIE_SECURE', false),
  dashboardUsername: String(process.env.DASHBOARD_USERNAME || '').trim(),
  dashboardPasswordHash: String(process.env.DASHBOARD_PASSWORD_HASH || '').trim(),
  dashboardAdminUsername: String(process.env.DASHBOARD_ADMIN_USERNAME || '').trim(),
  dashboardAdminEmail: String(process.env.DASHBOARD_ADMIN_EMAIL || '').trim().toLowerCase(),
});
