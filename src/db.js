'use strict';

/** Optional read-only connection to the panel database. Returns null if unconfigured. */
function createPool(dbConfig, mysql = require('mysql2/promise')) {
  if (!dbConfig) return null;
  return mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    ssl: dbConfig.ssl ? { rejectUnauthorized: true } : undefined,
    connectionLimit: 5,
    connectTimeout: 5000,
    enableKeepAlive: true,
  });
}

module.exports = { createPool };
