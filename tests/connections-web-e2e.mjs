// Settings › Connections in the web app (and so the Windows app, which loads it), in a real browser against
// the real server: rows worded by the server with a status, an older Google connection that needs
// reconnecting asks before moving its Bots, Turn off / Turn on of a server-file connection with Undo in
// Recent changes, and a per-tool choice. Throwaway database, apps.json and the fake MCP server; no Hermes.
// SHOTS=<dir> saves screenshots. Run after `npm run build` (web and server):   node tests/connections-web-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connections-web-'));
const PORT = 19100 + Math.floor(Math.random() * 300);
const HERMES_PORT = PORT + 700;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
const SHOTS = process.env.SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url !== '/v1/responses') { res.statusCode = 404; return res.end('{}'); }
    const b = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    if (/slow/.test(b.input)) { send('response.output_text.delta', { delta: 'Still checking the flights' }); return; }
    const text = /grocer/i.test(b.input) ? 'Here is this week\'s grocery list: eggs, rice, apples.' : `Got it: ${b.input.split('\n').pop().slice(0, 40)}`;
    send('response.output_text.delta', { delta: text });
    send('response.output_item.done', { item: { type: 'message', content: [{ text }] } });
    send('response.completed', { response: {} });
    res.end();
  });
}).listen(HERMES_PORT, '127.0.0.1');

