'use strict';
// Exercises the real auth + route handlers through a minimal stand-in for express.Router.
// (This tests OUR logic; Express itself is not under test.)
const Module = require('module');
const test = require('node:test');
const assert = require('node:assert/strict');

function FakeRouter() {
  const routes = [];
  const r = { routes };
  for (const m of ['get', 'post', 'delete', 'use']) {
    r[m] = (...args) => routes.push(typeof args[0] === 'function' ? { m, path: null, handlers: args } : { m, path: args[0], handlers: args.slice(1) });
  }
  return r;
}
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'express') return { Router: FakeRouter };
  return origLoad.call(this, request, ...rest);
};
const { createAuth, requireSameOrigin } = require('../src/auth');
const { createApiRouter, parseId, parsePage } = require('../src/routes');
const { hashPassword } = require('../src/password');
const { HttpError } = require('../src/errors');
Module._load = origLoad;

/** Run a request through a router's matching routes. Resolves {res} or {error}. */
async function dispatch(router, method, url, { body, query, session, ip = '9.9.9.9', headers = {} } = {}) {
  const res = {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this._finish(); return this; },
    set(k, v) { this.headers[k] = v; return this; },
    clearCookie() {},
  };
  const req = { method, params: {}, query: query || {}, body, session, ip, get: (h) => headers[h.toLowerCase()] };
  for (const route of router.routes) {
    if (route.m !== 'use' && route.m !== method.toLowerCase()) continue;
    if (route.path) {
      const m = new RegExp(`^${route.path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`).exec(url);
      if (!m) continue;
      req.params = { ...m.groups };
    }
    for (const handler of route.handlers) {
      const outcome = await new Promise((resolve) => {
        res._finish = () => resolve({ done: true });
        try { handler(req, res, (e) => resolve({ next: true, err: e })); } catch (e) { resolve({ next: true, err: e }); }
      });
      if (outcome.err) return { error: outcome.err, res };
      if (outcome.done) return { res };
    }
  }
  return { error: new HttpError(404, 'Not found.'), res };
}

const newSession = (extra = {}) => ({
  ...extra,
  regenerate(cb) { this.regenerated = true; delete this.admin; cb(); },
  destroy(cb) { this.destroyed = true; cb(); },
});
const mkAudit = () => { const log = []; return { log, record: (e) => log.push(e), recent: () => log.slice().reverse() }; };

async function setup(overrides = {}) {
  const config = { adminUser: 'root', adminPassHash: await hashPassword('correct-horse-battery'), loginMaxAttempts: 3, loginWindowMs: 60_000, sessionMaxMs: 1000, allowedOrigin: null, ...overrides };
  const audit = mkAudit();
  const auth = createAuth({ config, audit });
  return { config, audit, auth };
}

// ------------------------------------------------------------------ login
test('login: success regenerates the session (anti-fixation), marks admin, audits', async () => {
  const { auth, audit } = await setup();
  const session = newSession();
  const { res, error } = await dispatch(auth.router, 'POST', '/login', { body: { username: 'root', password: 'correct-horse-battery' }, session });
  assert.equal(error, undefined);
  assert.deepEqual(res.body, { ok: true, user: 'root' });
  assert.equal(session.regenerated, true);
  assert.equal(session.admin, true);
  assert.equal(audit.log.at(-1).ok, true);
  auth.limiter.stop();
});

test('login: wrong user OR wrong password -> same 401, nothing granted, failures audited', async () => {
  const { auth, audit } = await setup();
  for (const body of [{ username: 'root', password: 'nope' }, { username: 'nobody', password: 'correct-horse-battery' }]) {
    const session = newSession();
    const { error } = await dispatch(auth.router, 'POST', '/login', { body, session });
    assert.equal(error.status, 401);
    assert.equal(error.message, 'Wrong username or password.');
    assert.equal(session.admin, undefined);
  }
  assert.equal(audit.log.filter((e) => !e.ok).length, 2);
  auth.limiter.stop();
});

test('login: bad input types are rejected without hashing', async () => {
  const { auth } = await setup();
  for (const body of [undefined, {}, { username: 1, password: 2 }, { username: ['root'], password: 'x' }, { username: 'root', password: 'x'.repeat(500) }]) {
    const { error } = await dispatch(auth.router, 'POST', '/login', { body, session: newSession() });
    assert.equal(error.status, 400);
  }
  auth.limiter.stop();
});

