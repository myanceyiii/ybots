// Copy and Edit on your own messages in the web app (and so the Windows app, which loads it), in a real
// browser against the real server: Edit puts your words back in the box with an "Editing your message"
// bar, Send posts the new version and the old bubble reads "Edited", the Bot is told the new version
// replaces the old one, Escape cancels and gives back what you had typed, and Copy copies your words.
// Throwaway database; needs no Hermes. SHOTS=<dir> saves screenshots.
// Run after `npm run build` (web and server):   node tests/message-edit-web-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-edit-web-'));
const PORT = 19100 + Math.floor(Math.random() * 300);
const HERMES_PORT = PORT + 700;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
const SHOTS = process.env.SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const inputs = [];
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
    inputs.push(b.input);
    const text = `Got it: ${b.input.split('\n').pop().slice(0, 40)}`;
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
  // The browser signs in as the person (a one-time link), not as a script: only a person can edit.
  const link = await (await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', link: true }) })).json();
  browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1360, height: 860 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  await page.goto(link.url.replace(/^https?:\/\/[^/]+/, BASE));
  page.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 400)));
  const api = async (method, p, b) => {
    const res = await fetch(`${BASE}/api${p}`, { method, headers: { cookie: cookies.join('; '), 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(j)}`);
    return j;
  };
  const { bots } = await api('GET', '/bots');
  const bot = bots.find((b) => b.isPrimary);
  await page.goto(BASE);
  // A second Bot so the list shows; then open the main Bot's chat.
  await api('POST', '/bots', { name: 'Howard', avatarShape: 'blob', avatarColor: 'red' });
  await page.goto(BASE);
  await page.locator('.bot-row', { hasText: bot.name }).first().click();
  const box = page.locator('.composer__input');
  const until = async (what, fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(100); } throw new Error(`timed out waiting for ${what}`); };

  await test('your message has Copy and Edit; a Bot message has no Edit', async () => {
    await box.fill('Buy milk and eggs on Satruday');
    await box.press('Enter');
    await page.locator('.bubble', { hasText: 'Got it: Buy milk and eggs on Satruday' }).waitFor();
    const mine = page.locator('.group.is-right').last();
    await mine.hover();
    assert.ok(await mine.getByRole('button', { name: 'Copy' }).isVisible());
    assert.ok(await mine.getByRole('button', { name: 'Edit' }).isVisible());
    assert.equal(await page.locator('.group.is-left').last().getByRole('button', { name: 'Edit' }).count(), 0);
    await mine.getByRole('button', { name: 'Copy' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Buy milk and eggs on Satruday');
  });

  await test('Escape cancels an edit and gives back what you had typed', async () => {
    await box.fill('half a thought');
    const mine = page.locator('.group.is-right').last();
    await mine.hover();
    await mine.getByRole('button', { name: 'Edit' }).click();
    assert.equal(await box.inputValue(), 'Buy milk and eggs on Satruday');
    assert.ok(await page.getByText('Editing your message').isVisible());
    await box.press('Escape');
    assert.equal(await box.inputValue(), 'half a thought');
    assert.equal(await page.getByText('Editing your message').count(), 0);
  });

  await test('Send posts the new version and marks the old one Edited', async () => {
    const mine = page.locator('.group.is-right').last();
    await mine.hover();
    await mine.getByRole('button', { name: 'Edit' }).click();
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'web-editing.png') });
    await box.fill('Buy milk and eggs on Saturday');
    await box.press('Enter');
    await page.locator('.bubble', { hasText: 'Got it: Buy milk and eggs on Saturday' }).waitFor();
    await until('the Edited labels', async () => (await page.locator('.bubble__edited').count()) === 2);
    assert.equal(await page.locator('.bubble__edited').first().innerText(), 'Edited · new version below');
    assert.equal(await page.locator('.bubble__edited').last().innerText(), 'Edited');
    assert.equal(await box.inputValue(), 'half a thought', 'your earlier draft comes back');
    assert.match(inputs.at(-1), /^\[The person edited their earlier message "Buy milk and eggs on Satruday"\. This new version replaces it; answer this one\.\]\nBuy milk and eggs on Saturday$/);
    const old = page.locator('.group.is-right').filter({ hasText: 'Satruday' });
    await old.hover();
    assert.equal(await old.getByRole('button', { name: 'Edit' }).count(), 0, 'an edited message cannot be edited again');
    await box.fill('');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'web-edited.png') });
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
