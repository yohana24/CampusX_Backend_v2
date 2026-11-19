'use strict';

require('dotenv').config();

const baseUrl = String(process.env.CAMPUSX_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const apiKey = String(process.env.API_KEY || '').trim();
const headers = { accept: 'application/json' };
if (apiKey) headers['x-api-key'] = apiKey;

let cookie = '';
let failed = false;

function report(name, ok, detail = '') {
  if (ok) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failed = true;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function getJson(path, withAuthHeaders = true) {
  const requestHeaders = { ...headers };
  if (withAuthHeaders && cookie) requestHeaders.cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, { headers: requestHeaders });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function checkGet(name, path) {
  try {
    const { response, body } = await getJson(path);
    report(name, response.ok && body.status === 'ok', `HTTP ${response.status}`);
  } catch (error) {
    report(name, false, error.message);
  }
}

(async () => {
  try {
    const health = await getJson('/api/v1/health');
    const detail = `${health.body.status || 'unknown'} / DB ${health.body.database || '?'} / MQTT ${health.body.mqtt || '?'}`;
    report('Public health', health.response.ok, `HTTP ${health.response.status} · ${detail}`);
  } catch (error) {
    report('Public health', false, error.message);
  }

  try {
    const docs = await getJson('/docs/contract.json');
    const count = Array.isArray(docs.body.endpoints) ? docs.body.endpoints.length : 0;
    report('Runtime contract', docs.response.ok && count > 0, `${count} endpoints`);
  } catch (error) {
    report('Runtime contract', false, error.message);
  }

  const username = String(process.env.CAMPUSX_SMOKE_USERNAME || '').trim();
  const password = String(process.env.CAMPUSX_SMOKE_PASSWORD || '');
  if (!username || !password) {
    console.log('SKIP authenticated checks — set CAMPUSX_SMOKE_USERNAME and CAMPUSX_SMOKE_PASSWORD');
    process.exitCode = failed ? 1 : 0;
    return;
  }

  try {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const setCookie = response.headers.get('set-cookie') || '';
    cookie = setCookie.split(';')[0];
    report('Dashboard login', response.ok && Boolean(cookie), `HTTP ${response.status}`);
  } catch (error) {
    report('Dashboard login', false, error.message);
  }

  await checkGet('Dashboard summary', '/api/v1/dashboard/summary');
  await checkGet('DB check', '/api/v1/db-check');
  await checkGet('Rooms', '/api/v1/rooms');
  await checkGet('Devices', '/api/v1/devices');
  await checkGet('Telemetry latest', '/api/v1/telemetry/latest');
  await checkGet('Alerts', '/api/v1/alerts?limit=5');
  await checkGet('Commands', '/api/v1/commands?limit=5');
  await checkGet('Latest states', '/api/v1/states/latest');

  process.exitCode = failed ? 1 : 0;
})();
