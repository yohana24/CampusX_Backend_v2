'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const env = require('../config/env');

const execFileAsync = promisify(execFile);
const CV_DIR = path.resolve(
  process.env.CAMPUSX_CV_DIR || path.resolve(__dirname, '..', '..', 'computer-vision')
);
const START_SCRIPT = path.join(CV_DIR, 'start-computer-vision.ps1');
const STOP_SCRIPT = path.join(CV_DIR, 'stop-computer-vision.ps1');
const PYTHON_EXE = path.join(CV_DIR, '.venv', 'Scripts', 'python.exe');
const CAMERA_SCRIPT = path.join(CV_DIR, 'web_count3.py');
const BRIDGE_SCRIPT = path.join(CV_DIR, 'mqtt_bridge.py');
const STATE_DIR = path.join(CV_DIR, '.run');
const CAMERA_PID_FILE = path.join(STATE_DIR, 'camera.pid');
const BRIDGE_PID_FILE = path.join(STATE_DIR, 'bridge.pid');

const cameraHost = String(process.env.CV_WEB_HOST || '127.0.0.1').trim();
const cameraPort = Number.parseInt(process.env.CV_WEB_PORT || '5000', 10);
const previewUrl = `http://${cameraHost}:${cameraPort}/`;
let activeOperation = null;

// WMI process scans are the slowest part of /status. Cache them briefly so a
// burst of status polls (start -> status, stop -> status, dashboard polling)
// only pays for one scan. runScript() invalidates this after every operation.
let pidScanCache = null;
const PID_SCAN_TTL_MS = 1500;

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

function invalidatePidCache() {
  pidScanCache = null;
}

// One PowerShell process + one WMI scan finds BOTH the camera and bridge PIDs.
// Filtering by Name='python.exe' keeps the WMI result set small.
async function scanCvPids() {
  if (pidScanCache && Date.now() - pidScanCache.at < PID_SCAN_TTL_MS) return pidScanCache;
  if (process.platform !== 'win32') {
    pidScanCache = { at: Date.now(), camera: [], bridge: [] };
    return pidScanCache;
  }
  const command = [
    "$all = @(Get-CimInstance Win32_Process -Filter \"Name = 'python.exe'\" -ErrorAction SilentlyContinue)",
    "$cam = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('web_count3.py', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId })",
    "$brg = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf('mqtt_bridge.py', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId })",
    "[Console]::Out.WriteLine('CAM=' + ($cam -join ','))",
    "[Console]::Out.WriteLine('BRG=' + ($brg -join ','))",
  ].join('; ');
  try {
    const result = await execFileAsync(
      process.env.CAMPUSX_POWERSHELL_EXE || 'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024, encoding: 'utf8' }
    );
    const output = String(result.stdout || '');
    const parse = (key) => {
      const match = output.match(new RegExp(`${key}=([^\\r\\n]*)`));
      return match
        ? match[1].split(',').map((value) => Number.parseInt(value.trim(), 10))
            .filter((pid) => Number.isInteger(pid) && pid > 0)
        : [];
    };
    pidScanCache = { at: Date.now(), camera: parse('CAM'), bridge: parse('BRG') };
  } catch {
    pidScanCache = { at: Date.now(), camera: [], bridge: [] };
  }
  return pidScanCache;
}