const demo = path.join(root, 'tests/fixtures/demo-mcp-server.mjs');
fs.writeFileSync(path.join(dir, 'apps.json'), JSON.stringify({ apps: [
  { id: 'actual', name: 'Actual budget', description: 'The household budget in Actual. Reads and changes it.', command: process.execPath, args: [demo], bots: ['Leonard'], ask: ['send_*'] },
  { id: 'google', name: 'Google (Alex)', description: 'Gmail, Calendar and Drive.', command: process.execPath, args: [demo], bots: ['Leonard'] },
  { id: 'files', name: 'Case files', command: process.execPath, args: [demo], enabled: false, bots: ['Howard'] },
] }, null, 2));
fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ connectors: [] }));
const hermesHome = path.join(dir, 'hermes');
fs.mkdirSync(hermesHome, { recursive: true });
fs.writeFileSync(path.join(hermesHome, '.env'), 'API_SERVER_KEY=test-key\n');
const server = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
  cwd: path.join(root, 'server'),
  env: {
    PATH: process.env.PATH, HOME: dir,
    PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET,
    ORGO_API_KEY: 'unused', DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'),
    HERMES_BIN: '/bin/false', HERMES_URL: `http://127.0.0.1:${HERMES_PORT}`, HERMES_HOME_PRIMARY: hermesHome,
    APPS_CONFIG: path.join(dir, 'apps.json'), BOTHQ_NO_SCHEDULER: '1', CLEFTBOT_NO_SCHEDULER: '1', OWNER_EMAIL: 'owner@example.com',
    CONNECTORS_CATALOG: path.join(dir, 'catalog.json'), GOOGLE_ACCOUNTS_DIR: path.join(dir, 'google'), PLUGINS_DIR: path.join(dir, 'plugins'), CLEFT_MAINTAINER_LOG: path.join(dir, 'maint.log'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`); }
};
const { chromium } = createRequire(import.meta.url)('playwright');
let browser;

try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const r = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com' }) });
  const cookies = r.headers.getSetCookie().map((c) => c.split(';')[0]);
  browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const api = async (method, p, b) => {
    const res = await fetch(`${BASE}/api${p}`, { method, headers: { cookie: cookies.join('; '), 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(j)}`);
    return j;
  };
  await api('POST', '/bots', { name: 'Leonard', avatarShape: 'cloud', avatarColor: 'green' });
  await api('POST', '/bots', { name: 'Robin', avatarShape: 'heart', avatarColor: 'gray' });
  for (let i = 0; i < 50; i++) { const l = await api('GET', '/connections'); if (l.connections.filter((c) => c.state !== 'not_working').length >= 2) break; await sleep(200); }

  /** A person's browser session (a one-time sign-in link), since a script's session may not change connections. */
  const personContext = async (o) => {
    const ctx = await browser.newContext(o);
    const linked = await (await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', link: true }) })).json();
    const p = await ctx.newPage();
    await p.goto(linked.url.replace(/^https?:\/\/[^/]+/, BASE));
    await p.close();
    return ctx;
  };
  const open = async (page) => {
    await page.goto(BASE);
    await page.locator('.account__btn').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.locator('.cfg-nav__item', { hasText: 'Connections' }).click();
    await page.locator('.conn-title').first().waitFor();
  };
  /** The confirm box, or the error the page showed instead. */
  const confirmBox = async (page) => {
    const box = page.getByRole('dialog', { name: 'Confirm change' });
    await Promise.race([box.waitFor(), page.locator('.cfg-error').waitFor()]);
    if (await page.locator('.cfg-error').count()) throw new Error(`the page said: ${await page.locator('.cfg-error').innerText()}`);
    return box;
  };
  const row = (page, name) => page.locator('.connections-item', { has: page.locator('.conn-title', { hasText: name }) });

  for (const scheme of ['light', 'dark']) {
    const ctx = await personContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, colorScheme: scheme });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 400)));
    await test(`${scheme}: every connection is one row with a status and a plain summary, the one needing you first`, async () => {
      await open(page);
      const titles = await page.locator('.conn-title').allInnerTexts();
      assert.match(titles[0], /^Google \(Alex\)\s*Needs reconnect/, titles.join(' | '));
      assert.ok(titles.some((t) => /^Actual budget\s*Connected/.test(t)));
      assert.ok(titles.some((t) => /^Case files\s*Off/.test(t)), 'a connection turned off on the server is listed, Off');
      const text = await page.locator('.cfg-section').first().innerText();
      assert.doesNotMatch(await page.locator('main, .app-settings, body').first().innerText(), /set up on the server|can't be removed here|in its own process/i);
      assert.equal(await row(page, 'Google (Alex)').getByRole('button', { name: 'Reconnect', exact: true }).count(), 1, 'Reconnect shows without opening the row');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `web-${scheme}-list.png`) });
      void text;
    });
    if (scheme === 'dark') { await ctx.close(); continue; }

    await test('Reconnect on the older Google connection asks before moving Leonard', async () => {
      await row(page, 'Google (Alex)').getByRole('button', { name: 'Reconnect', exact: true }).click();
      const box = await confirmBox(page);
      assert.match(await box.innerText(), /Reconnect Google \(Alex\) with a new Google sign-in\?[\s\S]*Leonard moves to the new sign-in/);
      if (SHOTS) await row(page, 'Google (Alex)').screenshot({ path: path.join(SHOTS, 'web-google-reconnect.png') });
      await box.getByRole('button', { name: 'Cancel' }).click();
    });

    await test('Turn off a server-file connection, see it Off, then Undo it in Recent changes', async () => {
      await row(page, 'Actual budget').locator('.plugin-head').first().click();
      if (SHOTS) await row(page, 'Actual budget').screenshot({ path: path.join(SHOTS, 'web-actual-open.png') });
      await row(page, 'Actual budget').getByRole('button', { name: 'Turn off', exact: true }).click();
      const box = await confirmBox(page);
      assert.match(await box.innerText(), /Turn off Actual budget\?[\s\S]*Leonard loses its tools/);
      await box.getByRole('button', { name: 'Confirm' }).click();
      await page.locator('.connections-note', { hasText: 'Done: Turn off Actual budget.' }).waitFor();
      await row(page, 'Actual budget').locator('.conn-state', { hasText: 'Off' }).waitFor();
      const apps = JSON.parse(fs.readFileSync(path.join(dir, 'apps.json'), 'utf8')).apps;
      assert.equal(apps.find((a) => a.id === 'actual').enabled, false);
      await page.locator('.plugin-head', { hasText: 'Recent changes' }).click();
      const ch = page.locator('.connector-row', { hasText: 'Turn off Actual budget' });
      await ch.waitFor();
      page.once('dialog', (d) => d.accept());
      await ch.getByRole('button', { name: 'Undo' }).click();
      await page.locator('.connections-note', { hasText: 'Done: Undo: Turn off Actual budget.' }).waitFor();
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'apps.json'), 'utf8')).apps.find((a) => a.id === 'actual').enabled, undefined);
    });

    await test('a tool can be set to Off, and back to its default', async () => {
      for (let i = 0; i < 30 && (await api('GET', '/connections')).connections.find((c) => c.id === 'actual').state !== 'connected'; i++) await sleep(300);
      await open(page);
      const r2 = row(page, 'Actual budget');
      await r2.locator('.plugin-head').first().click();
      await r2.locator('.plugin-head', { hasText: 'What it can do' }).click();
      const tool = r2.locator('.conn-tool', { hasText: 'Delete case' });
      await tool.getByRole('radio', { name: 'Off' }).click();
      await tool.getByRole('button', { name: 'Default' }).waitFor();
      assert.equal((await api('GET', '/connections')).connections.find((c) => c.id === 'actual').tools.find((t) => t.name === 'delete_case').rule, 'off');
      const send = r2.locator('.conn-tool', { hasText: 'Send note' });
      assert.equal(await send.getByRole('radio', { name: 'Runs' }).count(), 0, 'a must-ask tool offers no Runs');
      if (SHOTS) await r2.screenshot({ path: path.join(SHOTS, 'web-tools.png') });
      await tool.getByRole('button', { name: 'Default' }).click();
      await tool.getByRole('button', { name: 'Default' }).waitFor({ state: 'detached' });
    });
    await ctx.close();
  }

  await test('phone-width web: rows fit with no sideways scroll', async () => {
    const ctx = await personContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1 });
    const page = await ctx.newPage();
    await open(page);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 1, `page scrolls sideways by ${over}px`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'web-phone.png') });
    await ctx.close();
  });
} finally {
  await browser?.close();
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (failures) { console.log(`${failures} failed\n${log.slice(-3000)}`); process.exit(1); }
console.log('all passed');
