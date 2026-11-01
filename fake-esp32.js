'use strict';

require('dotenv').config();
const mqtt = require('mqtt');

const url = process.env.MQTT_URL || 'mqtt://localhost:1883';
const topic = process.env.MQTT_TELEMETRY_TOPIC || 'smart-campus/telemetry';
const deviceCode = process.env.DEVICE_ID || 'esp32-lab-01';
const intervalMs = Math.max(1000, Number(process.env.SIMULATOR_INTERVAL_MS || 5000));
const scenarios = [
  { name: 'normal', temperature: 25.5, humidity: 55.2 },
  { name: 'warning', temperature: 32.5, humidity: 56.0 },
  { name: 'critical', temperature: 42.5, humidity: 57.1 },
  { name: 'recovered', temperature: 25.5, humidity: 55.5 },
];

const client = mqtt.connect(url, {
  clientId: `campusx-fake-${process.pid}`,
  reconnectPeriod: 2000,
});
let stopped = false;

function stop(exitCode = 0) {
  if (stopped) return;
  stopped = true;
  client.end(false, {}, () => process.exit(exitCode));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publish(sample, sequence) {
  const payload = {
    device_id: deviceCode,
    message_id: `fake-${process.pid}-${Date.now()}-${sequence}`,
    readings: [
      { metric: 'temperature', value: sample.temperature, unit: 'C' },
      { metric: 'humidity', value: sample.humidity, unit: '%' },
    ],
  };
  return new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
      if (error) return reject(error);
      console.log(`[Fake ESP32] ${sample.name}: ${sample.temperature} C, ${sample.humidity}%`);
      resolve();
    });
  });
}

client.once('connect', async () => {
  console.log(`[Fake ESP32] Connected to ${url}`);
  console.log(`[Fake ESP32] Publishing to ${topic} as ${deviceCode}`);
  try {
    for (let i = 0; i < scenarios.length; i += 1) {
      await publish(scenarios[i], i + 1);
      if (i < scenarios.length - 1) await delay(intervalMs);
    }
    console.log('[Fake ESP32] Sequence completed. Exiting.');
    stop(0);
  } catch (error) {
    console.error('[Fake ESP32] Publish failed:', error.message);
    stop(1);
  }
});

client.on('error', (error) => console.error('[Fake ESP32] MQTT error:', error.message));
process.on('SIGINT', () => {
  console.log('\n[Fake ESP32] Stopped by user.');
  stop(0);
});
