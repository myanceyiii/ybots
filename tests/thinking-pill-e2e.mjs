// The thinking pill (the bot's face on a dark plate with its name and status) keeps a steady width while
// the status changes: wide enough for every fixed status word, growing smoothly (never shrinking) for a
// longer one. Alex saw it flicker between widths (2026-11-23). Real server, Vite dev server and a
// browser; the bot's live state is set from the page. SHOTS=<dir> saves screenshots.
// Run after `npm run build -w server`:   node tests/thinking-pill-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-pill-'));
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
let vite;

try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const r = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com' }) });
  const cookies = r.headers.getSetCookie().map((c) => c.split(';')[0]);
  browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  await fetch(`${BASE}/api/bots`, { method: 'POST', headers: { cookie: cookies.join('; '), 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Howard', avatarShape: 'blob', avatarColor: 'red' }) });
  // The web app from Vite's dev server, so the test can set the bot's live state from the page.
  const VITE = 'http://localhost:5173';
  vite = spawn(process.execPath, [path.join(root, 'web/node_modules/vite/bin/vite.js'), '--port', '5173', '--strictPort'], { cwd: path.join(root, 'web'), env: { ...process.env, CLEFTBOT_API: BASE }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; ; i++) { try { if ((await fetch(VITE)).ok) break; } catch { /* starting */ } if (i > 150) throw new Error('vite did not start'); await sleep(200); }
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  await ctx.addCookies(cookies.map((c) => { const [n, ...v] = c.split('='); return { name: n, value: v.join('='), url: VITE }; }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 400)));
  await page.goto(VITE);
  // Vite's dev mode runs the start-up twice and can drop the first bot list; load it once more.
  await sleep(1500); await page.evaluate(async () => { const { useStore } = await import('/src/store.ts'); await useStore.getState().loadBots(); });
  await page.locator('.bot-row', { has: page.locator('.bot-row__name', { hasText: /^Howard$/ }) }).first().click();
  await page.locator('.composer__input').waitFor();
  const setActivity = (kind, detail) => page.evaluate(async ([kind, detail]) => {
    const { useStore } = await import('/src/store.ts');
    const st = useStore.getState();
    const id = st.selectedBotId;
    const now = Date.now();
    useStore.setState({ live: { ...st.live, [id]: { botId: id, isRunning: true, startedAt: now - 30_000, steps: 2, activity: kind ? { kind, detail, since: now } : null, awaiting: null } } });
  }, [kind, detail]);
  const width = () => page.locator('.thinking__pill').evaluate((el) => el.getBoundingClientRect().width);

  await test('the pill keeps one width while short and long fixed statuses take turns', async () => {
    await setActivity(null);
    await page.locator('.thinking__pill').waitFor();
    await sleep(400);
    const widths = [];
    for (const k of ['thinking', 'running_commands', 'searching_web', 'waiting_on_command', 'working', 'remembering', 'thinking']) {
      await setActivity(k); await sleep(350); widths.push(Math.round(await width()));
    }
    assert.equal(new Set(widths).size, 1, `widths: ${widths.join(', ')}`);
    if (SHOTS) await page.locator('.thinking').screenshot({ path: path.join(SHOTS, 'pill-short.png') });
  });
  await test('a longer status widens it once, the text is not cut, and it stays wide when the status gets short again', async () => {
    const before = await width();
    await setActivity('connecting_service', 'Google Calendar'); await sleep(400);
    const wide = await width();
    assert.ok(wide > before, `${wide} > ${before}`);
    const cut = await page.locator('.thinking__pill > .thinking__status').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    assert.equal(cut, false, 'the status shows in full');
    if (SHOTS) await page.locator('.thinking').screenshot({ path: path.join(SHOTS, 'pill-long.png') });
    const samples = [];
    for (const k of ['thinking', 'connecting_service', 'working', 'thinking']) { await setActivity(k, 'Google Calendar'); await sleep(300); samples.push(Math.round(await width())); }
    assert.deepEqual(samples, samples.map(() => Math.round(wide)), `no shrinking back: ${samples.join(', ')}`);
  });
  await test('the width change is a transition, not a jump', async () => {
    const t = await page.locator('.thinking__pill').evaluate((el) => getComputedStyle(el).transitionProperty);
    assert.match(t, /width/);
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}\n${log.slice(-1500)}`);
} finally {
  await browser?.close();
  server.kill(); vite?.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
