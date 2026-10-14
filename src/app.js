'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');

const createSessionStore = require('./sessionStore');
const { createAuth, requireSameOrigin } = require('./auth');
const { createApiRouter } = require('./routes');
const { noStore } = require('./http');
const { HttpError } = require('./errors');

function createApp({ config, ptero, stats, audit, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  // Must be set BEFORE session/rate-limit so req.ip and cookie "secure: auto" see the real client.
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        // helmet enables this by default; over plain-HTTP dev it would break asset loading.
        ...(config.production ? {} : { 'upgrade-insecure-requests': null }),
      },
    },
  }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(express.json({ limit: '10kb' }));
  app.use(session({
    name: 'hap.sid',
    secret: config.sessionSecret,
    store: createSessionStore(session, { ttlMs: config.sessionIdleMs }),
    resave: false,
    saveUninitialized: false,
    rolling: true, // idle timeout: each request pushes expiry forward
    cookie: { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, maxAge: config.sessionIdleMs },
  }));

  const auth = createAuth({ config, audit });
  app.use('/api', noStore, requireSameOrigin(config), auth.router);
  app.use('/api', auth.requireAuth, createApiRouter({ ptero, stats, audit, config }));

  app.use(express.static(path.join(__dirname, '..', 'public'), {
    setHeaders: (res, file) => { if (file.endsWith('.html')) res.set('Cache-Control', 'no-cache'); },
  }));

  // Error handler: only HttpErrors (and body-parser 4xx) expose their message; everything else is logged and hidden.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Malformed JSON body.');
    else if (err.type === 'entity.too.large') err = new HttpError(413, 'Request body too large.');
    const status = err.expose && err.status ? err.status : 500;
    if (status >= 500 && !err.expose) logger.error(`[error] ${req.method} ${req.originalUrl}:`, err);
    if (res.headersSent) return;
    res.status(status).json({ error: err.expose ? err.message : 'Internal server error.' });
  });

  return { app, auth };
}

module.exports = { createApp };
