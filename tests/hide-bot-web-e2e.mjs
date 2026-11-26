// "Hide from my list" in the web app (and so the Windows app, which loads it), in a real browser against the
// real server: Alex hides Robin from a row's menu; her row and her unread count leave the list, the group
// she is in stays, a line under the list opens her or shows her again, and her notifications stop on the main
// profile while the Robin app's profile still gets them. Throwaway database; needs no Hermes.
// SHOTS=<dir> saves screenshots. Run after `npm run build` (web and server):   node tests/hide-bot-web-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hide-bot-web-'));
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
    APPS_CONFIG: path.join(dir, 'apps.json'), BOTHQ_NO_SCHEDULER: '1',
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
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  await ctx.addCookies(cookies.map((c) => { const [n, ...v] = c.split('='); return { name: n, value: v.join('='), url: BASE }; }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 400)));
  const api = async (method, p, b) => {
    const res = await fetch(`${BASE}/api${p}`, { method, headers: { cookie: cookies.join('; '), 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(j)}`);
    return j;
  };
  // A full-body character: a small head on top of a tall body, so a face crop is easy to tell apart.
  const primary = (await api('GET', '/bots')).bots.find((b) => b.isPrimary);
  const leonard = (await api('POST', '/bots', { name: 'Leonard', avatarShape: 'cloud', avatarColor: 'green' })).bot;
  const robin = (await api('POST', '/bots', { name: 'Robin', avatarShape: 'heart', avatarColor: 'gray' })).bot;
  await api('POST', '/rooms', { name: 'Household Huddle', botIds: [leonard.id, robin.id] });
  const Database = createRequire(path.join(root, 'server/package.json'))('better-sqlite3');
  const db = new Database(path.join(dir, 'test.db'));
  db.prepare('UPDATE bots SET unread=2 WHERE id=?').run(robin.id);
  const rowOf = (name) => page.locator('.bot-row', { has: page.locator('.bot-row__name', { hasText: new RegExp(`^${name}$`) }) });

  await test('Robin shows, and counts as unread, before she is hidden', async () => {
    await page.goto(BASE);
    await rowOf('Robin').first().waitFor();
    assert.match(await page.title(), /^\(1\)/, 'the title counts her unread chat');
  });

  await test('hiding Robin from her row menu takes her row and count away; the group stays', async () => {
    await page.getByRole('button', { name: 'More for Robin' }).click();
    await page.getByRole('menuitem', { name: 'Hide from my list' }).click();
    await page.locator('.bot-list__hidden').getByText('Robin is hidden').waitFor();
    assert.equal(await rowOf('Robin').count(), 0, 'no Robin row');
    assert.equal(await page.locator('.bot-row', { hasText: 'Household Huddle' }).count(), 1, 'the group stays');
    assert.equal(await rowOf('Leonard').count(), 1);
    assert.doesNotMatch(await page.title(), /^\(\d+\)/, 'her unread no longer counts');
    const { bots } = await api('GET', '/bots');
    assert.equal(bots.find((b) => b.id === robin.id).ownerHidden, true);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'web-hidden.png') });
  });

  await test('her notifications stop for the main profile, not for the Robin app', async () => {
    const N = { channel: 'messages', tag: `chat:${robin.id}`, botId: robin.id, title: 'Robin', body: 'Milk is on the list.' };
    db.prepare('INSERT INTO notices(user_id,bot_id,channel,tag,body,created_at) VALUES (?,?,?,?,?,?)').run(primary ? db.prepare('SELECT user_id FROM bots WHERE id=?').get(robin.id).user_id : '', robin.id, 'messages', N.tag, JSON.stringify({ ...N, createdAt: Date.now() }), Date.now());
    const main = (await api('GET', '/notify/recent')).notices.filter((n) => n.botId === robin.id);
    const pen = (await api('GET', '/notify/recent?profile=robin')).notices.filter((n) => n.botId === robin.id);
    assert.equal(main.length, 0, 'main profile: none');
    assert.equal(pen.length, 1, 'Robin app: still there');
  });

  await test('Settings › Notifications lists her as hidden, with Show', async () => {
    await page.goto(BASE);
    await page.locator('.account__btn').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.locator('.cfg-nav__item', { hasText: 'Notifications' }).click();
    const row = page.locator('.cfg-row', { hasText: 'Hidden from your list, so no notifications.' });
    await row.waitFor();
    assert.equal(await row.locator('.cfg-row__title').innerText(), 'Robin');
    assert.equal(await row.getByRole('button', { name: 'Show' }).count(), 1);
    if (SHOTS) await row.screenshot({ path: path.join(SHOTS, 'web-settings-hidden.png') });
  });

  await test('the line under the list shows her again', async () => {
    await page.goto(BASE);
    await page.locator('.bot-list__hidden button').click();
    await page.getByRole('menuitem', { name: 'Show Robin in the list again' }).click();
    await rowOf('Robin').first().waitFor();
    assert.equal(await page.locator('.bot-list__hidden').count(), 0);
    const { bots } = await api('GET', '/bots');
    assert.equal(bots.find((b) => b.id === robin.id).ownerHidden, false);
    assert.equal((await api('GET', '/notify/recent')).notices.filter((n) => n.botId === robin.id).length, 1, 'her notices are back');
  });

  await test('the main bot cannot be hidden', async () => {
    if (!primary) return;
    await assert.rejects(api('PATCH', `/bots/${primary.id}`, { ownerHidden: true }), /main bot cannot be hidden/);
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}\n${log.slice(-1500)}`);
} finally {
  await browser?.close();
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