test('login: locks out an IP after N failures (even with the right password) but not other IPs', async () => {
  const { auth } = await setup();
  const bad = { username: 'root', password: 'wrong' };
  for (let i = 0; i < 3; i++) assert.equal((await dispatch(auth.router, 'POST', '/login', { body: bad, session: newSession(), ip: '1.1.1.1' })).error.status, 401);
  const blocked = await dispatch(auth.router, 'POST', '/login', { body: { username: 'root', password: 'correct-horse-battery' }, session: newSession(), ip: '1.1.1.1' });
  assert.equal(blocked.error.status, 429);
  assert.ok(Number(blocked.res.headers['Retry-After']) > 0);
  const other = await dispatch(auth.router, 'POST', '/login', { body: { username: 'root', password: 'correct-horse-battery' }, session: newSession(), ip: '2.2.2.2' });
  assert.equal(other.res.body.ok, true);
  auth.limiter.stop();
});

test('login: success resets the failure counter', async () => {
  const { auth } = await setup();
  const bad = { username: 'root', password: 'wrong' };
  for (let i = 0; i < 2; i++) await dispatch(auth.router, 'POST', '/login', { body: bad, session: newSession() });
  await dispatch(auth.router, 'POST', '/login', { body: { username: 'root', password: 'correct-horse-battery' }, session: newSession() });
  for (let i = 0; i < 2; i++) assert.equal((await dispatch(auth.router, 'POST', '/login', { body: bad, session: newSession() })).error.status, 401);
  auth.limiter.stop();
});

// ------------------------------------------------------------------ me / logout / requireAuth
test('me and logout', async () => {
  const { auth } = await setup();
  assert.deepEqual((await dispatch(auth.router, 'GET', '/me', { session: newSession() })).res.body, { admin: false, user: null });
  assert.deepEqual((await dispatch(auth.router, 'GET', '/me', { session: newSession({ admin: true }) })).res.body, { admin: true, user: 'root' });
  const s = newSession({ admin: true });
  assert.equal((await dispatch(auth.router, 'POST', '/logout', { session: s })).res.body.ok, true);
  assert.equal(s.destroyed, true);
  auth.limiter.stop();
});

test('requireAuth: blocks anonymous, allows admin, enforces absolute session lifetime', async () => {
  const { auth } = await setup();
  const run = (session) => new Promise((resolve) => auth.requireAuth({ session }, {}, (e) => resolve(e || 'allowed')));
  assert.equal((await run(undefined)).status, 401);
  assert.equal((await run(newSession())).status, 401);
  assert.equal(await run(newSession({ admin: true, createdAt: Date.now() })), 'allowed');
  const old = newSession({ admin: true, createdAt: Date.now() - 5000 });
  const e = await run(old);
  assert.equal(e.status, 401);
  assert.equal(old.destroyed, true);
  auth.limiter.stop();
});

// ------------------------------------------------------------------ CSRF / origin
test('csrf: state-changing requests need the header and a matching Origin', async () => {
  const mw = requireSameOrigin({ allowedOrigin: null });
  const run = (method, headers) => new Promise((resolve) => mw({ method, get: (h) => headers[h.toLowerCase()] }, {}, (e) => resolve(e || 'allowed')));
  assert.equal(await run('GET', {}), 'allowed');
  assert.equal((await run('POST', {})).status, 403, 'no custom header');
  assert.equal(await run('POST', { 'x-requested-with': 'admin-panel', host: 'admin.example.com' }), 'allowed', 'no Origin header (curl/same-origin GET-less) is fine');
  assert.equal(await run('POST', { 'x-requested-with': 'admin-panel', host: 'admin.example.com', origin: 'https://admin.example.com' }), 'allowed');
  assert.equal((await run('DELETE', { 'x-requested-with': 'admin-panel', host: 'admin.example.com', origin: 'https://evil.example' })).status, 403);
  assert.equal((await run('POST', { 'x-requested-with': 'admin-panel', host: 'admin.example.com', origin: 'null' })).status, 403);
  const pinned = requireSameOrigin({ allowedOrigin: 'https://admin.example.com' });
  const run2 = (headers) => new Promise((resolve) => pinned({ method: 'POST', get: (h) => headers[h.toLowerCase()] }, {}, (e) => resolve(e || 'allowed')));
  assert.equal(await run2({ 'x-requested-with': 'admin-panel', host: 'internal:3000', origin: 'https://admin.example.com' }), 'allowed');
  assert.equal((await run2({ 'x-requested-with': 'admin-panel', host: 'internal:3000', origin: 'https://other.example' })).status, 403);
});

// ------------------------------------------------------------------ API routes
function apiSetup(panel = {}) {
  const calls = [];
  const ptero = {
    list: async (resource, opts) => { calls.push(['list', resource, opts]); return panel.list ? panel.list(resource, opts) : { items: [], pagination: { total: 0, page: 1, perPage: 25, totalPages: 1 } }; },
    get: async (resource, id) => { calls.push(['get', resource, id]); return panel.get ? panel.get(resource, id) : { name: `n${id}`, username: `u${id}` }; },
    request: async (method, ep) => { calls.push([method, ep]); if (panel.request) return panel.request(method, ep); return null; },
  };
  let invalidated = 0;
  const stats = { get: async () => ({ users: 1 }), invalidate: () => invalidated++ };
  const audit = mkAudit();
  const router = createApiRouter({ ptero, stats, audit, config: { adminUser: 'root' } });
  return { router, calls, audit, get invalidated() { return invalidated; } };
}

