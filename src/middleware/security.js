'use strict';

const crypto = require('node:crypto');
const env = require('../config/env');

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function securityMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  const origin = req.headers.origin;
  const sameOrigin = `${req.protocol}://${req.get('host')}`;
  const isSameOrigin = Boolean(origin && (origin === sameOrigin || (env.publicOrigin && origin === env.publicOrigin)));
  if (origin) res.setHeader('Vary', 'Origin');
  if (isSameOrigin || (origin && env.corsOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
  } else if (origin) {
    return res.status(403).json({
      status: 'error',
      error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed by CORS_ORIGINS' },
    });
  }

  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

function apiKeyGuard(req, res, next) {
  if (!env.apiKey || ['HEAD', 'OPTIONS'].includes(req.method) || req.path === '/health') return next();

  // EventSource cannot set custom headers. A query key is accepted only for the
  // SSE endpoint; all other routes require the X-API-Key header.
  const queryKey = req.path === '/stream'
    ? (req.query.apiKey ?? req.query.api_key)
    : undefined;
  const supplied = req.get('x-api-key') || queryKey;

  if (!safeEqual(supplied, env.apiKey)) {
    const missing = !supplied;
    return res.status(401).json({
      status: 'error',
      error: {
        code: missing ? 'API_KEY_REQUIRED' : 'API_KEY_INVALID',
        message: missing
          ? 'Send a valid X-API-Key header for API requests'
          : 'The supplied X-API-Key is not valid',
      },
    });
  }
  next();
}

module.exports = { securityMiddleware, apiKeyGuard, safeEqual };
