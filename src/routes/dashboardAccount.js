'use strict';

const express = require('express');
const {
  requireDashboardApi,
  registerHandler,
  getAccountHandler,
  updateCredentialsHandler,
} = require('../middleware/dashboardAuth');

const router = express.Router();

// Public signup creates a real SQL account and signs the new user in.
router.post('/register', registerHandler);

// Account profile is limited to username and password management.
router.get('/account', requireDashboardApi, getAccountHandler);
router.patch('/account/credentials', requireDashboardApi, updateCredentialsHandler);

module.exports = router;
