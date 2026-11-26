// The Engine section in the web/Windows details panel folds away (web/src/components/EngineSettings.tsx):
// closed by default with a summary line, opens and closes from the keyboard, is remembered after a reload,
// and "Engine and providers" in the chat menu opens it. Throwaway database and a fake Hermes.
// Needs a built server and web app (`npm run build`) and Chromium:  node tests/engine-fold-web-e2e.mjs
// SHOT_DIR=dir also saves light and dark screenshots of both states.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-fold-e2e-'));
const PORT = 20000 + Math.floor(Math.random() * 400);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

const hermes = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url === '/api/model/options') return res.end(JSON.stringify({
      provider: 'anthropic', model: 'claude-sonnet-5',
      providers: [{ slug: 'anthropic', name: 'Anthropic', authenticated: true, auth_type: 'api_key', featured_models: ['claude-sonnet-5', 'claude-opus-5-5'] }],
    }));
    res.statusCode = 404; res.end('{}');
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
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const link = async () => (await (await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', link: true }) })).json()).url.replace(/^https?:\/\/[^/]+/, BASE);

  const { chromium } = await import('playwright');
  browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: process.env.SHOT_DIR ? 2 : 1 });
  const page = await ctx.newPage();
  await page.goto(await link());
  const head = page.locator('.engine-fold__head');
  await head.waitFor({ timeout: 20_000 });
  const shot = async (name) => { if (process.env.SHOT_DIR) await page.locator('.details').screenshot({ path: path.join(process.env.SHOT_DIR, `${name}.png`) }); };

  await test('closed at first, with the model on one line and the settings hidden', async () => {
    assert.equal(await head.getAttribute('aria-expanded'), 'false');
    await page.waitForFunction(() => /claude-sonnet-5/.test(document.querySelector('.engine-fold__sum')?.textContent ?? ''), null, { timeout: 10_000 });
    assert.equal(await page.locator('select[aria-label="Provider"]').isVisible(), false);
    await shot('closed-light');
  });

  await test('Enter on the header opens it, and it says so to a screen reader', async () => {
    await head.focus();
    await page.keyboard.press('Enter');
    assert.equal(await head.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('select[aria-label="Provider"]').isVisible(), true);
    const body = await head.getAttribute('aria-controls');
    assert.ok(body && await page.locator(`[id="${body}"]`).isVisible());
    await shot('open-light');
  });

  await test('remembered after a reload', async () => {
    await page.reload();
    await head.waitFor();
    assert.equal(await head.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Tab'); // keep focus out of the way
    await head.click();
    assert.equal(await head.getAttribute('aria-expanded'), 'false');
    await page.reload();
    await head.waitFor();
    assert.equal(await head.getAttribute('aria-expanded'), 'false');
  });

  await test('"Engine and providers" in the chat menu opens it, even from another tab', async () => {
    await page.locator('.details__tabs button', { hasText: 'Tasks' }).click();
    assert.equal(await head.count(), 0);
    await page.locator('.chat__pill').click();
    await page.getByRole('menuitem', { name: 'Engine and providers' }).click();
    await head.waitFor();
    await page.waitForFunction(() => document.querySelector('.engine-fold__head')?.getAttribute('aria-expanded') === 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('engine-fold__head')), true, 'focus moves to the header');
  });

  await test('closed, a failing provider still shows as a problem count', async () => {
    await page.route('**/api/bots/*/engine', async (route) => {
      const r = await route.fetch();
      const j = await r.json();
      const def = j.engine.catalog?.find((p) => p.id === j.engine.provider);
      if (def) def.lastTurn = { at: Date.now(), model: j.engine.model, ok: false };
      await route.fulfill({ response: r, json: j });
    });
    await page.reload();
    await head.waitFor();
    if (await head.getAttribute('aria-expanded') === 'true') await head.click();
    const badge = page.locator('.engine-fold__problems');
    await badge.waitFor({ timeout: 10_000 });
    assert.equal((await badge.textContent()).trim(), '1 problem');
    assert.match(await badge.getAttribute('aria-label'), /last request failed/);
    await shot('problem-light');
    await page.unroute('**/api/bots/*/engine');
  });

  if (process.env.SHOT_DIR) {
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot('open-dark');
    await head.click();
    await shot('closed-dark');
  }
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}\n${log.slice(-1500)}`);
} finally {
  await browser?.close();
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passed');
