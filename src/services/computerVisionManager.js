'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const CV_DIR = path.resolve(
  process.env.CAMPUSX_CV_DIR || path.resolve(__dirname, '..', '..', 'computer-vision')
);
const START_SCRIPT = path.join(CV_DIR, 'start-computer-vision.ps1');
const STOP_SCRIPT = path.join(CV_DIR, 'stop-computer-vision.ps1');
const PYTHON_EXE = path.join(CV_DIR, '.venv', 'Scripts', 'python.exe');
const CAMERA_SCRIPT = path.join(CV_DIR, 'web_count_campusx.py');
const BRIDGE_SCRIPT = path.join(CV_DIR, 'mqtt_bridge.py');
const STATE_DIR = path.join(CV_DIR, '.run');
const CAMERA_PID_FILE = path.join(STATE_DIR, 'camera.pid');
const BRIDGE_PID_FILE = path.join(STATE_DIR, 'bridge.pid');

const cameraHost = String(process.env.CV_WEB_HOST || '127.0.0.1').trim();
const cameraPort = Number.parseInt(process.env.CV_WEB_PORT || '5000', 10);
const previewUrl = `http://${cameraHost}:${cameraPort}/`;
let activeOperation = null;

function isConfigured() {
  return [START_SCRIPT, STOP_SCRIPT, PYTHON_EXE, CAMERA_SCRIPT, BRIDGE_SCRIPT]
    .every((file) => fs.existsSync(file));
}

function readPid(pidFile) {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

async function findScriptPids(scriptName) {
  if (process.platform !== 'win32') return [];
  const safeName = String(scriptName).replace(/'/g, "''");
  const command = `$items = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('${safeName}', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }; $items | ForEach-Object { [Console]::Out.WriteLine($_.ProcessId) }`;
  try {
    const result = await execFileAsync(
      process.env.CAMPUSX_POWERSHELL_EXE || 'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024, encoding: 'utf8' }
    );
    return String(result.stdout || '').split(/\r?\n/).map((value) => Number.parseInt(value.trim(), 10)).filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function getJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get(url, { headers: { accept: 'application/json' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) request.destroy(new Error('CV health response too large'));
      });
      response.on('end', () => {
        if (response.statusCode !== 200) return resolve(null);
        try {
          const parsed = JSON.parse(body);
          resolve(parsed && typeof parsed === 'object' ? parsed : null);
        } catch {
          resolve(null);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('CV health timeout')));
    request.on('error', () => resolve(null));
  });
}

async function getStatus() {
  const configured = isConfigured();
  const snapshot = await getJson(`http://${cameraHost}:${cameraPort}/json`);
  let cameraPid = readPid(CAMERA_PID_FILE);
  let bridgePid = readPid(BRIDGE_PID_FILE);
  if (!isProcessAlive(cameraPid)) cameraPid = (await findScriptPids('web_count_campusx.py'))[0] || null;
  if (!isProcessAlive(bridgePid)) bridgePid = (await findScriptPids('mqtt_bridge.py'))[0] || null;
  const cameraRunning = Boolean(snapshot);
  const bridgeRunning = isProcessAlive(bridgePid);
  const anyRunning = cameraRunning || bridgeRunning;

  return {
    enabled: process.platform === 'win32',
    configured,
    running: cameraRunning && bridgeRunning,
    partiallyRunning: anyRunning && !(cameraRunning && bridgeRunning),
    camera: {
      running: cameraRunning,
      managed: Boolean(cameraPid && isProcessAlive(cameraPid)),
      pid: isProcessAlive(cameraPid) ? cameraPid : null,
      currentPeople: Number.isFinite(Number(snapshot?.raw)) ? Number(snapshot.raw) : null,
      inferenceMs: Number.isFinite(Number(snapshot?.infer_ms)) ? Number(snapshot.infer_ms) : null,
      lastFrameAt: snapshot?.ts || null,
    },
    bridge: {
      running: bridgeRunning,
      managed: Boolean(bridgeRunning),
      pid: bridgeRunning ? bridgePid : null,
    },
    previewUrl,
    scripts: {
      start: fs.existsSync(START_SCRIPT),
      stop: fs.existsSync(STOP_SCRIPT),
      python: fs.existsSync(PYTHON_EXE),
      camera: fs.existsSync(CAMERA_SCRIPT),
      bridge: fs.existsSync(BRIDGE_SCRIPT),
    },
  };
}

async function runScript(scriptPath, operationName) {
  if (process.platform !== 'win32') {
    const error = new Error('Computer Vision process controls are currently configured for Windows only.');
    error.code = 'CV_PLATFORM_UNSUPPORTED';
    throw error;
  }
  if (!fs.existsSync(scriptPath)) {
    const error = new Error(`Missing ${path.basename(scriptPath)} in ${CV_DIR}`);
    error.code = 'CV_SCRIPT_MISSING';
    throw error;
  }
  if (activeOperation) {
    const error = new Error(`Computer Vision is already processing a ${activeOperation} request.`);
    error.code = 'CV_OPERATION_IN_PROGRESS';
    throw error;
  }

  activeOperation = operationName;
  try {
    const powershell = process.env.CAMPUSX_POWERSHELL_EXE || 'powershell.exe';
    const result = await execFileAsync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        cwd: CV_DIR,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      }
    );
    return {
      message: `${operationName === 'start' ? 'Start' : 'Stop'} request completed.`,
      output: String(result.stdout || '').trim(),
      warnings: String(result.stderr || '').trim(),
    };
  } catch (error) {
    const details = [error.message, error.stdout, error.stderr]
      .filter(Boolean)
      .map((value) => String(value).trim())
      .filter(Boolean)
      .join('\n');
    const wrapped = new Error(details || `Could not ${operationName} Computer Vision.`);
    wrapped.code = error.code || `CV_${operationName.toUpperCase()}_FAILED`;
    throw wrapped;
  } finally {
    activeOperation = null;
  }
}

async function start() {
  const before = await getStatus();
  if (!before.enabled) {
    const error = new Error('Computer Vision dashboard controls require the Windows host running this CampusX server.');
    error.code = 'CV_PLATFORM_UNSUPPORTED';
    throw error;
  }
  if (!before.configured) {
    const missing = Object.entries(before.scripts).filter(([, exists]) => !exists).map(([name]) => name);
    const error = new Error(`Computer Vision files are missing: ${missing.join(', ')}. Check the computer-vision folder and .venv.`);
    error.code = 'CV_FILES_MISSING';
    throw error;
  }
  if (before.running) return { message: 'Computer Vision and MQTT Bridge are already running.', status: before };
  const operation = await runScript(START_SCRIPT, 'start');
  const status = await getStatus();
  return { ...operation, status };
}

async function stop() {
  const before = await getStatus();
  if (!before.enabled) {
    const error = new Error('Computer Vision dashboard controls require the Windows host running this CampusX server.');
    error.code = 'CV_PLATFORM_UNSUPPORTED';
    throw error;
  }
  if (!fs.existsSync(STOP_SCRIPT)) {
    const error = new Error(`Missing ${path.basename(STOP_SCRIPT)} in ${CV_DIR}`);
    error.code = 'CV_SCRIPT_MISSING';
    throw error;
  }
  const operation = await runScript(STOP_SCRIPT, 'stop');
  const status = await getStatus();
  return { ...operation, status };
}

module.exports = { getStatus, start, stop };
