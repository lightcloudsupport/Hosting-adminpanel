'use strict';

// Whitelist exactly what the browser needs; never pass raw panel objects through.

const mapUser = (u) => ({
  id: u.id,
  uuid: u.uuid,
  username: u.username,
  email: u.email,
  firstName: u.first_name,
  lastName: u.last_name,
  rootAdmin: !!u.root_admin,
  twoFactor: !!u['2fa'],
  createdAt: u.created_at,
});

const mapServer = (s) => {
  const rel = s.relationships || {};
  const owner = rel.user && rel.user.attributes;
  const node = rel.node && rel.node.attributes;
  const limits = s.limits || {};
  return {
    id: s.id,
    uuid: s.uuid,
    identifier: s.identifier,
    name: s.name,
    // panel statuses: null | installing | install_failed | reinstall_failed | suspended | restoring_backup
    state: s.suspended ? 'suspended' : (s.status || 'active'),
    suspended: !!s.suspended,
    limits: { memory: limits.memory ?? 0, disk: limits.disk ?? 0, cpu: limits.cpu ?? 0 },
    owner: owner ? { id: owner.id, username: owner.username } : null,
    node: node ? { id: node.id, name: node.name } : null,
    createdAt: s.created_at,
  };
};

const mapNode = (n) => ({
  id: n.id,
  name: n.name,
  fqdn: n.fqdn,
  scheme: n.scheme,
  memory: n.memory,
  memoryOverallocate: n.memory_overallocate,
  disk: n.disk,
  diskOverallocate: n.disk_overallocate,
  maintenance: !!n.maintenance_mode,
  behindProxy: !!n.behind_proxy,
  createdAt: n.created_at,
});

module.exports = { mapUser, mapServer, mapNode };
