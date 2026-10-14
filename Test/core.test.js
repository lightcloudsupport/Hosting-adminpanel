'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

const { loadConfig, ConfigError } = require('../src/config');
const { hashPassword, verifyPassword, safeEqual } = require('../src/password');
const { FailureLimiter } = require('../src/rateLimiter');
const createSessionStore = require('../src/sessionStore');
const { createAudit } = require('../src/audit');
const { createPtero } = require('../src/ptero');
const { createStats } = require('../src/stats');
const { mapServer, mapUser } = require('../src/mappers');
const { HttpError } = require('../src/errors');

const goodEnv = () => ({
  PANEL_URL: 'https://panel.example.com/', PANEL_APP_API_KEY: 'ptla_abcdef', ADMIN_USER: 'root',
  ADMIN_PASS: 'a-long-enough-password', SESSION_SECRET: 'x'.repeat(40),
});

// ------------------------------------------------------------------ config
test('config: accepts a good env and normalises the panel URL', () => {
  const c = loadConfig(goodEnv());
  assert.equal(c.panelUrl, 'https://panel.example.com');
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 3000);
  assert.equal(c.db, null);
  assert.ok(c.warnings.some((w) => /plain text/.test(w)));
});

test('config: reports every problem at once, and rejects example values', () => {
  assert.throws(() => loadConfig({ PANEL_APP_API_KEY: 'ptla_xxxxxxxx', ADMIN_PASS: 'change-this-strong-password', SESSION_SECRET: 'put-a-long-random-string-here' }),
    (e) => e instanceof ConfigError && /PANEL_URL/.test(e.message) && /ADMIN_USER/.test(e.message) && /SESSION_SECRET/.test(e.message) && /example value/.test(e.message));
});

test('config: DB settings, legacy DB_KEY and validation', () => {
  const c = loadConfig({ ...goodEnv(), DB_HOST: 'db', DB_USER: 'u', DB_NAME: 'panel', DB_KEY: 'pw' });
  assert.equal(c.db.password, 'pw');
  assert.ok(c.warnings.some((w) => /DB_KEY/.test(w)));
  assert.throws(() => loadConfig({ ...goodEnv(), DB_HOST: 'db', DB_USER: 'u', DB_NAME: 'p' }), /DB_PASSWORD/);
  assert.throws(() => loadConfig({ ...goodEnv(), PORT: '99999' }), /PORT/);
  assert.throws(() => loadConfig({ ...goodEnv(), PANEL_URL: 'ftp://x' }), /PANEL_URL/);
});

