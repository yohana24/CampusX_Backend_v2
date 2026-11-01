'use strict';

const env = require('../config/env');

function securityMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin && env.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
  } else if (origin && !env.corsOrigins.includes(origin)) {
    return res.status(403).json({ status: 'error', error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed by CORS_ORIGINS' } });
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

function apiKeyGuard(req, res, next) {
  if (!env.apiKey || ['HEAD', 'OPTIONS'].includes(req.method) || req.path === '/health') return next();
  // EventSource cannot set custom headers; allow the key in query only for the SSE stream.
  const supplied = req.get('x-api-key') || (req.path === '/stream' ? req.query.apiKey : undefined);
  if (supplied !== env.apiKey) {
    return res.status(401).json({ status: 'error', error: { code: 'API_KEY_REQUIRED', message: 'Send a valid X-API-Key header for API requests' } });
  }
  next();
}

module.exports = { securityMiddleware, apiKeyGuard };
