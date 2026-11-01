'use strict';

const express = require('express');
const computerVisionManager = require('../services/computerVisionManager');

const router = express.Router();

function sendError(res, error) {
  const code = error.code || 'CV_MANAGER_ERROR';
  const status = code === 'CV_OPERATION_IN_PROGRESS' ? 409
    : code === 'CV_PLATFORM_UNSUPPORTED' ? 501
      : code === 'CV_FILES_MISSING' || code === 'CV_SCRIPT_MISSING' ? 503
        : 500;
  return res.status(status).json({
    status: 'error',
    error: { code, message: error.message || 'Computer Vision operation failed.' },
  });
}

router.get('/status', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ status: 'ok', data: await computerVisionManager.getStatus() });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/start', async (req, res) => {
  try {
    const result = await computerVisionManager.start();
    return res.json({ status: 'ok', message: result.message, data: result.status, output: result.output || '' });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/stop', async (req, res) => {
  try {
    const result = await computerVisionManager.stop();
    return res.json({ status: 'ok', message: result.message, data: result.status, output: result.output || '' });
  } catch (error) {
    return sendError(res, error);
  }
});

module.exports = router;
