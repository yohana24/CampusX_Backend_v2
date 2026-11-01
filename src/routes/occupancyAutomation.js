'use strict';

const express = require('express');
const {
  getOccupancyAutomationSettings,
  saveOccupancyAutomationSettings,
} = require('../services/occupancyAutomationService');
const { HttpError, asyncHandler } = require('../middleware/errors');

const router = express.Router();

function integer(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${name} must be a whole number between ${min} and ${max}`);
  }
  return number;
}

function boolean(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw new HttpError(400, 'VALIDATION_ERROR', `${name} must be true or false`);
}

function deviceCode(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > 100) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${name} must be a device code of at most 100 characters`);
  }
  return value.trim();
}

router.get('/', asyncHandler(async (req, res) => {
  const roomId = integer(req.query.roomId, 'roomId', 1, 2147483647, null);
  if (!roomId) throw new HttpError(400, 'VALIDATION_ERROR', 'roomId is required');
  const data = await getOccupancyAutomationSettings(roomId);
  return res.json({ status: 'ok', data });
}));

router.put('/', asyncHandler(async (req, res) => {
  const roomId = integer(req.body?.roomId, 'roomId', 1, 2147483647, null);
  if (!roomId) throw new HttpError(400, 'VALIDATION_ERROR', 'roomId is required');
  const input = {
    roomId,
    isEnabled: boolean(req.body?.isEnabled, 'isEnabled', false),
    personThreshold: integer(req.body?.personThreshold, 'personThreshold', 0, 500, 3),
    offDelaySeconds: integer(req.body?.offDelaySeconds, 'offDelaySeconds', 5, 3600, 30),
    restoreOnAboveThreshold: boolean(req.body?.restoreOnAboveThreshold, 'restoreOnAboveThreshold', true),
    fanDeviceCode: deviceCode(req.body?.fanDeviceCode, 'fanDeviceCode'),
    lightDeviceCode: deviceCode(req.body?.lightDeviceCode, 'lightDeviceCode'),
  };
  const data = await saveOccupancyAutomationSettings(input);
  return res.json({ status: 'ok', message: 'Occupancy automation settings saved.', data });
}));

module.exports = router;