test('config: TRUST_PROXY parsing', () => {
  assert.equal(loadConfig({ ...goodEnv(), TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(loadConfig({ ...goodEnv(), TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
  assert.equal(loadConfig(goodEnv()).trustProxy, false);
});

// ------------------------------------------------------------------ password
test('password: hash/verify round trip, wrong password, malformed hash, oversize input', async () => {
  const h = await hashPassword('correct horse battery');
  assert.match(h, /^scrypt:[\w-]+:[\w-]+$/);
  assert.equal(await verifyPassword(h, 'correct horse battery'), true);
  assert.equal(await verifyPassword(h, 'wrong'), false);
  assert.equal(await verifyPassword('garbage', 'x'), false);
  assert.equal(await verifyPassword(h, 'a'.repeat(1000)), false);
  assert.equal(await verifyPassword(h, undefined), false);
  assert.notEqual(h, await hashPassword('correct horse battery')); // salted
  assert.equal(safeEqual('a', 'a'), true);
  assert.equal(safeEqual('a', 'ab'), false);
});

// ------------------------------------------------------------------ limiter
test('rate limiter: blocks after max failures, expires, resets, sweeps', () => {
  let t = 1000;
  const l = new FailureLimiter({ max: 3, windowMs: 1000, now: () => t });
  for (let i = 0; i < 3; i++) { assert.equal(l.retryAfterMs('ip'), 0); l.fail('ip'); }
  assert.ok(l.retryAfterMs('ip') > 0);
  assert.equal(l.retryAfterMs('other'), 0);
  t += 1001;
  assert.equal(l.retryAfterMs('ip'), 0);
  l.fail('a'); l.reset('a');
  assert.equal(l.hits.size, 0);
  l.fail('b'); t += 5000; l.sweep();
  assert.equal(l.hits.size, 0, 'old entries are evicted');
  l.stop();
});

// ------------------------------------------------------------------ session store
test('session store: set/get/touch/destroy and expiry', async () => {
  const store = createSessionStore({ Store: EventEmitter }, { ttlMs: 20 });
  const p = (fn, ...a) => new Promise((res, rej) => fn.call(store, ...a, (e, v) => (e ? rej(e) : res(v))));
  // explicit far-future cookie expiry => this part can't be affected by a slow machine
  const far = new Date(Date.now() + 3_600_000).toISOString();
  await p(store.set, 'a', { admin: true, cookie: { expires: far } });
  assert.deepEqual(await p(store.get, 'a'), { admin: true, cookie: { expires: far } });
  await p(store.destroy, 'a');
  assert.equal(await p(store.get, 'a'), null);
  await p(store.set, 'b', { x: 1 });
  await new Promise((r) => setTimeout(r, 100)); // only needs to be >= ttl, so slowness can't break it
  assert.equal(await p(store.get, 'b'), null, 'expired');
  await p(store.set, 'c', { x: 1 });
  await new Promise((r) => setTimeout(r, 100)); // only needs to be >= ttl, so slowness can't break it
  store.sweep();
  assert.equal(store.map.size, 0, 'sweep evicts expired entries');
  clearInterval(store.timer);
});

// ------------------------------------------------------------------ audit
test('audit: appends JSONL in order, serves newest first, reloads tail after restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const file = path.join(dir, 'sub', 'audit.log');
  const a = createAudit({ file, keep: 3 });
  for (let i = 0; i < 5; i++) a.record({ actor: 'root', ip: '1.1.1.1', action: `act${i}`, ok: i % 2 === 0 });
  assert.deepEqual(a.recent().map((e) => e.action), ['act4', 'act3', 'act2']);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 5);
  const b = createAudit({ file, keep: 3 });
  assert.equal(b.recent()[0].action, 'act4');
});

// ------------------------------------------------------------------ ptero client
const fakeFetch = (res, spy = {}) => async (url, opts) => {
  Object.assign(spy, { url, opts });
  if (res instanceof Error) throw res;
  return { status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => res.body };
};
const client = (res, spy) => createPtero({ baseUrl: 'https://p', apiKey: 'ptla_k', fetchImpl: fakeFetch(res, spy) });

test('ptero: panel 401/403 become 502 (never 401, which would sign the admin out)', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(client({ status }).request('GET', '/x'), (e) => e instanceof HttpError && e.status === 502);
  }
});

test('ptero: error mapping, 204, network failure and timeout', async () => {
  await assert.rejects(client({ status: 404 }).request('GET', '/x'), (e) => e.status === 404);
  await assert.rejects(client({ status: 422, body: { errors: [{ detail: 'User has servers' }] } }).request('DELETE', '/users/1'), (e) => e.status === 400 && e.message === 'User has servers');
  await assert.rejects(client({ status: 500 }).request('GET', '/x'), (e) => e.status === 502);
  assert.equal(await client({ status: 204 }).request('POST', '/x'), null);
  await assert.rejects(client(new TypeError('fetch failed')).request('GET', '/x'), (e) => e.status === 502);
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  await assert.rejects(client(timeout).request('GET', '/x'), (e) => e.status === 504);
});

test('ptero: sends auth header, no content-type without body, builds list query', async () => {
  const spy = {};
  const c = client({ status: 200, body: { data: [{ attributes: { id: 1 } }], meta: { pagination: { total: 51, current_page: 2, per_page: 25, total_pages: 3 } } } }, spy);
  const out = await c.list('servers', { page: 2, q: 'a&b=c', filter: 'name', include: 'user,node' });
  assert.equal(spy.opts.headers.Authorization, 'Bearer ptla_k');
  assert.equal(spy.opts.headers['Content-Type'], undefined);
  const u = new URL(spy.url);
  assert.equal(u.pathname, '/api/application/servers');
  assert.equal(u.searchParams.get('filter[name]'), 'a&b=c', 'search text is encoded, cannot inject extra params');
  assert.equal(u.searchParams.get('page'), '2');
  assert.deepEqual(out.pagination, { total: 51, page: 2, perPage: 25, totalPages: 3 });
  assert.deepEqual(out.items, [{ id: 1 }]);
});

// ------------------------------------------------------------------ mappers
test('mappers: whitelist fields and derive state', () => {
  const s = mapServer({ id: 1, name: 'n', suspended: false, status: 'installing', limits: { memory: 0, disk: 10 }, secret: 'x', relationships: { user: { attributes: { id: 5, username: 'bob', email: 'e' } } } });
  assert.equal(s.state, 'installing');
  assert.deepEqual(s.owner, { id: 5, username: 'bob' });
  assert.equal(s.secret, undefined);
  assert.equal(mapServer({ id: 1, suspended: true, limits: {} }).state, 'suspended');
  assert.equal(mapServer({ id: 1, limits: {} }).state, 'active');
  assert.equal(mapUser({ id: 1, root_admin: 1, '2fa': true, password: 'x' }).password, undefined);
});

// ------------------------------------------------------------------ stats
test('stats: uses DB, queries status (not the dropped suspended column), caches, invalidates', async () => {
  let queries = 0, sql = '';
  const pool = { query: async (q) => { queries++; sql = q; return [[{ users: '4', servers: 3, suspended: 1, nodes: 2 }]]; } };
  const s = createStats({ ptero: {}, pool });
  assert.deepEqual(await s.get(), { users: 4, servers: 3, suspended: 1, nodes: 2, source: 'database' });
  await s.get();
  assert.equal(queries, 1, 'cached');
  assert.match(sql, /status = 'suspended'/);
  assert.doesNotMatch(sql, /suspended = 1/);
  s.invalidate(); await s.get();
  assert.equal(queries, 2);
});

test('stats: DB failure degrades to the API instead of erroring', async () => {
  const errors = [];
  const pool = { query: async () => { throw new Error('ER_BAD_FIELD_ERROR'); } };
  const ptero = { list: async (res, o) => {
    const total = { users: 7, servers: 3, nodes: 1 }[res];
    return { items: res === 'servers' && o.perPage === 100 ? [{ suspended: true }, { suspended: false }, { suspended: true }] : [], pagination: { total } };
  } };
  const out = await createStats({ ptero, pool, logger: { error: (m) => errors.push(m) } }).get();
  assert.deepEqual(out, { users: 7, servers: 3, nodes: 1, suspended: 2, source: 'api', degraded: true });
  assert.match(errors[0], /ER_BAD_FIELD_ERROR/);
});

test('stats: API-only mode returns null suspended for very large fleets', async () => {
  const ptero = { list: async (res) => ({ items: [], pagination: { total: res === 'servers' ? 5000 : 1 } }) };
  const out = await createStats({ ptero, pool: null }).get();
  assert.equal(out.suspended, null);
  assert.equal(out.source, 'api');
});
