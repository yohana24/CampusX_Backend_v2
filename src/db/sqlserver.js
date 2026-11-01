
'use strict';

require('dotenv').config();

const sql = require('mssql/msnodesqlv8');
const env = require('../config/env');

const server =
  process.env.SQL_SERVER || 'DESKTOP-9A5M5CC\\SQLEXPRESS';

const database =
  process.env.SQL_DATABASE || 'CampusX';

const driver =
  process.env.SQL_DRIVER || 'ODBC Driver 18 for SQL Server';

const trustedConnection =
  (process.env.SQL_TRUSTED_CONNECTION || 'true').toLowerCase() === 'true';

const encrypt =
  (process.env.SQL_ENCRYPT || 'false').toLowerCase() === 'true';

const trustServerCertificate =
  (process.env.SQL_TRUST_SERVER_CERTIFICATE || 'true').toLowerCase() === 'true';

// Explicitly specify the installed ODBC driver.
const connectionString = [
  `Driver={${driver}}`,
  `Server={${server}}`,
  `Database={${database}}`,
  `Trusted_Connection=${trustedConnection ? 'Yes' : 'No'}`,
  `Encrypt=${encrypt ? 'Yes' : 'No'}`,
  `TrustServerCertificate=${trustServerCertificate ? 'Yes' : 'No'}`
].join(';') + ';';

const config = {
  connectionString,
  connectionTimeout: env.sqlConnectionTimeoutMs,
  requestTimeout: env.sqlRequestTimeoutMs,
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

const pool = new sql.ConnectionPool(config);
const poolPromise = pool.connect();

poolPromise.catch((error) => {
  console.error('[SQL Server] Initial connection failed:', error.message);
});

module.exports = { sql, pool, poolPromise };
