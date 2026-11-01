
'use strict';

/**
 * Fake relay/fan actuator for CampusX command-flow testing.
 *
 * Commands topic:
 *   smart-campus/devices/{deviceCode}/commands
 *
 * Response topic:
 *   smart-campus/devices/{deviceCode}/command-response
 *
 * This simulates firmware only; it does not control physical hardware.
 */

const mqtt = require('mqtt');

const MQTT_URL =
  process.env.MQTT_URL || 'mqtt://localhost:1883';

const COMMANDS_TOPIC =
  process.env.ACTUATOR_COMMANDS_TOPIC ||
  'smart-campus/devices/+/commands';

const DEVICE_CODE_FILTER =
  (process.env.ACTUATOR_DEVICE_CODE || '').trim();

const clientId = `fake-actuator-${process.pid}`;
const simulatedStates = new Map();

const client = mqtt.connect(MQTT_URL, {
  clientId,
  connectTimeout: 10000,
  reconnectPeriod: 2000,
});

client.on('connect', () => {
  console.log(`[Fake Actuator] Connected to ${MQTT_URL}`);
  console.log(`[Fake Actuator] Subscribing to ${COMMANDS_TOPIC}`);

  if (DEVICE_CODE_FILTER) {
    console.log(
      `[Fake Actuator] Device filter: ${DEVICE_CODE_FILTER}`
    );
  }

  client.subscribe(COMMANDS_TOPIC, { qos: 1 }, (error) => {
    if (error) {
      console.error(
        '[Fake Actuator] Subscribe failed:',
        error.message
      );
      return;
    }

    console.log(
      '[Fake Actuator] Ready; waiting for commands...'
    );
  });
});

client.on('message', (topic, buffer) => {
  void handleCommand(topic, buffer).catch((error) => {
    console.error(
      '[Fake Actuator] Command handling failed:',
      error.message
    );
  });
});

async function handleCommand(topic, buffer) {
  const match =
    /^smart-campus\/devices\/([^/]+)\/commands$/.exec(topic);

  if (!match) return;

  const deviceCode = decodeURIComponent(match[1]);

  if (
    DEVICE_CODE_FILTER &&
    deviceCode !== DEVICE_CODE_FILTER
  ) {
    return;
  }

  let command;

  try {
    command = JSON.parse(buffer.toString('utf8'));
  } catch {
    console.error(
      `[Fake Actuator] Invalid JSON on ${topic}`
    );
    return;
  }

  if (
    command.command_id === undefined ||
    command.command_id === null
  ) {
    console.error(
      '[Fake Actuator] Missing command_id; cannot respond.'
    );
    return;
  }

  const payload =
    command.payload &&
    typeof command.payload === 'object'
      ? command.payload
      : {};

  let result;
  let success = true;

  const type = String(command.type || '').toLowerCase();

  // Simulate turning a relay/fan on or off.
  if (
    type === 'set_state' ||
    type === 'setstate' ||
    type === 'relay'
  ) {
    const desired =
      payload.state ?? payload.value ?? payload.on;

    if (typeof desired === 'boolean') {
      simulatedStates.set(
        deviceCode,
        desired ? 'on' : 'off'
      );
    } else if (
      typeof desired === 'string' &&
      ['on', 'off'].includes(desired.toLowerCase())
    ) {
      simulatedStates.set(
        deviceCode,
        desired.toLowerCase()
      );
    } else {
      success = false;
      result = {
        error: 'Expected payload.state to be "on" or "off"',
      };
    }

    if (success) {
      result = {
        deviceCode,
        state: simulatedStates.get(deviceCode),
        simulated: true,
      };
    }
  } else if (
    type === 'get_state' ||
    type === 'getstate' ||
    type === 'status'
  ) {
    result = {
      deviceCode,
      state: simulatedStates.get(deviceCode) || 'unknown',
      simulated: true,
    };
  } else {
    // Acknowledge unknown command types for transport testing.
    // This does not mean a physical action was performed.
    result = {
      deviceCode,
      accepted: true,
      commandType: command.type || 'unknown',
      simulated: true,
    };
  }

  const responseTopic =
    `smart-campus/devices/${encodeURIComponent(deviceCode)}` +
    '/command-response';

  const response = {
    command_id: String(command.command_id),
    success,
    status: success ? 'completed' : 'failed',
    result,
  };

  await new Promise((resolve, reject) => {
    client.publish(
      responseTopic,
      JSON.stringify(response),
      { qos: 1 },
      (error) => {
        if (error) reject(error);
        else resolve();
      }
    );
  });

  console.log(
    `[Fake Actuator] ${deviceCode}: ${command.type} -> ` +
    `${success ? 'completed' : 'failed'}`
  );

  console.log(`  command_id=${command.command_id}`);
  console.log(`  response_topic=${responseTopic}`);
  console.log(`  result=${JSON.stringify(result)}`);
};

client.on('error', (error) => {
  console.error('[Fake Actuator] MQTT error:', error.message);
});

function shutdown(signal) {
  console.log(
    `\n[Fake Actuator] ${signal}; disconnecting...`
  );

  client.end(false, {}, () => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
