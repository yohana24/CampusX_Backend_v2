'use strict';

const express = require('express');
const {
  requireDashboardApi,
  getAccountHandler,
  updateCredentialsHandler,
} = require('../middleware/dashboardAuth');

const router = express.Router();

// Account profile is limited to username and password management.
router.get('/account', requireDashboardApi, getAccountHandler);
router.patch('/account/credentials', requireDashboardApi, updateCredentialsHandler);

module.exports = router;
