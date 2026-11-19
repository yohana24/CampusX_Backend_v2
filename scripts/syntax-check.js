'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const files = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
}

walk(path.join(root, 'src'));
walk(path.join(root, 'scripts'));
files.push(path.join(root, 'app.js'));
files.push(path.join(root, 'fake-esp32.js'));
files.push(path.join(root, 'fake-actuator.js'));

let failed = false;
for (const file of [...new Set(files)]) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(`FAIL ${path.relative(root, file)}\n${result.stderr || result.stdout}`);
  } else {
    process.stdout.write(`OK   ${path.relative(root, file)}\n`);
  }
}
process.exitCode = failed ? 1 : 0;
