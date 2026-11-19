'use strict';

const { client } = require('./mqttClient');
const env = require('../config/env');
const { isTopicMatch } = require('../utils/mqttTopics');
const { processTelemetryMessage } = require('./telemetryService');
const { processCommandResponse } = require('./commandResponseService');
const { evaluateOccupancyAutomation } = require('./occupancyAutomationService');

let started = false;

function startMqttService() {
  if (started) return;
  started = true;

  const subscribeTopics = () => {
    const subscriptions = [...new Set([
      env.telemetryTopic,
      env.deviceTelemetryTopic,
      env.commandResponseTopic,
    ])];
    client.subscribe(subscriptions, { qos: env.mqttQos }, (error, granted) => {
      if (error) {
        console.error('[MQTT] Subscription failed:', error.message);
        return;
      }
      console.log(
        `[MQTT] Subscribed (QoS ${env.mqttQos}):`,
        (granted || []).map((x) => x.topic).join(', ')
      );
    });
  };

  client.on('connect', subscribeTopics);
  // The MQTT client can connect while SQL Server is starting up. Do not miss
  // the first connect event if that happened before this service was started.
  if (client.connected) subscribeTopics();

  client.on('message', async (topic, message) => {
    try {
      const isTelemetry = isTopicMatch(env.telemetryTopic, topic)
        || isTopicMatch(env.deviceTelemetryTopic, topic);
      if (isTelemetry) {
        const result = await processTelemetryMessage(topic, message);
        for (const reading of result.readings || []) {
          if (String(reading.metricCode || '').toLowerCase() !== 'people_count') continue;
          const count = Number(reading.ValueNumeric ?? reading.valueNumeric ?? reading.value);
          if (!Number.isInteger(count)) continue;
          try {
            await evaluateOccupancyAutomation({
              deviceCode: reading.deviceCode,
              count,
              receivedAt: reading.ReceivedAt ?? reading.receivedAt ?? reading.RecordedAt ?? reading.recordedAt,
            });
          } catch (automationError) {
            console.error('[Occupancy Automation] Evaluation failed:', automationError.message);
          }
        }
        console.log(
          `[Telemetry] ${result.savedCount} saved for ${result.device?.DeviceCode || 'unknown'}; ` +
          `${result.duplicateSkipped} duplicate reading(s) skipped`
        );
        return;
      }

      if (isTopicMatch(env.commandResponseTopic, topic)) {
        const rawResponse = message.toString('utf8');
        console.log(`[MQTT] Command response received on ${topic}: ${rawResponse.slice(0, 2000)}`);
        const result = await processCommandResponse(topic, message);
        if (result) {
          const commandId = result.commandId ?? result.command_id ?? 'unknown';
          const status = result.status ?? 'unknown';
          console.log(`[Command] ${commandId} -> ${status}${result.duplicate ? ' (duplicate ignored)' : ''}`);
        } else {
          console.warn(`[Command] Response ignored on ${topic}`);
        }
      }
    } catch (error) {
      console.error(`[MQTT] Message processing failed on ${topic}:`, error.message);
    }
  });
}

module.exports = { startMqttService, client };
