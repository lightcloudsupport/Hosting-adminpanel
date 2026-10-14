'use strict';
/* Hosting admin UI. All DOM is built with h() / textContent -- never innerHTML --
   so panel-supplied strings (server names, usernames...) cannot inject markup or script. */
(() => {
  const $ = (s) => document.querySelector(s);
  const state = { user: null };

  // ---------------------------------------------------------------- DOM helper
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  // ---------------------------------------------------------------- formatting
  const fmtMB = (n) => (!n ? 'Unlimited' : n >= 1024 ? `${+(n / 1024).toFixed(1)} GB` : `${n} MB`);
  const fmtDate = (s) => { const d = new Date(s); return Number.isNaN(+d) ? '–' : d.toLocaleString(); };
  const tagClass = (state) => (state === 'active' ? 'ok' : /failed|suspended/.test(state) ? 'bad' : 'warn');

  // ---------------------------------------------------------------- API
  class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

  async function api(method, url, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(url, {
        method, credentials: 'same-origin', signal: ctrl.signal,
        headers: { Accept: 'application/json', 'X-Requested-With': 'admin-panel', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(e.name === 'AbortError' ? 'The request timed out.' : 'Network error. Check your connection.', 0);
    } finally { clearTimeout(timer); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.endsWith('/login')) { showLogin(data.error || 'Signed out.'); throw new ApiError(data.error || 'Signed out.', 401); }
    if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
    return data;
  }

  // ---------------------------------------------------------------- toasts + confirm
  function toast(msg, kind = 'ok') {
    const el = h('div', { class: `toast ${kind === 'err' ? 'err' : ''}` }, msg);
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3000);
  }

  /** Modal confirmation. If requireText is set the user must type it (used for deletes). */
  function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false, requireText = null }) {
    return new Promise((resolve) => {
      const input = requireText ? h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': `Type ${requireText} to confirm` }) : null;
      const ok = h('button', { class: `btn ${danger ? 'danger-solid' : 'primary'}`, type: 'submit', value: 'ok', disabled: !!requireText }, confirmLabel);
      const dlg = h('dialog', { class: 'dialog', 'aria-label': title },
        h('form', { method: 'dialog', class: 'dialog-body' },
          h('h2', null, title),
          h('p', null, body),
          requireText && h('label', null, 'Type ', h('code', null, requireText), ' to confirm', input),
          h('div', { class: 'dialog-actions' },
            h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close('cancel') }, 'Cancel'), ok)));
      if (input) input.addEventListener('input', () => { ok.disabled = input.value.trim() !== requireText; });
      dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
      document.body.append(dlg);
      dlg.showModal();
      (input || ok).focus();
    });
  }

  /** Button that disables itself while its async action runs and reports errors as toasts. */
  function actionButton(label, cls, run) {
    const btn = h('button', { class: `btn sm ${cls}`, type: 'button' }, label);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await run(); } catch (e) { if (e.status !== 401) toast(e.message, 'err'); } finally { btn.disabled = false; }
    });
    return btn;
  }

  // ---------------------------------------------------------------- reusable pieces
  const errorBox = (msg, retry) => h('div', { class: 'errorbox', role: 'alert' }, h('div', null, msg), h('button', { class: 'btn sm', type: 'button', onclick: retry }, 'Try again'));
  const skeleton = () => h('div', { class: 'skeleton', 'aria-label': 'Loading' });

  function table(title, columns, rows, ctx) {
    return h('div', { class: 'table-wrap' }, h('table', null,
      h('caption', { class: 'sr-only' }, title),
      h('thead', null, h('tr', null, columns.map((c) => h('th', { scope: 'col' }, c.label)))),
      h('tbody', null, rows.map((row) => h('tr', null, columns.map((c) => h('td', { 'data-label': c.label, class: c.wrap ? 'wrap' : '' }, c.cell(row, ctx))))))));
  }

  /** A searchable, paginated list backed by GET <endpoint>?page=&q= */
  function listView({ title, endpoint, search, columns, emptyText }) {
    const st = { page: 1, q: '' };
    let seq = 0;
    const body = h('div');
    const root = h('section', null);
    let timer;

    const input = search && h('input', { type: 'search', placeholder: search, 'aria-label': search, maxlength: 100 });
    if (input) input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { st.q = input.value.trim(); st.page = 1; load(); }, 300); });
    root.append(h('div', { class: 'toolbar' }, h('h2', null, title), input, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => load() }, 'Refresh')), body);

    async function load() {
      const mine = ++seq;
      body.replaceChildren(skeleton());
      try {
        const qs = new URLSearchParams({ page: st.page });
        if (st.q) qs.set('q', st.q);
        const d = await api('GET', `${endpoint}?${qs}`);
        if (mine !== seq || !root.isConnected) return; // a newer request or navigation superseded this one
        const { page, totalPages, total } = d.pagination;
        if (!d.data.length && page > totalPages) { st.page = totalPages; return load(); } // deleted the last row of the last page
        if (!d.data.length) { body.replaceChildren(h('div', { class: 'empty' }, st.q ? `No results for “${st.q}”.` : emptyText)); return; }
        body.replaceChildren(
          table(title, columns, d.data, { reload: load }),
          h('div', { class: 'pager' },
            h('span', { class: 'info muted' }, `Page ${page} of ${totalPages} · ${total} total`),
            h('button', { class: 'btn sm ghost', type: 'button', disabled: page <= 1, onclick: () => { st.page = page - 1; load(); } }, 'Previous'),
            h('button', { class: 'btn sm ghost', type: 'button', disabled: page >= totalPages, onclick: () => { st.page = page + 1; load(); } }, 'Next')));
      } catch (e) {
        if (mine === seq && e.status !== 401) body.replaceChildren(errorBox(e.message, load));
      }
    }
    return { el: root, load };
  }

  // ---------------------------------------------------------------- views
  function overviewView() {
    const body = h('div');
    const root = h('section', null, h('div', { class: 'toolbar' }, h('h2', null, 'Overview'), h('button', { class: 'btn ghost sm', type: 'button', onclick: () => load() }, 'Refresh')), body);
    async function load() {
      body.replaceChildren(skeleton());
      try {
        const s = await api('GET', '/api/stats');
        if (!root.isConnected) return;
        const cards = [['Users', s.users], ['Servers', s.servers], ['Suspended', s.suspended], ['Nodes', s.nodes]];
        body.replaceChildren(
          h('div', { class: 'stats' }, cards.map(([l, n]) => h('div', { class: 'stat' }, h('span', null, l), h('strong', null, n ?? '–')))),
          s.degraded && h('p', { class: 'notice warn' }, 'The panel database query failed, so these numbers came from the API instead. Check the server log.'),
          h('p', { class: 'muted' }, `Counts read from the ${s.source === 'database' ? 'panel database' : 'panel API'}.`));
      } catch (e) { if (e.status !== 401) body.replaceChildren(errorBox(e.message, load)); }
    }
    return { el: root, load };
  }

  async function serverAction(s, kind, reload) {
    if (kind === 'suspend' && !(await confirmDialog({ title: 'Suspend server?', body: `“${s.name}” will be stopped and locked until you unsuspend it.`, confirmLabel: 'Suspend' }))) return;
    await api('POST', `/api/servers/${s.id}/${kind}`);
    toast(kind === 'suspend' ? 'Server suspended.' : 'Server unsuspended.');
    reload();
  }
  async function deleteThing(kind, item, label, reload) {
    const ok = await confirmDialog({ title: `Delete ${kind}?`, body: `This permanently deletes ${kind} “${label}” and cannot be undone.`, confirmLabel: `Delete ${kind}`, danger: true, requireText: label });
    if (!ok) return;
    await api('DELETE', `/api/${kind}s/${item.id}`);
    toast(`${kind[0].toUpperCase() + kind.slice(1)} deleted.`);
    reload();
  }

  const serversView = () => listView({
    title: 'Servers', endpoint: '/api/servers', search: 'Search by name…', emptyText: 'No servers yet.',
    columns: [
      { label: 'ID', cell: (s) => s.id },
      { label: 'Name', wrap: true, cell: (s) => s.name },
      { label: 'Status', cell: (s) => h('span', { class: `tag ${tagClass(s.state)}` }, s.state.replace(/_/g, ' ')) },
      { label: 'Owner', wrap: true, cell: (s) => (s.owner ? s.owner.username : '–') },
      { label: 'Node', cell: (s) => (s.node ? s.node.name : '–') },
      { label: 'RAM', cell: (s) => fmtMB(s.limits.memory) },
      { label: 'Disk', cell: (s) => fmtMB(s.limits.disk) },
      { label: 'Actions', cell: (s, { reload }) => h('div', { class: 'row' },
        actionButton(s.suspended ? 'Unsuspend' : 'Suspend', 'ghost', () => serverAction(s, s.suspended ? 'unsuspend' : 'suspend', reload)),
        actionButton('Delete', 'danger', () => deleteThing('server', s, s.name, reload))) },
    ],
  });

  const usersView = () => listView({
    title: 'Users', endpoint: '/api/users', search: 'Search by username or email…', emptyText: 'No users yet.',
    columns: [
      { label: 'ID', cell: (u) => u.id },
      { label: 'Username', wrap: true, cell: (u) => u.username },
      { label: 'Email', wrap: true, cell: (u) => u.email },
      { label: 'Admin', cell: (u) => (u.rootAdmin ? 'Yes' : 'No') },
      { label: '2FA', cell: (u) => (u.twoFactor ? 'On' : 'Off') },
      { label: 'Actions', cell: (u, { reload }) => (u.rootAdmin ? h('span', { class: 'muted' }, 'Protected') : actionButton('Delete', 'danger', () => deleteThing('user', u, u.username, reload))) },
    ],
  });

  const nodesView = () => listView({
    title: 'Nodes', endpoint: '/api/nodes', search: 'Search by name…', emptyText: 'No nodes yet.',
    columns: [
      { label: 'ID', cell: (n) => n.id },
      { label: 'Name', wrap: true, cell: (n) => n.name },
      { label: 'FQDN', wrap: true, cell: (n) => n.fqdn },
      { label: 'Memory', cell: (n) => fmtMB(n.memory) },
      { label: 'Disk', cell: (n) => fmtMB(n.disk) },
      { label: 'Maintenance', cell: (n) => h('span', { class: `tag ${n.maintenance ? 'warn' : 'ok'}` }, n.maintenance ? 'on' : 'off') },
    ],
  });

  function auditView() {
    const body = h('div');
    const root = h('section', null, h('div', { class: 'toolbar' }, h('h2', null, 'Audit log'), h('button', { class: 'btn ghost sm', type: 'button', onclick: () => load() }, 'Refresh')), body);
    async function load() {
      body.replaceChildren(skeleton());
      try {
        const d = await api('GET', '/api/audit');
        if (!root.isConnected) return;
        body.replaceChildren(d.data.length ? table('Audit log', [
          { label: 'When', cell: (e) => fmtDate(e.ts) },
          { label: 'Action', cell: (e) => e.action },
          { label: 'Target', wrap: true, cell: (e) => e.target || '–' },
          { label: 'Result', cell: (e) => h('span', { class: `tag ${e.ok ? 'ok' : 'bad'}` }, e.ok ? 'ok' : 'failed') },
          { label: 'IP', cell: (e) => e.ip || '–' },
          { label: 'Detail', wrap: true, cell: (e) => e.detail || '' },
        ], d.data) : h('div', { class: 'empty' }, 'Nothing recorded yet.'));
      } catch (e) { if (e.status !== 401) body.replaceChildren(errorBox(e.message, load)); }
    }
    return { el: root, load };
  }

  // ---------------------------------------------------------------- routing
  const routes = { overview: ['Overview', overviewView], servers: ['Servers', serversView], users: ['Users', usersView], nodes: ['Nodes', nodesView], audit: ['Audit log', auditView] };
  $('#tabs').append(...Object.entries(routes).map(([k, [label]]) => h('a', { href: `#/${k}`, 'data-k': k }, label)));

  function route() {
    if (!state.user) return;
    const hash = location.hash.replace(/^#\/?/, '');
    const key = routes[hash] ? hash : 'overview';
    document.querySelectorAll('#tabs a').forEach((a) => (a.dataset.k === key ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    const view = routes[key][1]();
    $('#view').replaceChildren(view.el);
    document.title = `${routes[key][0]} · Hosting Admin`;
    view.load();
  }
  window.addEventListener('hashchange', route);

  // ---------------------------------------------------------------- auth screens
  function showLogin(message) {
    state.user = null;
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    $('#login-error').textContent = message || '';
    document.title = 'Sign in · Hosting Admin';
    $('#password').value = '';
    (message ? $('#password') : $('#username')).focus();
  }
  function showApp(user) {
    state.user = user;
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#whoami').textContent = user || '';
    route();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn');
    btn.disabled = true;
    $('#login-error').textContent = '';
    try {
      const d = await api('POST', '/api/login', { username: $('#username').value, password: $('#password').value });
      $('#password').value = '';
      showApp(d.user);
    } catch (err) {
      $('#login-error').textContent = err.message;
      $('#password').select();
    } finally { btn.disabled = false; }
  });
  $('#show-pass').addEventListener('change', (e) => { $('#password').type = e.target.checked ? 'text' : 'password'; });
  $('#logout').addEventListener('click', async () => {
    try { await api('POST', '/api/logout'); } catch { /* already signed out */ }
    location.hash = '';
    showLogin();
  });

  api('GET', '/api/me')
    .then((d) => (d.admin ? showApp(d.user) : showLogin()))
    .catch((e) => showLogin(e.status === 401 ? '' : e.message));
})();
