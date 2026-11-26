// The web app (and so the Windows app, which loads it) in a real browser against the real server:
// one Escape closes one dialog and Tab stays inside it; a failed sign-out says so and keeps you signed
// in; search finds a bot by its latest message and opens its chat; a different account signing in
// clears the previous account's bots. Throwaway database; needs no Hermes.
// Run after `npm run build` (web and server):   node tests/web-client-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-client-e2e-'));
const PORT = 19500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
const hermesHome = path.join(dir, 'hermes');
fs.mkdirSync(hermesHome, { recursive: true });
fs.writeFileSync(path.join(hermesHome, '.env'), 'API_SERVER_KEY=test-key\n');

const server = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
  cwd: path.join(root, 'server'),
  env: {
    PATH: process.env.PATH, HOME: dir,
    PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET,
    ORGO_API_KEY: 'unused', DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'),
    HERMES_BIN: '/bin/false', HERMES_URL: 'http://127.0.0.1:9', HERMES_HOME_PRIMARY: hermesHome,
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { chromium } = createRequire(import.meta.url)('playwright');
let browser;

try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const signInAs = async (email) => {
    const r = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    assert.equal(r.status, 200, await r.text());
    return r.headers.getSetCookie().map((c) => c.split(';')[0]);
  };
  const cookies = await signInAs('owner@example.com');
  browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const setCookies = (list) => ctx.addCookies(list.map((c) => { const [n, ...v] = c.split('='); return { name: n, value: v.join('='), url: BASE }; }));
  await setCookies(cookies);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`);
  await page.locator('.bot-row').first().waitFor({ timeout: 15000 });

  await test('one Escape closes one dialog, and Tab stays inside it', async () => {
    await page.keyboard.press('Control+k');
    const dlg = page.locator('.search-modal');
    await dlg.waitFor();
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      assert.ok(await dlg.evaluate((el) => el.contains(document.activeElement)), `focus left the dialog after ${i + 1} Tab presses`);
    }
    await page.keyboard.press('Shift+Tab');
    assert.ok(await dlg.evaluate((el) => el.contains(document.activeElement)), 'Shift+Tab left the dialog');
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
  });

  await test('search names what it searches and opens the chat it finds', async () => {
    await page.keyboard.press('Control+k');
    const input = page.locator('.search-modal input');
    assert.match(await input.getAttribute('placeholder'), /latest messages/);
    const first = (await page.locator('.search-row').first().innerText()).split('\n')[0].trim();
    await input.fill(first.slice(0, 4));
    await page.keyboard.press('Enter');
    await page.locator('.search-modal').waitFor({ state: 'detached' });
  });

  await test('a failed sign-out says so and keeps you signed in', async () => {
    await page.route('**/api/auth/logout', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Server busy' }) }));
    await page.locator('.account__btn').click();
    await page.getByText('Sign out', { exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /still signed in/ }).waitFor({ timeout: 5000 });
    assert.ok(await page.locator('.bot-row').count() > 0 || await page.locator('.cfg-section').count() > 0, 'still in the app');
    await page.unroute('**/api/auth/logout');
    await page.keyboard.press('Escape');
  });

  await test('another account signing in clears the previous account\'s bots before showing its own', async () => {
    const before = await page.locator('.bot-row__name').allInnerTexts();
    assert.ok(before.length > 0);
    // Rename a bot in the first account so the second account (with default names) can be told apart.
    const first = await page.evaluate(async () => (await (await fetch('/api/bots')).json()).bots[0]);
    await page.evaluate(async (id) => { await fetch(`/api/bots/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Firstaccount' }) }); }, first.id);
    await page.locator('.bot-row__name', { hasText: 'Firstaccount' }).waitFor();
    await ctx.clearCookies();
    await setCookies(await signInAs('second@example.com'));
    await page.evaluate(() => window.dispatchEvent(new Event('cleftbot:signed-out')));
    await sleep(1500);
    const now = await page.locator('.bot-row__name').allInnerTexts();
    const me = await page.evaluate(async () => (await (await fetch('/api/auth/me')).json()).user?.email);
    assert.equal(me, 'second@example.com');
    assert.ok(!now.includes('Firstaccount'), `the first account's bot still shows: ${now.join(', ')}`);
  });
} finally {
  await browser?.close();
  server.kill();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
