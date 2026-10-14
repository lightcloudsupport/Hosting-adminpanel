'use strict';
const express = require('express');
const { asyncHandler: h } = require('./http');
const { HttpError } = require('./errors');
const { mapUser, mapServer, mapNode } = require('./mappers');

const parsePage = (v) => {
  if (typeof v !== 'string' || !/^\d{1,6}$/.test(v)) return 1; // rejects arrays (?page=1&page=2), floats, junk
  const n = Number(v);
  return n >= 1 && n <= 100_000 ? n : 1;
};
const parseQuery = (v) => (typeof v === 'string' ? v.trim().slice(0, 100) : '');
const parseId = (v) => {
  if (!/^\d{1,10}$/.test(String(v)) || Number(v) < 1) throw new HttpError(400, 'Invalid id.');
  return Number(v);
};

function createApiRouter({ ptero, stats, audit, config }) {
  const r = express.Router();

  const listRoute = (resource, mapper, { include, filterFor } = {}) =>
    h(async (req, res) => {
      const q = parseQuery(req.query.q);
      const { items, pagination } = await ptero.list(resource, {
        page: parsePage(req.query.page), perPage: 25, q, include, filter: filterFor ? filterFor(q) : 'name',
      });
      res.json({ data: items.map(mapper), pagination });
    });

  r.get('/stats', h(async (req, res) => res.json(await stats.get())));
  r.get('/servers', listRoute('servers', mapServer, { include: 'user,node' }));
  r.get('/users', listRoute('users', mapUser, { filterFor: (q) => (q.includes('@') ? 'email' : 'username') }));
  r.get('/nodes', listRoute('nodes', mapNode));
  r.get('/audit', (req, res) => res.json({ data: audit.recent(100) }));

  /** Run a mutating panel call and audit it whether it succeeds or fails. */
  async function mutate(req, action, target, op) {
    try {
      const result = await op();
      audit.record({ actor: config.adminUser, ip: req.ip, action, target, ok: true });
      stats.invalidate();
      return result;
    } catch (e) {
      audit.record({ actor: config.adminUser, ip: req.ip, action, target, ok: false, detail: e.message });
      throw e;
    }
  }

  for (const kind of ['suspend', 'unsuspend']) {
    r.post(`/servers/:id/${kind}`, h(async (req, res) => {
      const id = parseId(req.params.id);
      const server = await ptero.get('servers', id);
      await mutate(req, `server.${kind}`, `server:${id} (${server.name})`, () => ptero.request('POST', `/servers/${id}/${kind}`));
      res.json({ ok: true });
    }));
  }

  r.delete('/servers/:id', h(async (req, res) => {
    const id = parseId(req.params.id);
    const server = await ptero.get('servers', id);
    await mutate(req, 'server.delete', `server:${id} (${server.name})`, () => ptero.request('DELETE', `/servers/${id}`));
    res.json({ ok: true });
  }));

  r.delete('/users/:id', h(async (req, res) => {
    const id = parseId(req.params.id);
    const user = await ptero.get('users', id);
    // Enforced here, not just hidden in the UI.
    if (user.root_admin) throw new HttpError(403, 'Refusing to delete an administrator account.');
    await mutate(req, 'user.delete', `user:${id} (${user.username})`, () => ptero.request('DELETE', `/users/${id}`));
    res.json({ ok: true });
  }));

  r.use((req, res, next) => next(new HttpError(404, 'Not found.')));
  return r;
}

module.exports = { createApiRouter, parsePage, parseQuery, parseId };
