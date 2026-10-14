'use strict';
const express = require('express');
const { asyncHandler } = require('./http');
const { HttpError } = require('./errors');
const { verifyPassword, safeEqual, MAX_LEN } = require('./password');
const { FailureLimiter } = require('./rateLimiter');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for the JSON API (in addition to SameSite=Strict cookies):
 *  - state-changing requests must carry a custom header, which a cross-site
 *    <form> cannot send and a cross-origin fetch can't send without a CORS
 *    preflight (which we never approve);
 *  - if the browser sends an Origin header it must match this site.
 */
function requireSameOrigin(config) {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (req.get('x-requested-with') !== 'admin-panel') {
      return next(new HttpError(403, 'Blocked: missing CSRF header.'));
    }
    const origin = req.get('origin');
    if (origin) {
      let expectedHost;
      try { expectedHost = config.allowedOrigin ? new URL(config.allowedOrigin).host : req.get('host'); } catch { /* fallthrough */ }
      let originHost;
      try { originHost = new URL(origin).host; } catch { /* invalid */ }
      if (!originHost || originHost !== expectedHost) return next(new HttpError(403, 'Blocked: cross-origin request.'));
    }
    return next();
  };
}

function createAuth({ config, audit }) {
  const limiter = new FailureLimiter({ max: config.loginMaxAttempts, windowMs: config.loginWindowMs });
  const router = express.Router();
  const actor = config.adminUser;

  const regenerate = (req) => new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
  const destroy = (req) => new Promise((resolve) => req.session.destroy(() => resolve()));

  router.post('/login', asyncHandler(async (req, res) => {
    const ip = req.ip;
    const wait = limiter.retryAfterMs(ip);
    if (wait) {
      res.set('Retry-After', String(Math.ceil(wait / 1000)));
      audit.record({ actor: null, ip, action: 'login', ok: false, detail: 'rate limited' });
      throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60000)} minute(s).`);
    }

    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > MAX_LEN || password.length > MAX_LEN) {
      throw new HttpError(400, 'Username and password are required.');
    }

    // Always run BOTH checks (no short-circuit) so timing doesn't reveal which was wrong.
    const userOk = safeEqual(username, config.adminUser);
    const passOk = await verifyPassword(config.adminPassHash, password);
    if (!(userOk && passOk)) {
      limiter.fail(ip);
      audit.record({ actor: null, ip, action: 'login', target: username.slice(0, 64), ok: false, detail: 'bad credentials' });
      throw new HttpError(401, 'Wrong username or password.');
    }

    limiter.reset(ip);
    await regenerate(req); // new session id on privilege change (prevents session fixation)
    req.session.admin = true;
    req.session.createdAt = Date.now();
    audit.record({ actor, ip, action: 'login', ok: true });
    res.json({ ok: true, user: actor });
  }));

  router.post('/logout', asyncHandler(async (req, res) => {
    if (req.session && req.session.admin) audit.record({ actor, ip: req.ip, action: 'logout', ok: true });
    await destroy(req);
    res.clearCookie('hap.sid');
    res.json({ ok: true });
  }));

  router.get('/me', (req, res) => {
    const admin = !!(req.session && req.session.admin);
    res.json({ admin, user: admin ? actor : null });
  });

  /** Guards every other /api route. Enforces an absolute session lifetime too. */
  function requireAuth(req, res, next) {
    const s = req.session;
    if (!s || !s.admin) return next(new HttpError(401, 'Not signed in.'));
    if (Date.now() - (s.createdAt || 0) > config.sessionMaxMs) {
      return s.destroy(() => next(new HttpError(401, 'Session expired. Please sign in again.')));
    }
    return next();
  }

  return { router, requireAuth, limiter };
}

module.exports = { createAuth, requireSameOrigin };
