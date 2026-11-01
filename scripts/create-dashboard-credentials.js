'use strict';

const crypto = require('node:crypto');

const username = String(process.env.DASHBOARD_SETUP_USERNAME || '').trim();
const password = String(process.env.DASHBOARD_SETUP_PASSWORD || '');

if (!/^[A-Za-z0-9._@-]{3,64}$/.test(username)) {
  console.error('Username must be 3-64 characters: letters, numbers, dot, underscore, @ or hyphen.');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Choose a password of at least 12 characters.');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 64);
const sessionSecret = crypto.randomBytes(48).toString('base64url');

console.log('\nAdd these lines to the ROOT .env file (do not share them):\n');
console.log(`DASHBOARD_USERNAME=${username}`);
console.log(`DASHBOARD_PASSWORD_HASH=${salt.toString('hex')}:${hash.toString('hex')}`);
console.log(`DASHBOARD_SESSION_SECRET=${sessionSecret}`);
console.log('DASHBOARD_SESSION_HOURS=8');
console.log('DASHBOARD_COOKIE_SECURE=false');
console.log('\nThe password itself is not stored in .env. Keep .env private.');