function getJson(url, timeoutMs = 700) {
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
  const cameraPidAlive = isProcessAlive(cameraPid);
  const bridgePidAlive = isProcessAlive(bridgePid);
  // Only pay for a WMI scan when a pid file is missing or stale. One cached
  // scan covers both scripts, and valid pid files skip WMI entirely.
  if (!cameraPidAlive || !bridgePidAlive) {
    const scan = await scanCvPids();
    if (!cameraPidAlive) cameraPid = scan.camera[0] || null;
    if (!bridgePidAlive) bridgePid = scan.bridge[0] || null;
  }
  const cameraRunning = Boolean(snapshot);
  const bridgeRunning = isProcessAlive(bridgePid);
  const anyRunning = cameraRunning || bridgeRunning;

  return {
    enabled: process.platform === 'win32',
    configured,
    running: cameraRunning && bridgeRunning,
    partiallyRunning: anyRunning && !(cameraRunning && bridgeRunning),
    // Surfaced so the dashboard can distinguish "stopped" from "stop is queued
    // behind a still-running start request".
    busy: Boolean(activeOperation),
    operation: activeOperation ? activeOperation.name : null,
    camera: {
      running: cameraRunning,
      managed: Boolean(cameraPid && isProcessAlive(cameraPid)),
      pid: isProcessAlive(cameraPid) ? cameraPid : null,
      currentPeople: Number.isFinite(Number(snapshot?.count ?? snapshot?.raw))
        ? Number(snapshot.count ?? snapshot.raw) : null,
      candidates: Number.isFinite(Number(snapshot?.candidates)) ? Number(snapshot.candidates) : null,
      inferenceMs: Number.isFinite(Number(snapshot?.infer_ms)) ? Number(snapshot.infer_ms) : null,
      fps: Number.isFinite(Number(snapshot?.fps)) ? Number(snapshot.fps) : null,
      detectionStatus: snapshot?.status || null,
      detector: snapshot?.detector || null,
      model: snapshot?.model || null,
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

async function waitForActiveOperation(requestedName) {
  if (!activeOperation || activeOperation.name === requestedName) return;
  const current = activeOperation;
  let timer;
  const timedOut = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Timed out waiting for the in-progress Computer Vision ${current.name} request to finish.`);
      error.code = 'CV_OPERATION_WAIT_TIMEOUT';
      reject(error);
    }, env.cvOperationWaitMs);
    if (timer.unref) timer.unref();
  });
  try {
    // A failed start must not prevent a subsequent stop from trying to clean up.
    await Promise.race([current.promise.catch(() => undefined), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function runOperation(name, fn) {
  if (activeOperation) {
    if (activeOperation.name === name) return activeOperation.promise;
    const error = new Error(`Computer Vision is already processing a ${activeOperation.name} request.`);
    error.code = 'CV_OPERATION_IN_PROGRESS';
    throw error;
  }

  const operation = { name, promise: null };
  operation.promise = Promise.resolve()
    .then(fn)
    .finally(() => {
      if (activeOperation === operation) activeOperation = null;
    });
  activeOperation = operation;
  return operation.promise;
}

async function runScript(scriptPath, operationName) {
  invalidatePidCache();
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

  const powershell = process.env.CAMPUSX_POWERSHELL_EXE || 'powershell.exe';
  const executionPolicy = String(process.env.CAMPUSX_POWERSHELL_EXECUTION_POLICY || 'RemoteSigned').trim();
  const powershellArgs = ['-NoLogo', '-NoProfile', '-NonInteractive'];
  if (executionPolicy) powershellArgs.push('-ExecutionPolicy', executionPolicy);
  powershellArgs.push('-File', scriptPath);

  // File-backed stdio matters here: with pipes, the long-lived Python children
  // spawned by Start-Process inherit PowerShell's pipe handles, so the parent
  // never sees EOF and every start/stop stalls until the full timeout.
  const outFile = path.join(STATE_DIR, `last-${operationName}.out.log`);
  const errFile = path.join(STATE_DIR, `last-${operationName}.err.log`);
  let outFd = null;
  let errFd = null;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    outFd = fs.openSync(outFile, 'w');
    errFd = fs.openSync(errFile, 'w');
  } catch {
    // Fall back to pipes if the state directory is not writable.
  }

  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const child = spawn(powershell, powershellArgs, {
        cwd: CV_DIR,
        windowsHide: true,
        stdio: ['ignore', outFd === null ? 'pipe' : outFd, errFd === null ? 'pipe' : errFd],
      });
      let pipedOut = '';
      let pipedErr = '';
      if (child.stdout) child.stdout.on('data', (chunk) => { pipedOut += chunk; });
      if (child.stderr) child.stderr.on('data', (chunk) => { pipedErr += chunk; });
      timer = setTimeout(() => {
        child.kill();
        const error = new Error(`Computer Vision ${operationName} script timed out.`);
        error.code = 'ETIMEDOUT';
        finish(reject, error);
      }, env.cvScriptTimeoutMs);
      if (timer.unref) timer.unref();
      child.on('error', (error) => finish(reject, error));
      child.on('close', (code) => finish(resolve, { code, pipedOut, pipedErr }));
    });

    const readOutput = (fd, file, fallback) => {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
      try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
    };
    const stdout = readOutput(outFd, outFile, result.pipedOut || '');
    const stderr = readOutput(errFd, errFile, result.pipedErr || '');
    outFd = null;
    errFd = null;

    if (result.code !== 0) {
      const details = [stderr, stdout]
        .filter(Boolean)
        .map((value) => String(value).trim())
        .filter(Boolean)
        .join('\n');
      const error = new Error(details || `Computer Vision ${operationName} script exited with code ${result.code}.`);
      error.code = `CV_${operationName.toUpperCase()}_FAILED`;
      throw error;
    }
    return {
      message: `${operationName === 'start' ? 'Start' : 'Stop'} request completed.`,
      output: stdout.trim(),
      warnings: stderr.trim(),
    };
  } catch (error) {
    const details = [error.message, error.stdout, error.stderr]
      .filter(Boolean)
      .map((value) => String(value).trim())
      .filter(Boolean)
      .join('\n');
    const wrapped = new Error(details || `Could not ${operationName} Computer Vision.`);
    wrapped.code = error.code === 'ETIMEDOUT'
      ? 'CV_SCRIPT_TIMEOUT'
      : (error.code || `CV_${operationName.toUpperCase()}_FAILED`);
    throw wrapped;
  } finally {
    if (outFd !== null) { try { fs.closeSync(outFd); } catch { /* already closed */ } }
    if (errFd !== null) { try { fs.closeSync(errFd); } catch { /* already closed */ } }
    // Start/stop change the process set, so the next status must re-scan.
    invalidatePidCache();
  }
}

async function start() {
  if (activeOperation && activeOperation.name === 'start') return activeOperation.promise;
  await waitForActiveOperation('start');
  return runOperation('start', async () => {
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
  });
}

async function stop() {
  if (activeOperation && activeOperation.name === 'stop') return activeOperation.promise;
  await waitForActiveOperation('stop');
  return runOperation('stop', async () => {
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
  });
}

module.exports = { getStatus, start, stop };
