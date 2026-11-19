'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const syntax = spawnSync(process.execPath, [path.join(__dirname, 'syntax-check.js')], {
  cwd: root,
  encoding: 'utf8',
});
process.stdout.write(syntax.stdout || '');
process.stderr.write(syntax.stderr || '');
if (syntax.status !== 0) process.exit(syntax.status || 1);

try {
  require('dotenv').config({ path: path.join(root, '.env') });
  const env = require(path.join(root, 'src', 'config', 'env'));
  const contract = require(path.join(root, 'src', 'docs', 'contract'));
  const { compileTopic } = require(path.join(root, 'src', 'utils', 'mqttTopics'));

  for (const topic of [env.telemetryTopic, env.deviceTelemetryTopic, env.commandResponseTopic]) {
    compileTopic(topic);
  }
  if (!contract.endpoints.length) throw new Error('Contract has no endpoints');
  if (!contract.mqtt.guarantees.length) throw new Error('Contract has no MQTT guarantees');
  console.log('OK   configuration + runtime contract');
  process.exitCode = 0;
} catch (error) {
  console.error(`FAIL configuration + runtime contract: ${error.message}`);
  process.exitCode = 1;
}
