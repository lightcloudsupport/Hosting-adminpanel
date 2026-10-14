# Hosting Admin Panel

A small, self-hosted admin dashboard for a [Pterodactyl](https://pterodactyl.io) panel (Node.js + Express).

- **Overview**: user / server / suspended / node counts
- **Servers**: search, paginate, suspend / unsuspend, delete (shows owner, node, limits, status)
- **Users**: search by username or email, paginate, delete (administrators are protected)
- **Nodes**: search, paginate
- **Audit log**: every login and every change, with time, IP and result (also written to `data/audit.log`)

The Pterodactyl API key and database password stay on the server and are never sent to the browser.

## Quick start

```bash
npm install
cp .env.example .env
npm run hash-password        # paste the printed ADMIN_PASS_HASH=... line into .env
openssl rand -hex 32         # paste into SESSION_SECRET=
# fill in PANEL_URL and PANEL_APP_API_KEY, then:
npm start                    # http://127.0.0.1:3000
```

The app refuses to start (with a list of everything that's wrong) if the configuration is missing,
malformed, or still contains example values.

**Panel API key:** Admin > Application API > Create New, with Read & Write on *Users* and *Servers* and Read on *Nodes*.

**Optional database (faster overview counts):** create a read-only user and set `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
```sql
CREATE USER 'panel_readonly'@'127.0.0.1' IDENTIFIED BY 'strong-pass';
GRANT SELECT ON panel.* TO 'panel_readonly'@'127.0.0.1';
```
Without it (or if it is unreachable) counts come from the API automatically.

> Upgrading from v1? `DB_KEY` still works but is deprecated: rename it to `DB_PASSWORD`.
> The server now listens on `127.0.0.1` by default; set `HOST=0.0.0.0` if you need otherwise.

## Putting it online (HTTPS required)

Run it behind a reverse proxy that terminates TLS, and set `TRUST_PROXY=1`. Nginx example:

```nginx
server {
  listen 443 ssl http2;
  server_name admin.example.com;
  # ssl_certificate ... ;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;                       # needed for the CSRF origin check
    proxy_set_header X-Forwarded-For $remote_addr;     # real client IP for rate limiting + audit
    proxy_set_header X-Forwarded-Proto $scheme;        # lets the session cookie be marked Secure
  }
}
```

## Security model

| Concern | What the app does |
|---|---|
| Admin password | scrypt hash (`ADMIN_PASS_HASH`); constant-time checks; username and password are always both verified |
| Brute force | 5 failures / 15 min per IP, then `429` + `Retry-After` (configurable); counters are pruned automatically |
| Sessions | HttpOnly, `SameSite=Strict`, `Secure` over HTTPS, new session ID on login, 2 h idle + 12 h absolute lifetime, expired entries evicted |
| CSRF | custom-header requirement + `Origin` check on every non-GET request, on top of SameSite |
| XSS | UI never uses `innerHTML`; strict CSP (`script-src 'self'`, no inline script/style); API returns whitelisted fields only |
| Authorisation | all `/api/*` except login/me/logout requires a session; admin accounts can't be deleted (enforced server-side, not just hidden in the UI) |
| Input | ids, page and search values validated; search text is URL-encoded so it can't inject extra panel parameters |
| Panel errors | a rejected panel API key is reported as a 502, never as a 401, so it can't look like "you were signed out" |
| Secrets | never logged or returned; unexpected errors are logged server-side and shown to the browser as a generic message |
| Destructive actions | confirmation dialog; deletes require typing the exact name; all changes written to the audit log |

Not included (by design, to keep it small): multi-user accounts, 2FA for this dashboard, and a persistent session
store. Sessions live in memory, so restarting the app signs you out. If you need those, put the dashboard behind your
SSO / VPN / an authenticating proxy as well.

## Layout

```
server.js            entry point: config -> wiring -> listen -> graceful shutdown
src/config.js        validates env, fails fast with a clear list of problems
src/app.js           Express app: helmet/CSP, sessions, routes, error handler
src/auth.js          login/logout/me, rate limit, CSRF/origin check, auth guard
src/routes.js        API routes (lists, suspend/unsuspend, delete) + audit
src/ptero.js         Pterodactyl API client (timeouts, error translation)
src/mappers.js       whitelists the fields sent to the browser
src/stats.js         overview counts (DB first, API fallback, short cache)
src/{password,rateLimiter,sessionStore,audit,db,errors,http}.js
public/              index.html, styles.css, app.js (no build step, no inline scripts)
scripts/hash-password.js
test/                unit + handler tests, mock backend, optional browser test
```

## Development & tests

```bash
npm test          # unit + handler tests (node:test, no extra dependencies)
npm run dev:mock  # UI with fake data at http://127.0.0.1:3100  (admin / demo-password-123)
NODE_PATH=$(npm root -g) node test/e2e.playwright.js   # optional browser test (needs Playwright)
```
