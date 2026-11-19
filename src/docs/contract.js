'use strict';

const env = require('../config/env');
const { buildDeviceTopic } = require('../utils/mqttTopics');

const API = '/api/v1';

const errorEnvelope = {
  status: 'error',
  error: { code: 'VALIDATION_ERROR', message: 'Human-readable explanation' },
};

const contract = {
  name: 'CampusX Backend v2 Contract',
  version: '2.0.0',
  generatedAt: 'runtime',
  transport: {
    http: `${env.host}:${env.port}`,
    mqtt: env.mqttUrl,
    qos: env.mqttQos,
    database: 'SQL Server (single source of truth)',
  },
  authentication: {
    dashboard: 'Signed HttpOnly SameSite=Strict cookie from POST /auth/login',
    apiKey: env.apiKey ? 'X-API-Key header required for non-health API routes' : 'Optional X-API-Key (not configured)',
    sse: 'Dashboard cookie required; X-API-Key header or ?apiKey= only for /api/v1/stream',
  },
  responseEnvelope: {
    success: { status: 'ok', data: [], count: 0, limit: 100, offset: 0 },
    error: errorEnvelope,
  },
  pagination: {
    query: ['limit (1..500)', 'offset (>=0)'],
    response: ['count', 'limit', 'offset', 'total', 'page', 'totalPages'],
  },
  mqtt: {
    subscribe: [
      {
        topic: env.telemetryTopic,
        direction: 'device -> server',
        qos: env.mqttQos,
        purpose: 'Batch telemetry from any device',
      },
      {
        topic: env.deviceTelemetryTopic,
        direction: 'device -> server',
        qos: env.mqttQos,
        purpose: 'Per-device telemetry; first wildcard is deviceCode',
      },
      {
        topic: env.commandResponseTopic,
        direction: 'device -> server',
        qos: env.mqttQos,
        purpose: 'Terminal command acknowledgement',
      },
    ],
    publish: [
      {
        topicTemplate: `${env.commandTopicPrefix}/{deviceCode}/commands`,
        direction: 'server -> device',
        qos: env.mqttQos,
        retain: false,
        purpose: 'Command delivery',
      },
    ],
    payloads: {
      telemetry: {
        device_id: 'string (or deviceCode in topic)',
        message_id: 'string; required for QoS-1 idempotency',
        recorded_at: 'ISO date/time; bounded by server config',
        readings: [
          { metric: 'registered MetricCode', value: 'number|string|boolean|object', unit: 'optional string' },
        ],
      },
      command: {
        command_id: 'numeric string (Commands.CommandId)',
        type: env.commandTypes.length ? env.commandTypes : 'any registered command type',
        payload: { state: '"on" or "off" for set_state' },
      },
      commandResponse: {
        command_id: 'numeric string echo of the command',
        success: 'boolean',
        status: '"completed" or "failed" when success is omitted',
        result: { state: '"on" or "off" (also accepted as top-level state)' },
      },
    },
    examples: {
      telemetry: {
        topic: env.telemetryTopic,
        payload: {
          device_id: 'esp32-lab-01',
          message_id: 'esp32-lab-01-1700000000000-1',
          recorded_at: new Date().toISOString(),
          readings: [
            { metric: 'temperature', value: 25.5, unit: 'C' },
            { metric: 'humidity', value: 55.2, unit: '%' },
          ],
        },
      },
      command: {
        topic: buildDeviceTopic(env.commandTopicPrefix, 'relay-lab-01', 'commands'),
        payload: { command_id: '42', type: 'set_state', payload: { state: 'on' } },
      },
      commandResponse: {
        topic: buildDeviceTopic(env.commandTopicPrefix, 'relay-lab-01', 'command-response'),
        payload: { command_id: '42', success: true, status: 'completed', result: { state: 'on' } },
      },
    },
    guarantees: [
      'QoS 1 for subscriptions and publishes; retain=false for commands.',
      'command_id is a numeric string that maps to dbo.Commands.CommandId.',
      'Duplicate QoS-1 command responses are ignored; no duplicate audit or state rows.',
      'Telemetry with a repeated message_id per device+metric is ignored.',
      'SQL Server is authoritative: a confirmed relay_state prevents redundant actuator commands.',
    ],
  },
  endpoints: [
    { method: 'GET', path: `${API}/health`, auth: 'public', note: 'Liveness + DB/MQTT/auth checks; ?strict=1 returns 503 when degraded' },
    { method: 'GET', path: `${API}/db-check`, auth: 'session', note: 'SQL round-trip latency and pool state' },
    { method: 'GET', path: `${API}/sqlserver/health`, auth: 'session', note: 'Database name and base-table count' },
    { method: 'GET', path: `${API}/dashboard/summary`, auth: 'session', note: 'Counts + recent alerts' },
    { method: 'GET,POST', path: `${API}/rooms`, auth: 'session', note: 'GET /labs is a legacy alias' },
    { method: 'GET,PATCH', path: `${API}/rooms/:id`, auth: 'session', note: 'Single room with node/device counts' },
    { method: 'GET,POST', path: `${API}/node-types`, auth: 'session', note: 'Node catalogue' },
    { method: 'GET,POST,PATCH', path: `${API}/nodes`, auth: 'session', note: 'ESP32 nodes' },
    { method: 'GET,POST,PATCH', path: `${API}/device-types`, auth: 'session', note: 'Sensor / actuator / camera / other' },
    { method: 'GET,POST,PATCH', path: `${API}/devices`, auth: 'session', note: 'Registered devices' },
    { method: 'GET,POST,PATCH', path: `${API}/metrics`, auth: 'session', note: 'Generic measurement dictionary' },
    { method: 'GET,POST,PATCH', path: `${API}/device-capabilities`, auth: 'session', note: 'Capabilities per device type' },
    { method: 'GET,POST,PATCH', path: `${API}/alert-rules`, auth: 'session', note: 'Threshold rules stored in SQL' },
    { method: 'GET', path: `${API}/telemetry`, auth: 'session', note: 'History with room/device/metric/time filters' },
    { method: 'GET', path: `${API}/telemetry/latest`, auth: 'session', note: 'Latest point per device + metric' },
    { method: 'GET,PATCH', path: `${API}/alerts`, auth: 'session', note: 'Lifecycle filters' },
    { method: 'GET', path: `${API}/alerts/:id`, auth: 'session', note: 'Single alert' },
    { method: 'POST', path: `${API}/alerts/:id/acknowledge`, auth: 'session', note: 'Alias for PATCH status=acknowledged' },
    { method: 'POST', path: `${API}/alerts/:id/resolve`, auth: 'session', note: 'Alias for PATCH status=resolved' },
    { method: 'POST,GET', path: `${API}/commands`, auth: 'session', note: 'Publish command / paginated history' },
    { method: 'GET', path: `${API}/commands/:id`, auth: 'session', note: 'Command detail and current status' },
    { method: 'GET', path: `${API}/states`, auth: 'session', note: 'Actuator state history' },
    { method: 'GET', path: `${API}/states/latest`, auth: 'session', note: 'Latest confirmed state per device + StateCode' },
    { method: 'POST', path: `${API}/states`, auth: 'session', note: 'Manual state record' },
    { method: 'GET,PUT', path: `${API}/occupancy-automation`, auth: 'session', note: 'Per-room people-count automation settings' },
    { method: 'GET,POST', path: `${API}/computer-vision/*`, auth: 'session', note: 'status / start / stop' },
    { method: 'GET', path: `${API}/stream`, auth: 'session', note: 'Server-Sent Events (telemetry, alert, command, device.state)' },
    { method: 'GET', path: '/docs', auth: 'public', note: 'Human-readable documentation landing page' },
    { method: 'GET', path: '/docs/contract.json', auth: 'public', note: 'This machine-readable contract' },
  ],
};

module.exports = contract;
