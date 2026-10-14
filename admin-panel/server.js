'use strict';
require('dotenv').config(); // load .env into process.env before anything reads it
const { loadConfig } = require('./src/config');

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const { hashPassword } = require('./src/password');
const { createPtero } = require('./src/ptero');
const { createPool } = require('./src/db');
const { createStats } = require('./src/stats');
const { createAudit } = require('./src/audit');
const { createApp } = require('./src/app');

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

(async () => {
  for (const w of config.warnings) console.warn(`[config] ${w}`);

  // A plaintext ADMIN_PASS is hashed once at boot so login uses the same constant-time path.
  const adminPassHash = config.adminPassHash || (await hashPassword(config.adminPassPlain));
  const cfg = { ...config, adminPassHash, adminPassPlain: null };

  const ptero = createPtero({ baseUrl: cfg.panelUrl, apiKey: cfg.apiKey });
  const pool = createPool(cfg.db);
  const stats = createStats({ ptero, pool });
  const audit = createAudit({ file: cfg.auditLog });
  const { app, auth } = createApp({ config: cfg, ptero, stats, audit });

  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`Admin panel listening on http://${cfg.host}:${cfg.port}`);
  });
  server.on('error', (e) => { console.error(`Cannot start server: ${e.message}`); process.exit(1); });

  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    console.log(`${sig} received, shutting down...`);
    auth.limiter.stop();
    server.close(async () => {
      if (pool) await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref(); // don't hang on keep-alive sockets
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();
