'use strict';

const mqtt = require('mqtt');
const env = require('../config/env');

const options = {
  clientId: env.mqttClientId,
  connectTimeout: env.mqttConnectTimeoutMs,
  reconnectPeriod: env.mqttReconnectPeriodMs,
  clean: true,
};

if (env.mqttUsername) {
  options.username = env.mqttUsername;
  options.password = env.mqttPassword;
}

const client = mqtt.connect(env.mqttUrl, options);

client.on('connect', () => console.log(`[MQTT] Connected: ${env.mqttUrl} (clientId=${env.mqttClientId})`));
client.on('reconnect', () => console.log('[MQTT] Reconnecting…'));
client.on('offline', () => console.warn('[MQTT] Client is offline'));
client.on('error', (err) => console.error('[MQTT] Error:', err.message));

function waitUntilConnected(timeoutMs = env.mqttWaitForConnectMs) {
  if (client.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('MQTT broker is not connected'));
    }, timeoutMs);
    timer.unref?.();
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

async function publish(topic, payload, publishOptions = {}) {
  if (typeof topic !== 'string' || !topic.trim()) {
    throw new Error('MQTT publish topic is required');
  }
  const {
    timeoutMs = env.mqttPublishTimeoutMs,
    waitForConnectMs = env.mqttWaitForConnectMs,
    ...mqttOptions
  } = publishOptions;

  await waitUntilConnected(waitForConnectMs);
  const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const finalOptions = { qos: env.mqttQos, retain: false, ...mqttOptions };

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`MQTT publish timed out after ${timeoutMs} ms on ${topic}`));
    }, timeoutMs);
    timer.unref?.();

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    }

    try {
      client.publish(topic, message, finalOptions, (error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

function endClient(force = false, timeoutMs = env.mqttShutdownTimeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { client.end(true); } catch { /* ignore */ }
        resolve();
      }
    }, timeoutMs);
    timer.unref?.();
    try {
      client.end(force, {}, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    }
  });
}

module.exports = {
  client,
  options,
  publish,
  waitUntilConnected,
  endClient,
};
