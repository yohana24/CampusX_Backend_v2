'use strict';

require('dotenv').config();

const express = require('express');
const path = require('node:path');
const env = require('./config/env');
const { securityMiddleware, apiKeyGuard } = require('./middleware/security');
const { errorHandler, HttpError } = require('./middleware/errors');
const apiRouter = require('./routes/api');
const computerVisionRouter = require('./routes/computerVision');
const contract = require('./docs/contract');
const {
  isAuthConfigured,
  sessionMiddleware,
  loginHandler,
  logoutHandler,
  sessionHandler,
  requireDashboardPage,
  requireDashboardApi,
} = require('./middleware/dashboardAuth');

const app = express();
const publicDir = path.resolve(__dirname, '..', 'public');
const pageFiles = new Map([
  ['/index.html', 'index.html'],
  ['/devices.html', 'devices.html'],
  ['/labs.html', 'labs.html'],
  ['/alerts.html', 'alerts.html'],
  ['/control-panel.html', 'control-panel.html'],
  ['/command-history.html', 'command-history.html'],
  ['/settings.html', 'settings.html'],
]);
const dashboardAccountRoutes = require('./routes/dashboardAccount');
app.disable('x-powered-by');
app.use(securityMiddleware);
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(sessionMiddleware);
// Authentication endpoints. Login page remains public; dashboard and API do not.
app.get('/login.html', (req, res, next) => {
  if (isAuthConfigured() && req.dashboardUser) {
    return res.redirect('/dashboard');
  }

  res.sendFile(path.join(publicDir, 'login.html'), (error) => error && next(error));
});
app.get('/login', (req, res) => res.redirect('/login.html'));
app.get('/register.html', (req, res, next) => {
  if (isAuthConfigured() && req.dashboardUser) {
    return res.redirect('/dashboard');
  }

  res.sendFile(path.join(publicDir, 'register.html'), (error) => error && next(error));
});
app.get('/register', (req, res) => res.redirect('/register.html'));
app.post('/auth/login', loginHandler);
app.post('/auth/logout', logoutHandler);
app.get('/auth/session', sessionHandler);
app.use('/auth', dashboardAccountRoutes);

function sendDashboardPage(fileName) {
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, fileName), (error) => error && next(error));
  };
}

app.get('/', (req, res) => {
  if (!isAuthConfigured() || !req.dashboardUser) {
    return res.redirect('/login.html');
  }

  return res.redirect('/dashboard');
});
app.get('/dashboard', requireDashboardPage, sendDashboardPage('index.html'));
for (const [route, fileName] of pageFiles) {
  app.get(route, requireDashboardPage, sendDashboardPage(fileName));
}

// Only the explicitly routed pages above may return HTML. Do not let express.static
// expose an unregistered HTML file by direct URL.
app.use((req, res, next) => {
  if (req.method === 'GET' && /\.html$/i.test(req.path)) {
    return next(new HttpError(404, 'NOT_FOUND', `Not found: ${req.method} ${req.originalUrl}`));
  }
  next();
});

// Static assets (CSS, JS, images) are public; HTML pages are explicitly routed above.
app.use(express.static(publicDir, {
  index: false,
  etag: true,
  maxAge: 0,
  setHeaders(res, filePath) {
    if (/\.(?:html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.get('/docs/contract.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  return res.json(contract);
});

app.get('/docs', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  return res.type('html').send([
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>CampusX Backend v2 — Contract</title>',
    '<style>body{margin:0;background:#0b1220;color:#dbe7ff;font:15px/1.6 system-ui,Segoe UI,sans-serif}',
    'header{padding:42px 7vw;background:linear-gradient(120deg,#123c69,#0b1220 70%);border-bottom:1px solid #233a5c}',
    'h1{margin:0 0 8px;font-size:38px;letter-spacing:-1px}header p{max-width:760px;color:#9fb8dc}',
    'main{padding:32px 7vw;max-width:1100px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}',
    'article{background:#111c30;border:1px solid #233a5c;border-radius:12px;padding:20px}',
    'h2{margin:0 0 10px;font-size:18px;color:#7fd1ff}code{background:#08111f;padding:2px 6px;border-radius:5px;color:#9ef0c3}',
    'table{width:100%;border-collapse:collapse;margin-top:10px}td,th{text-align:left;padding:7px 8px;border-bottom:1px solid #1f3352;vertical-align:top}',
    'th{color:#89a7cf;font-weight:600}a{color:#7fd1ff}.pill{display:inline-block;background:#123c69;color:#cfe8ff;padding:3px 9px;border-radius:99px;font-size:12px;margin:2px}',
    '</style></head><body><header><h1>CampusX Backend v2</h1>',
    '<p>SQL Server is the source of truth. MQTT carries device telemetry and commands. SSE pushes live events to the dashboard.</p>',
    '<p><span class="pill">Health /docs → /api/v1/health</span><span class="pill">Machine contract → /docs/contract.json</span></p></header><main>',
    '<div class="grid">',
    '<article><h2>MQTT uplink</h2><p><code>' + contract.mqtt.subscribe[0].topic + '</code><br>',
    '<code>' + contract.mqtt.subscribe[1].topic + '</code><br>',
    '<code>' + contract.mqtt.subscribe[2].topic + '</code></p>',
    '<p>Commands: <code>' + contract.mqtt.publish[0].topicTemplate + '</code></p>',
    '<p>QoS <code>' + env.mqttQos + '</code> · retain <code>false</code> · numeric-string <code>command_id</code>.</p></article>',
    '<article><h2>Guarantees</h2><ul>' + contract.mqtt.guarantees.map((item) => '<li>' + item + '</li>').join('') + '</ul></article>',
    '</div><article style="margin-top:16px"><h2>HTTP endpoints</h2><table><thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Notes</th></tr></thead><tbody>',
    contract.endpoints.map((e) => '<tr><td><code>' + e.method + '</code></td><td><code>' + e.path + '</code></td><td>' + e.auth + '</td><td>' + e.note + '</td></tr>').join(''),
    '</tbody></table></article></main></body></html>',
  ].join(''));
});

app.use('/api/v1/computer-vision', requireDashboardApi, apiKeyGuard, computerVisionRouter);
// Authenticated session required for every API route except /health; API_KEY is an optional extra guard.
app.use('/api/v1', requireDashboardApi, apiKeyGuard, apiRouter);

app.use((req, res, next) => next(
  new HttpError(404, 'NOT_FOUND', `Not found: ${req.method} ${req.originalUrl}`)
));
app.use(errorHandler);

module.exports = app;
