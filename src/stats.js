'use strict';

const API_SUSPENDED_SCAN_LIMIT = 500; // don't walk huge fleets just to count suspensions

/**
 * Overview numbers. Prefers one cheap SQL query; if the DB is missing or the
 * query fails it degrades to the API instead of returning a 500.
 */
function createStats({ ptero, pool, logger = console, ttlMs = 10_000, now = Date.now }) {
  let cache = null;

  async function fromDatabase() {
    // Pterodactyl 1.x stores suspension in servers.status (the old `suspended` column was dropped).
    const [[row]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM servers) AS servers,
         (SELECT COUNT(*) FROM servers WHERE status = 'suspended') AS suspended,
         (SELECT COUNT(*) FROM nodes) AS nodes`
    );
    return {
      users: Number(row.users), servers: Number(row.servers),
      suspended: Number(row.suspended), nodes: Number(row.nodes), source: 'database',
    };
  }

  async function countSuspendedViaApi(total) {
    if (total === 0) return 0;
    if (total > API_SUSPENDED_SCAN_LIMIT) return null;
    const pages = Math.ceil(total / 100);
    const results = await Promise.all(
      Array.from({ length: pages }, (_, i) => ptero.list('servers', { page: i + 1, perPage: 100 }))
    );
    return results.flatMap((r) => r.items).filter((s) => s.suspended).length;
  }

  async function fromApi() {
    const [u, s, n] = await Promise.all([
      ptero.list('users', { perPage: 1 }),
      ptero.list('servers', { perPage: 1 }),
      ptero.list('nodes', { perPage: 1 }),
    ]);
    return {
      users: u.pagination.total, servers: s.pagination.total, nodes: n.pagination.total,
      suspended: await countSuspendedViaApi(s.pagination.total), source: 'api',
    };
  }

  async function get() {
    if (cache && now() - cache.at < ttlMs) return cache.value;
    let value;
    if (pool) {
      try { value = await fromDatabase(); }
      catch (e) {
        logger.error(`[stats] database query failed, falling back to API: ${e.message}`);
        value = { ...(await fromApi()), degraded: true };
      }
    } else {
      value = await fromApi();
    }
    cache = { at: now(), value };
    return value;
  }

  return { get, invalidate: () => { cache = null; } };
}

module.exports = { createStats };
