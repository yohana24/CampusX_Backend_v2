'use strict';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) console.error(`[HTTP ${req.method} ${req.originalUrl}]`, err.stack || err.message);
  res.status(status).json({
    status: 'error',
    error: {
      code: err.code || (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
      message: status === 500 && process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    },
  });
}

module.exports = { HttpError, asyncHandler, errorHandler };
