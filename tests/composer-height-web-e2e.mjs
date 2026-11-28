// The message box's height: a big paste grows it to its cap and sending shrinks it back, and it is measured
// again when its width or placeholder changes with no new words (window resized, zoom, the Bot starts or stops
// working), so it never stays tall and blank. Throwaway database, fake Hermes, Chromium.
// Run after `npm run build`:   node tests/composer-height-web-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-height-'));
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
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ctx.addCookies(cookies.map((c) => { const [n, ...v] = c.split('='); return { name: n, value: v.join('='), url: BASE }; }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 400)));
  const api = async (method, p, b) => {
    const res = await fetch(`${BASE}/api${p}`, { method, headers: { cookie: cookies.join('; '), 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(j)}`);
    return j;
  };
  await api('POST', '/bots', { name: 'Leonard', avatarShape: 'cloud', avatarColor: 'green' });
  await page.goto(BASE);
  await page.locator('.bot-row', { has: page.locator('.bot-row__name', { hasText: /^Leonard$/ }) }).first().click();
  const box = page.locator('.composer__input');
  await box.waitFor();
  const h = () => box.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  const big = Array.from({ length: 80 }, (_, i) => `Line ${i + 1}: ${'some pasted words '.repeat(8)}`).join('\n');
  const paste = async (t) => { await page.evaluate((t) => navigator.clipboard.writeText(t), t); await box.focus(); await page.keyboard.press('Control+V'); };
  const empty = await h();
  await test('a big paste grows the box to its cap, Enter sends it and the box shrinks back', async () => {
    await paste(big);
    await page.keyboard.press('Enter');
    await sleep(50);
    assert.equal(await h(), empty);
  });
  await test('paste then select-all delete shrinks back', async () => {
    await paste(big); await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
    assert.equal(await h(), empty);
  });
  // The height the box should have now: its words (or placeholder) measured afresh, in CSS pixels.
  const fits = async (what) => {
    const [now, want] = await box.evaluate((el) => {
      const now = el.offsetHeight, old = el.style.height, oy = el.style.overflowY;
      el.style.overflowY = 'hidden'; el.style.height = '0px';
      const want = Math.min(el.scrollHeight, 200);
      el.style.height = old; el.style.overflowY = oy;
      return [now, want];
    });
    assert.equal(now, want, `${what}: the box is ${now}px tall but its contents need ${want}px`);
  };
  await test('the box is measured again when its width changes (window resized, side panel dragged, zoom)', async () => {
    await page.setViewportSize({ width: 1360, height: 800 });
    await paste(big); await page.keyboard.press('Enter'); await sleep(300);
    await fits('after sending');
    // Narrow enough that the placeholder wraps, then back: with no new words typed.
    await page.setViewportSize({ width: 470, height: 800 });
    await page.evaluate(() => { document.body.style.zoom = '1.6'; }); await sleep(300);
    await fits('narrow and zoomed');
    await page.evaluate(() => { document.body.style.zoom = '1'; });
    await page.setViewportSize({ width: 1360, height: 800 }); await sleep(300);
    await fits('wide again');
    assert.equal(await h(), empty);
  });
  await test('the box is measured again when the placeholder changes while the Bot works and when it is done', async () => {
    await page.evaluate(() => { document.body.style.zoom = '1.6'; }); await sleep(200);
    await box.focus(); await page.keyboard.type('slow please'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => /working on/.test(document.querySelector('.composer__input')?.placeholder ?? ''));
    await sleep(200); await fits('while the Bot works');
    await page.locator('.composer__cta[aria-label="Stop"]').evaluate((b) => b.click());
    await page.waitForFunction(() => !/working on/.test(document.querySelector('.composer__input')?.placeholder ?? ''), null, { timeout: 15000 });
    await sleep(200); await fits('after the Bot stopped');
    await page.evaluate(() => { document.body.style.zoom = '1'; }); await sleep(200);
    await fits('back to normal zoom');
  });
  await test('send button after paste', async () => {
    await paste(big); await page.locator('.composer__cta[aria-label="Send"]').click();
    assert.equal(await h(), empty);
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
