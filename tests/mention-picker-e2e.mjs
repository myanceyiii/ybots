// End-to-end check of the @ picker in a group chat's message box (web/src/components/Composer.tsx), in a
// real browser against the real server: typing @ lists the group's members, typing more filters them, Enter
// or a click puts "@Name " in the box, the mention is tinted in the box, and the sent message shows it in bold.
// Throwaway database; needs no Hermes. Run after `npm run build`:
//   node tests/mention-picker-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mention-picker-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 500);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');


const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.output_text.delta', { delta: 'ok' });
      send('response.output_item.done', { item: { type: 'message', content: [{ text: 'ok' }] } });
      send('response.completed', { response: {} });
      return res.end();
    }
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
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.SHOTS_DIR;
const { chromium } = await import('playwright');
const browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const signIn = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com' }) });
  assert.equal(signIn.status, 200, await signIn.text());
  const cookies = signIn.headers.getSetCookie().map((c) => c.split(';')[0]);
  const cookie = cookies.join('; ');
  const api = async (method, p, b) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const { json: { bots } } = await api('GET', '/bots');
  const a = bots.find((x) => x.isPrimary);
  const names = ['Leonard', 'Robin', 'Sheldon'];
  const ids = [a.id];
  for (const name of names) ids.push((await api('POST', '/bots', { name })).json.bot.id);
  const room = await api('POST', '/rooms', { name: 'Household Huddle', botIds: ids });
  assert.equal(room.status, 200, JSON.stringify(room.json));
  const roomId = room.json.id;

  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: shots ? 2 : 1 });
  // The browser signs in as the person (a sign-in link), so what it sends shows as their own message.
  const link = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', link: true }) });
  const page = await ctx.newPage();
  await page.goto((await link.json()).url);
  await page.goto(`${BASE}/`);
  await page.getByText('Household Huddle').first().click();
  const box = page.locator('textarea.composer__input');
  await box.waitFor();
  const options = page.locator('.mention-picker [role=option]');

  await test('typing @ lists every member of the group', async () => {
    await box.click();
    await box.pressSequentially('What about you, @');
    await options.first().waitFor({ timeout: 5000 });
    const listed = await options.locator('.mention-picker__name').allTextContents();
    assert.deepEqual(listed.sort(), [a.name, ...names].sort());
  });
  await test('typing more filters the list', async () => {
    await box.pressSequentially('sh');
    await page.waitForFunction(() => document.querySelectorAll('.mention-picker [role=option]').length === 1);
    assert.equal(await options.locator('.mention-picker__name').textContent(), 'Sheldon');
    if (shots) await page.screenshot({ path: path.join(shots, 'web-picker.png') });
  });
  await test('Enter puts "@Sheldon " in the box and closes the list', async () => {
    await box.press('Enter');
    assert.equal(await box.inputValue(), 'What about you, @Sheldon ');
    assert.equal(await options.count(), 0);
    assert.equal(await page.locator('.composer__backdrop mark.mention-hl').textContent(), '@Sheldon');
  });
  await test('a click picks too, and Escape closes the list without picking', async () => {
    await box.pressSequentially('and @');
    await options.first().waitFor();
    await box.press('Escape');
    assert.equal(await options.count(), 0);
    await box.press('Backspace');
    await box.pressSequentially('@ro');
    await options.first().waitFor();
    await options.first().click();
    assert.equal(await box.inputValue(), 'What about you, @Sheldon and @Robin ');
    assert.deepEqual(await page.locator('.composer__backdrop mark.mention-hl').allTextContents(), ['@Sheldon', '@Robin']);
    if (shots) await page.screenshot({ path: path.join(shots, 'web-box.png') });
  });
  await test('an email address does not open the list', async () => {
    await box.pressSequentially('mail me@');
    assert.equal(await options.count(), 0);
    for (let i = 0; i < 'mail me@'.length; i++) await box.press('Backspace');
  });
  await test('the sent message shows the mentions in bold', async () => {
    await box.press('Enter');
    const strong = page.locator('.bubble.is-user .bubble__mention');
    await strong.first().waitFor({ timeout: 5000 });
    assert.deepEqual(await strong.allTextContents(), ['@Sheldon', '@Robin']);
    const sent = (await api('GET', `/bots/${roomId}/rows`)).json.rows.find((r) => r.body.role === 'user');
    assert.equal(sent.body.text, 'What about you, @Sheldon and @Robin');
    if (shots) await page.screenshot({ path: path.join(shots, 'web-sent.png') });
  });
} catch (e) {
  failures++;
  console.log(`FAIL setup\n     ${e.stack}\n${log.slice(-1500)}`);
} finally {
  await browser.close();
  server.kill();
  hermes.close();
}
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log('all passed');
