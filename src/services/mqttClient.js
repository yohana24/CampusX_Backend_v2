'use strict';

const mqtt = require('mqtt');
const env = require('../config/env');

const client = mqtt.connect(env.mqttUrl, {
  clientId: env.mqttClientId,
  connectTimeout: 10000,
  reconnectPeriod: 3000,
  clean: true,
});

client.on('connect', () => console.log(`[MQTT] Connected: ${env.mqttUrl}`));
client.on('reconnect', () => console.log('[MQTT] Reconnecting…'));
client.on('offline', () => console.warn('[MQTT] Client is offline'));
client.on('error', (err) => console.error('[MQTT] Error:', err.message));

function waitUntilConnected(timeoutMs = 5000) {
  if (client.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('MQTT broker is not connected'));
    }, timeoutMs);
    const onConnect = () => { cleanup(); resolve(); };
    const onError = (err) => { cleanup(); reject(err); };
    function cleanup() {
      clearTimeout(timer);
      client.off('connect', onConnect);
      client.off('error', onError);
    }
    client.once('connect', onConnect);
    client.once('error', onError);
  });
}

async function publish(topic, payload, options = {}) {
  await waitUntilConnected();
  const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    client.publish(topic, message, { qos: env.mqttQos, retain: false, ...options }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

module.exports = { client, publish, waitUntilConnected };
