'use strict';

const PLACEHOLDERS = new Set([
  'change-this-strong-password',
  'put-a-long-random-string-here',
  'your_database_password',
]);

class ConfigError extends Error {}

function parseTrustProxy(v) {
  if (!v || v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v); // number of proxy hops
  return v; // e.g. "loopback" or a CIDR list (see Express "trust proxy")
}

/**
 * Validate and normalise environment variables. Pure function (takes `env`)
 * so it can be unit-tested. Throws ConfigError listing *all* problems at once.
 */
function loadConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  const get = (k) => (env[k] ?? '').trim();
  const need = (k) => {
    const v = get(k);
    if (!v) errors.push(`${k} is required.`);
    return v;
  };
  const int = (k, def, min, max) => {
    const raw = get(k);
    if (!raw) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${k} must be an integer between ${min} and ${max}.`);
      return def;
    }
    return n;
  };

  // --- Pterodactyl panel
  let panelUrl = need('PANEL_URL');
  if (panelUrl) {
    try {
      const u = new URL(panelUrl);
      if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
      panelUrl = (u.origin + u.pathname).replace(/\/+$/, '');
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (u.protocol === 'http:' && !local) {
        warnings.push('PANEL_URL uses plain http: the API key travels unencrypted.');
      }
    } catch {
      errors.push('PANEL_URL must be a valid http(s) URL, e.g. https://panel.example.com');
    }
  }
  const apiKey = need('PANEL_APP_API_KEY');
  if (apiKey && /^ptla_x+$/i.test(apiKey)) errors.push('PANEL_APP_API_KEY is still the example value.');
  else if (apiKey && !apiKey.startsWith('ptla_')) {
    warnings.push('PANEL_APP_API_KEY does not start with "ptla_" (Application API keys do).');
  }

  // --- Admin login
  const adminUser = need('ADMIN_USER');
  const adminPassHash = get('ADMIN_PASS_HASH');
  const adminPassPlain = get('ADMIN_PASS');
  if (adminPassHash) {
    if (!/^scrypt:[\w-]+:[\w-]+$/.test(adminPassHash)) {
      errors.push('ADMIN_PASS_HASH is malformed. Generate one with: npm run hash-password');
    }
  } else if (adminPassPlain) {
    if (PLACEHOLDERS.has(adminPassPlain)) errors.push('ADMIN_PASS is still the example value.');
    else if (adminPassPlain.length < 12) errors.push('ADMIN_PASS must be at least 12 characters.');
    warnings.push('ADMIN_PASS is stored in plain text. Prefer ADMIN_PASS_HASH (npm run hash-password).');
  } else {
    errors.push('Set ADMIN_PASS_HASH (recommended) or ADMIN_PASS.');
  }

  // --- Sessions
  const sessionSecret = need('SESSION_SECRET');
  if (sessionSecret && (PLACEHOLDERS.has(sessionSecret) || sessionSecret.length < 32)) {
    errors.push('SESSION_SECRET must be a random string of at least 32 characters (e.g. `openssl rand -hex 32`).');
  }

  // --- Database (optional)
  let db = null;
  const dbHost = get('DB_HOST');
  if (dbHost) {
    const password = get('DB_PASSWORD') || get('DB_KEY'); // DB_KEY = legacy name
    if (!get('DB_PASSWORD') && get('DB_KEY')) warnings.push('DB_KEY is deprecated; rename it to DB_PASSWORD.');
    if (!password) errors.push('DB_PASSWORD is required when DB_HOST is set.');
    if (PLACEHOLDERS.has(password)) errors.push('DB_PASSWORD is still the example value.');
    db = {
      host: dbHost,
      port: int('DB_PORT', 3306, 1, 65535),
      user: need('DB_USER'),
      password,
      database: need('DB_NAME'),
      ssl: get('DB_SSL').toLowerCase() === 'true',
    };
  }

  // --- HTTP server
  const production = get('NODE_ENV') === 'production';
  const trustProxy = parseTrustProxy(get('TRUST_PROXY'));
  const cs = get('COOKIE_SECURE').toLowerCase();
  const cookieSecure = cs === 'true' ? true : cs === 'false' ? false : 'auto';
  if (production && cookieSecure !== true && !trustProxy) {
    warnings.push('Running in production without TRUST_PROXY or COOKIE_SECURE=true: the session cookie may lack the Secure flag.');
  }
  let allowedOrigin = get('ALLOWED_ORIGIN');
  if (allowedOrigin) {
    try { allowedOrigin = new URL(allowedOrigin).origin; }
    catch { errors.push('ALLOWED_ORIGIN must be a valid URL like https://admin.example.com'); }
  }

  const config = {
    panelUrl, apiKey, adminUser, adminPassHash: adminPassHash || null, adminPassPlain: adminPassPlain || null,
    sessionSecret, db, production, trustProxy, cookieSecure, allowedOrigin: allowedOrigin || null,
    host: get('HOST') || '127.0.0.1',
    port: int('PORT', 3000, 1, 65535),
    sessionIdleMs: int('SESSION_IDLE_MINUTES', 120, 1, 1440) * 60_000,
    sessionMaxMs: int('SESSION_MAX_HOURS', 12, 1, 168) * 3_600_000,
    loginMaxAttempts: int('LOGIN_MAX_ATTEMPTS', 5, 1, 100),
    loginWindowMs: int('LOGIN_WINDOW_MINUTES', 15, 1, 1440) * 60_000,
    auditLog: get('AUDIT_LOG') || './data/audit.log',
    warnings,
  };

  if (errors.length) {
    throw new ConfigError(`Invalid configuration:\n - ${errors.join('\n - ')}`);
  }
  return config;
}

module.exports = { loadConfig, ConfigError };
