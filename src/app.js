'use strict';

require('dotenv').config();

const express = require('express');
const path = require('node:path');
const { securityMiddleware, apiKeyGuard } = require('./middleware/security');
const { errorHandler, HttpError } = require('./middleware/errors');
const apiRouter = require('./routes/api');
const computerVisionRouter = require('./routes/computerVision');
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

app.get('/docs', (req, res) => res.type('text/plain').send([
  'CampusX Backend API v1',
  '',
  'Dashboard login: GET /login.html, POST /auth/login, POST /auth/logout',
  'Dashboard: GET / or /dashboard (authenticated session required)',
  'GET /api/v1/health (public diagnostic endpoint)',
  'GET  /api/v1/sqlserver/health',
  'GET  /api/v1/dashboard/summary',
  'GET|POST|PATCH /api/v1/rooms',
  'GET|POST|PATCH /api/v1/nodes',
  'GET|POST /api/v1/node-types',
  'GET|POST|PATCH /api/v1/devices',
  'GET|POST|PATCH /api/v1/device-types',
  'GET|POST|PATCH /api/v1/metrics',
  'GET|POST|PATCH /api/v1/device-capabilities',
  'GET|POST|PATCH /api/v1/alert-rules',
  'GET /api/v1/telemetry/latest',
  'GET /api/v1/telemetry',
  'GET|PATCH /api/v1/alerts',
  'GET|POST /api/v1/commands',
  'GET|POST /api/v1/states',
  'GET /api/v1/stream (Server-Sent Events)',
  '',
  'MQTT telemetry: smart-campus/telemetry',
  'MQTT device telemetry: smart-campus/devices/{deviceCode}/telemetry',
  'MQTT command response: smart-campus/devices/{deviceCode}/command-response',
  'Dashboard API requires a signed login session. Write operations may also require X-API-Key.',
].join('\n')));

app.use('/api/v1/computer-vision', requireDashboardApi, apiKeyGuard, computerVisionRouter);
// Authenticated session required for every API route except /health; API_KEY is an optional extra guard.
app.use('/api/v1', requireDashboardApi, apiKeyGuard, apiRouter);

app.use((req, res, next) => next(
  new HttpError(404, 'NOT_FOUND', `Not found: ${req.method} ${req.originalUrl}`)
));
app.use(errorHandler);

module.exports = app;
