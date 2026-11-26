'use strict';

/**
 * Supervises fake-actuator.js so the simulated relay/fan is always available.
 *
 * The actuator is a demo aid: without it, dashboard commands stay `pending`
 * forever because no MQTT client publishes a command-response. Running it as a
 * child of the backend means it starts with the server, restarts after a crash
 * and works on Windows, Linux and Raspberry Pi.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const env = require('../config/env');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'fake-actuator.js');

let child = null;
let stopping = false;
let restartTimer = null;
let backoffMs = 1000;
const MAX_BACKOFF_MS = 30000;

function startFakeActuator() {
  if (!env.fakeActuatorEnabled || stopping || child) return;

  child = spawn(process.execPath, [SCRIPT], {
    cwd: ROOT,
    env: {
      ...process.env,
      // Lets the actuator exit if this backend dies without a clean shutdown.
      CAMPUSX_ACTUATOR_PARENT_PID: String(process.pid),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });

  child.on('spawn', () => {
    backoffMs = 1000;
    console.log('[Fake Actuator] Supervised process started.');
  });

  child.on('error', (error) => {
    console.error('[Fake Actuator] Failed to start:', error.message);
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    console.warn(
      `[Fake Actuator] Exited (code=${code}, signal=${signal}); restarting in ${backoffMs} ms.`
    );
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startFakeActuator();
    }, backoffMs);
    restartTimer.unref?.();
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  });
}

async function stopFakeActuator() {
  stopping = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (!child) return;

  const target = child;
  child = null;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { target.kill('SIGKILL'); } catch { /* already gone */ }
      resolve();
    }, 5000);
    timer.unref?.();
    target.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      target.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

module.exports = { startFakeActuator, stopFakeActuator };
