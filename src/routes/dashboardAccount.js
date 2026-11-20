'use strict';

const express = require('express');
const {
  requireDashboardApi,
  requireAdminApi,
  registerHandler,
  getAccountHandler,
  updateCredentialsHandler,
  adminListAccountsHandler,
  adminUpdateAccountHandler,
  adminDeleteAccountHandler,
} = require('../middleware/dashboardAuth');

const router = express.Router();

// Public signup creates a real SQL account and signs the new user in.
router.post('/register', registerHandler);

// Account profile is limited to username and password management.
router.get('/account', requireDashboardApi, getAccountHandler);
router.patch('/account/credentials', requireDashboardApi, updateCredentialsHandler);

// Administrator-only account governance.
router.get('/admin/accounts', requireDashboardApi, requireAdminApi, adminListAccountsHandler);
router.patch('/admin/accounts/:id', requireDashboardApi, requireAdminApi, adminUpdateAccountHandler);
router.delete('/admin/accounts/:id', requireDashboardApi, requireAdminApi, adminDeleteAccountHandler);

module.exports = router;
