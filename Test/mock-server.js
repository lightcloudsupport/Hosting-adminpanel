'use strict';
// Dependency-free stand-in for the real backend, for UI development and browser tests:
//   node test/mock-server.js        ->  http://127.0.0.1:3100   (login: admin / demo-password-123)
// Serves ./public with the SAME Content-Security-Policy as the real app, plus fake data
// that deliberately contains hostile strings to prove the UI renders them as inert text.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3100;
const PUBLIC = path.join(__dirname, '..', 'public');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const HOSTILE = [`x');alert('pwn');//`, '<img src=x onerror="window.__xss=1">', '"><script>window.__xss=1</script>'];
let servers = Array.from({ length: 60 }, (_, i) => ({
  id: i + 1, uuid: `u${i}`, identifier: `id${i}`,
  name: i < 3 ? HOSTILE[i] : `server-${i + 1}`,
  state: i % 11 === 5 ? 'suspended' : i % 17 === 3 ? 'installing' : 'active',
  limits: { memory: i % 7 === 0 ? 0 : 512 * ((i % 4) + 1), disk: 5120, cpu: 100 },
  owner: { id: 1, username: i === 4 ? HOSTILE[1] : 'alice' }, node: { id: 1, name: 'node-eu' }, createdAt: '2026-01-01T00:00:00Z',
})).map((s) => ({ ...s, suspended: s.state === 'suspended' }));
let users = [
  { id: 1, username: 'boss', email: 'boss@example.com', rootAdmin: true, twoFactor: true },
  { id: 2, username: HOSTILE[0], email: 'evil@example.com', rootAdmin: false, twoFactor: false },
  { id: 3, username: 'alice', email: 'alice@example.com', rootAdmin: false, twoFactor: true },
];
const nodes = [{ id: 1, name: 'node-eu', fqdn: 'eu.example.com', memory: 65536, disk: 1048576, maintenance: false }, { id: 2, name: 'node-us', fqdn: 'us.example.com', memory: 32768, disk: 512000, maintenance: true }];
const audit = [];
const sessions = new Set();

const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, ...headers }); res.end(JSON.stringify(body)); };
const page = (list, url, filterKeys) => {
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const filtered = q ? list.filter((x) => filterKeys.some((k) => String(x[k]).toLowerCase().includes(q))) : list;
  const page = Number(url.searchParams.get('page')) || 1;
  const totalPages = Math.max(1, Math.ceil(filtered.length / 25));
  return { data: filtered.slice((page - 1) * 25, page * 25), pagination: { total: filtered.length, page, perPage: 25, totalPages } };
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': CSP });
    return res.end(fs.readFileSync(file));
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'admin-panel') return send(res, 403, { error: 'Blocked: missing CSRF header.' });
    const sid = /sid=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
    const authed = sessions.has(sid);
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
    const p = url.pathname;

    if (p === '/api/login' && req.method === 'POST') {
      if (body.username === 'admin' && body.password === 'demo-password-123') {
        const id = crypto.randomUUID(); sessions.add(id);
        return send(res, 200, { ok: true, user: 'admin' }, { 'Set-Cookie': `sid=${id}; HttpOnly; SameSite=Strict; Path=/` });
      }
      return send(res, 401, { error: 'Wrong username or password.' });
    }
    if (p === '/api/me') return send(res, 200, { admin: authed, user: authed ? 'admin' : null });
    if (p === '/api/logout') { sessions.delete(sid); return send(res, 200, { ok: true }); }
    if (!authed) return send(res, 401, { error: 'Not signed in.' });

    if (p === '/api/__expire') { sessions.clear(); return send(res, 200, { ok: true }); } // test hook
    if (p === '/api/stats') return send(res, 200, { users: users.length, servers: servers.length, suspended: servers.filter((s) => s.suspended).length, nodes: nodes.length, source: 'database' });
    if (p === '/api/servers' && req.method === 'GET') return send(res, 200, page(servers, url, ['name']));
    if (p === '/api/users' && req.method === 'GET') return send(res, 200, page(users, url, ['username', 'email']));
    if (p === '/api/nodes') return send(res, 200, page(nodes, url, ['name']));
    if (p === '/api/audit') return send(res, 200, { data: audit.slice().reverse() });

    let m;
    if ((m = /^\/api\/servers\/(\d+)\/(suspend|unsuspend)$/.exec(p)) && req.method === 'POST') {
      const s = servers.find((x) => x.id === +m[1]); if (!s) return send(res, 404, { error: 'Not found on the panel.' });
      s.suspended = m[2] === 'suspend'; s.state = s.suspended ? 'suspended' : 'active';
      audit.push({ ts: new Date().toISOString(), actor: 'admin', ip: '127.0.0.1', action: `server.${m[2]}`, target: `server:${s.id}`, ok: true });
      return send(res, 200, { ok: true });
    }
    if ((m = /^\/api\/servers\/(\d+)$/.exec(p)) && req.method === 'DELETE') { servers = servers.filter((x) => x.id !== +m[1]); return send(res, 200, { ok: true }); }
    if ((m = /^\/api\/users\/(\d+)$/.exec(p)) && req.method === 'DELETE') {
      const u = users.find((x) => x.id === +m[1]);
      if (u?.rootAdmin) return send(res, 403, { error: 'Refusing to delete an administrator account.' });
      users = users.filter((x) => x.id !== +m[1]); return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Not found.' });
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Mock admin panel on http://127.0.0.1:${PORT}  (admin / demo-password-123)`));