test('routes: validators', () => {
  assert.equal(parseId('12'), 12);
  for (const bad of ['0', '-1', '1.5', 'abc', '1e3', '12345678901', '', '1/../2']) assert.throws(() => parseId(bad), (e) => e.status === 400, bad);
  assert.equal(parsePage('3'), 3);
  for (const bad of ['0', '-4', 'x', undefined, '9999999']) assert.equal(parsePage(bad), 1);
});

test('routes: servers list passes page/search/include and whitelists fields', async () => {
  const t = apiSetup({ list: async () => ({ items: [{ id: 1, name: 'A', suspended: false, limits: { memory: 512 }, daemon_secret: 'LEAK' }], pagination: { total: 1, page: 2, perPage: 25, totalPages: 2 } }) });
  const { res } = await dispatch(t.router, 'GET', '/servers', { query: { page: '2', q: '  web  ' } });
  assert.deepEqual(t.calls[0], ['list', 'servers', { page: 2, perPage: 25, q: 'web', include: 'user,node', filter: 'name' }]);
  assert.equal(res.body.data[0].name, 'A');
  assert.equal(JSON.stringify(res.body).includes('LEAK'), false);
});

test('routes: user search switches to the email filter when the query has an @', async () => {
  const t = apiSetup();
  await dispatch(t.router, 'GET', '/users', { query: { q: 'bob@example.com' } });
  await dispatch(t.router, 'GET', '/users', { query: { q: 'bob' } });
  assert.equal(t.calls[0][2].filter, 'email');
  assert.equal(t.calls[1][2].filter, 'username');
});

test('routes: array/garbage query params are neutralised', async () => {
  const t = apiSetup();
  await dispatch(t.router, 'GET', '/servers', { query: { q: ['a', 'b'], page: ['2'] } });
  assert.equal(t.calls[0][2].q, '');
  assert.equal(t.calls[0][2].page, 1);
});

test('routes: suspend looks the server up, calls the panel, audits, invalidates stats cache', async () => {
  const t = apiSetup();
  const { res } = await dispatch(t.router, 'POST', '/servers/7/suspend');
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(t.calls.map((c) => c.slice(0, 2)), [['get', 'servers'], ['POST', '/servers/7/suspend']]);
  assert.deepEqual(t.audit.log[0], { actor: 'root', ip: '9.9.9.9', action: 'server.suspend', target: 'server:7 (n7)', ok: true });
  assert.equal(t.invalidated, 1);
});

test('routes: failed panel call is audited as a failure and the error propagates', async () => {
  const t = apiSetup({ request: async () => { throw new HttpError(400, 'boom'); } });
  const { error } = await dispatch(t.router, 'DELETE', '/servers/7');
  assert.equal(error.status, 400);
  assert.equal(t.audit.log[0].ok, false);
  assert.equal(t.audit.log[0].detail, 'boom');
  assert.equal(t.invalidated, 0);
});

test('routes: refuses to delete an administrator (enforced server-side)', async () => {
  const t = apiSetup({ get: async () => ({ username: 'boss', root_admin: true }) });
  const { error } = await dispatch(t.router, 'DELETE', '/users/1');
  assert.equal(error.status, 403);
  assert.equal(t.calls.some((c) => c[0] === 'DELETE'), false, 'DELETE never reached the panel');
});

test('routes: deletes a normal user; rejects bad ids before touching the panel; unknown route 404s', async () => {
  const t = apiSetup();
  assert.equal((await dispatch(t.router, 'DELETE', '/users/5')).res.body.ok, true);
  assert.deepEqual(t.calls.at(-1), ['DELETE', '/users/5']);
  const n = t.calls.length;
  assert.equal((await dispatch(t.router, 'DELETE', '/users/abc')).error.status, 400);
  assert.equal((await dispatch(t.router, 'DELETE', '/servers/0')).error.status, 400);
  assert.equal(t.calls.length, n);
  assert.equal((await dispatch(t.router, 'GET', '/nope')).error.status, 404);
});

test('routes: audit endpoint returns recent entries', async () => {
  const t = apiSetup();
  await dispatch(t.router, 'POST', '/servers/3/unsuspend');
  const { res } = await dispatch(t.router, 'GET', '/audit');
  assert.equal(res.body.data[0].action, 'server.unsuspend');
});
