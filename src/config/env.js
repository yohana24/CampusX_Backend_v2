'use strict';

const numberFromEnv = (name, fallback, min = 1) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a number >= ${min}`);
  }
  return value;
};

const host = process.env.HOST || '127.0.0.1';
const apiKey = (process.env.API_KEY || '').trim();
const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(host);

if (!isLoopback && !apiKey) {
  throw new Error('Set API_KEY before binding the API to a non-local HOST.');
}

module.exports = Object.freeze({
  host,
  port: numberFromEnv('PORT', 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  apiKey,
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map((x) => x.trim()).filter(Boolean),
  mqttUrl: process.env.MQTT_URL || 'mqtt://localhost:1883',
  telemetryTopic: process.env.MQTT_TELEMETRY_TOPIC || 'smart-campus/telemetry',
  deviceTelemetryTopic: process.env.MQTT_DEVICE_TELEMETRY_TOPIC || 'smart-campus/devices/+/telemetry',
  commandResponseTopic: process.env.MQTT_COMMAND_RESPONSE_TOPIC || 'smart-campus/devices/+/command-response',
  commandTopicPrefix: process.env.MQTT_COMMAND_TOPIC_PREFIX || 'smart-campus/devices',
  mqttClientId: process.env.MQTT_CLIENT_ID || `campusx-backend-${process.pid}`,
  mqttQos: numberFromEnv('MQTT_QOS', 1, 0),
  deviceOfflineSeconds: numberFromEnv('DEVICE_OFFLINE_SECONDS', 90),
  deviceSweepIntervalSeconds: numberFromEnv('DEVICE_SWEEP_INTERVAL_SECONDS', 20),
  maxReadingsPerMessage: numberFromEnv('MAX_READINGS_PER_MESSAGE', 100),
  maxMqttPayloadBytes: numberFromEnv('MAX_MQTT_PAYLOAD_BYTES', 65536),
  sqlConnectionTimeoutMs: numberFromEnv('SQL_CONNECTION_TIMEOUT_MS', 15000),
  sqlRequestTimeoutMs: numberFromEnv('SQL_REQUEST_TIMEOUT_MS', 30000),
});
