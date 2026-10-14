'use strict';
// Optional browser test (Playwright is not a project dependency):
//   NODE_PATH=$(npm root -g) node test/e2e.playwright.js      (starts the mock backend itself unless BASE is set)
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

if (!process.env.BASE) require('./mock-server');
const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const SHOTS = process.env.SHOTS || '';
let passed = 0;
const step = async (name, fn) => { try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message.split('\n').slice(0, 8).join('\n       ')}`); process.exitCode = 1; } };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const problems = [];
  // The two 401s are provoked on purpose (bad password, expired session) and Chrome logs every failed fetch.
  const expected = (t) => /status of 401/.test(t);
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !expected(m.text())) problems.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('dialog', async (d) => { problems.push(`UNEXPECTED native dialog: ${d.message()}`); await d.dismiss(); }); // an alert() from injected script would land here
  const shot = (n) => SHOTS && page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
  const rows = () => page.locator('tbody tr');
  const rowByName = (name) => rows().filter({ has: page.locator('td[data-label=Name]', { hasText: new RegExp(`^${name}$`) }) });
  // Click a tab and wait until it is current AND its rows have rendered (otherwise we could match the previous tab's rows).
  const openTab = async (k) => {
    await page.click(`a[data-k=${k}]`);
    await page.waitForFunction((key) => document.querySelector('a[aria-current=page]')?.dataset.k === key, k);
    await rows().first().waitFor();
  };
  const btn = (text) => page.getByRole('button', { name: text, exact: true });

  await page.goto(BASE);
  await step('login screen is shown when signed out', async () => {
    await page.locator('#login-form').waitFor();
    assert.equal(await page.locator('#app-view').isHidden(), true);
  });
  await shot('01-login');

  await step('wrong password shows an error and stays on the login screen', async () => {
    await page.fill('#username', 'admin'); await page.fill('#password', 'nope'); await page.click('#login-btn');
    await page.waitForFunction(() => document.querySelector('#login-error').textContent.length > 0);
    assert.match(await page.locator('#login-error').innerText(), /Wrong username or password/);
    assert.equal(await page.locator('#app-view').isHidden(), true);
  });

  await step('show-password toggle works', async () => {
    await page.check('#show-pass');
    assert.equal(await page.getAttribute('#password', 'type'), 'text');
    await page.uncheck('#show-pass');
    assert.equal(await page.getAttribute('#password', 'type'), 'password');
  });

  await step('correct login (Enter key) opens the dashboard', async () => {
    await page.fill('#password', 'demo-password-123'); await page.press('#password', 'Enter');
    await page.locator('#app-view').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#whoami').innerText(), 'admin');
    assert.equal(await page.locator('#password').inputValue(), '', 'password field is cleared');
  });

  await step('overview shows stat cards', async () => {
    await page.locator('.stat').first().waitFor();
    const text = await page.locator('.stats').innerText();
    assert.match(text, /Users\s*3/); assert.match(text, /Servers\s*60/); assert.match(text, /Nodes\s*2/);
  });
  await shot('02-overview');

  await step('servers tab: 25 rows, pager, hostile names render as inert text', async () => {
    await openTab('servers');
    assert.equal(await rows().count(), 25);
    assert.match(await page.locator('.pager .info').innerText(), /Page 1 of 3 · 60 total/);
    const html = await page.locator('tbody').innerHTML();
    assert.ok(!html.includes('<img'), 'no injected <img> element');
    assert.ok(!html.includes('<script'), 'no injected <script> element');
    assert.match(await rows().nth(0).innerText(), /alert\('pwn'\)/, 'name is visible as literal text');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('tbody img').count(), 0);
  });
  await shot('03-servers');

  await step('pagination: Next/Previous', async () => {
    await page.click('text=Next'); await page.waitForFunction(() => /Page 2 of 3/.test(document.querySelector('.pager .info')?.textContent || ''));
    assert.equal(await rows().count(), 25);
    await page.click('text=Next'); await page.waitForFunction(() => /Page 3 of 3/.test(document.querySelector('.pager .info')?.textContent || ''));
    assert.equal(await rows().count(), 10);
    assert.equal(await page.locator('button:text("Next")').isDisabled(), true);
    await page.click('text=Previous'); await page.waitForFunction(() => /Page 2 of 3/.test(document.querySelector('.pager .info')?.textContent || ''));
  });

  await step('search filters server-side and resets to page 1; empty state', async () => {
    await page.fill('input[type=search]', 'server-5');
    await page.waitForFunction(() => /Page 1 of 1/.test(document.querySelector('.pager .info')?.textContent || ''));
    assert.ok((await rows().count()) >= 1);
    for (const t of await rows().allInnerTexts()) assert.match(t, /server-5/);
    await page.fill('input[type=search]', 'zzzz-none');
    await page.locator('.empty').waitFor();
    assert.match(await page.locator('.empty').innerText(), /No results for “zzzz-none”/);
    await page.fill('input[type=search]', '');
    await page.waitForFunction(() => /60 total/.test(document.querySelector('.pager .info')?.textContent || ''));
  });

  await step('suspend: confirm dialog -> toast -> status tag flips -> button becomes Unsuspend', async () => {
    await btn('Suspend').first().waitFor();
    await rowByName('server-5').getByRole('button', { name: 'Suspend', exact: true }).click(); // server-5 is active in the fixture
    await page.locator('dialog[open]').waitFor();
    await shot('04-suspend-dialog');
    await page.locator('dialog').getByRole('button', { name: 'Suspend', exact: true }).click();
    await page.locator('.toast', { hasText: 'suspended' }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('tbody tr')].some((r) => r.querySelector('td[data-label=Name]').textContent === 'server-5' && r.querySelector('.tag').textContent === 'suspended'));
    assert.ok(await rowByName('server-5').getByRole('button', { name: 'Unsuspend', exact: true }).isVisible());
    assert.equal(await page.locator('dialog').count(), 0, 'dialog removed from DOM');
  });

  await step('cancel (Esc) does not perform the action', async () => {
    await rowByName('server-7').getByRole('button', { name: 'Suspend', exact: true }).click(); // server-7 is active
    await page.locator('dialog[open]').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog'));
    assert.match(await rowByName('server-7').innerText(), /active/i);
  });

  await step('delete requires typing the exact name; hostile name is handled safely', async () => {
    const hostile = `x');alert('pwn');//`;
    await rows().first().locator('button:text("Delete")').click();
    await page.locator('dialog[open]').waitFor();
    const confirm = page.locator('dialog button[type=submit]');
    assert.equal(await confirm.isDisabled(), true);
    await page.fill('dialog input', 'wrong name');
    assert.equal(await confirm.isDisabled(), true);
    await shot('05-delete-dialog');
    await page.fill('dialog input', hostile);
    assert.equal(await confirm.isDisabled(), false);
    await confirm.click();
    await page.locator('.toast', { hasText: 'Server deleted' }).waitFor();
    await page.waitForFunction(() => /59 total/.test(document.querySelector('.pager .info')?.textContent || ''));
  });

  await step('users tab: admin is protected, others deletable, hostile username is inert', async () => {
    await openTab('users');
    assert.match(await rows().filter({ hasText: 'boss' }).innerText(), /Protected/);
    assert.equal(await rows().filter({ hasText: 'boss' }).locator('button').count(), 0);
    await rows().filter({ hasText: 'alice@' }).locator('button:text("Delete")').click();
    await page.fill('dialog input', 'alice'); await page.click('dialog button[type=submit]');
    await page.locator('.toast', { hasText: 'User deleted' }).waitFor();
    assert.equal(await page.evaluate(() => window.__xss), undefined);
  });

  await step('nodes tab', async () => {
    await openTab('nodes');
    assert.equal(await rows().count(), 2);
    assert.match(await page.locator('tbody').innerText(), /64 GB/);
  });

  await step('audit tab lists the suspend action', async () => {
    await openTab('audit');
    assert.match(await page.locator('tbody').innerText(), /server\.suspend/);
  });

  await step('deep link survives reload (#/nodes) and tab is marked current', async () => {
    await page.goto(`${BASE}/#/nodes`); await page.reload();
    await rows().first().waitFor();
    assert.equal(await page.locator('a[aria-current=page]').innerText(), 'Nodes');
  });

  await step('expired session -> next request returns to login with a message', async () => {
    await page.evaluate(() => fetch('/api/__expire', { headers: { 'X-Requested-With': 'admin-panel' } }));
    await page.click('text=Refresh');
    await page.locator('#login-view').waitFor({ state: 'visible' });
    assert.match(await page.locator('#login-error').innerText(), /Not signed in/);
  });

  await step('sign in again and sign out', async () => {
    await page.fill('#username', 'admin'); await page.fill('#password', 'demo-password-123'); await page.click('#login-btn');
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.click('#logout');
    await page.locator('#login-view').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#app-view').isHidden(), true);
  });

  await step('mobile layout: rows become labelled cards, no horizontal page scroll', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.fill('#username', 'admin'); await page.fill('#password', 'demo-password-123'); await page.click('#login-btn');
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await openTab('servers');
    assert.equal(await page.locator('tbody td').first().evaluate((el) => getComputedStyle(el).display), 'flex');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `page scrolls horizontally by ${overflow}px`);
    await shot('06-mobile-servers');
  });

  await step('no console errors, CSP violations or page errors the whole run', async () => {
    assert.deepEqual(problems, []);
  });

  console.log(`\n${passed} steps passed${process.exitCode ? ' (with failures)' : ''}`);
  await browser.close();
  process.exit(process.exitCode || 0); // also stops the in-process mock server
})();
