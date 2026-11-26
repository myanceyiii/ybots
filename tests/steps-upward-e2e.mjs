// The steps chip ("7 steps", above a bot's reply) opens upward: the list sits above the chip with the newest
// step right next to it, so the collapse control never moves out of reach and the newest steps show first.
// Alex asked for this 2026-11-24. Real server, Vite dev server and a browser; rows are put in the store
// from the page. SHOTS=<dir> saves screenshots.
// Run after `npm run build -w server`:   node tests/steps-upward-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steps-upward-'));
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
  // A long earlier chat, then a run of many steps, then the reply.
  const put = (extra) => page.evaluate(async ([extra]) => {
    const { useStore } = await import('/src/store.ts');
    const st = useStore.getState();
    const id = st.selectedBotId;
    const gen = st.transcripts[id]?.generation ?? 1;
    const now = Date.now();
    const rows = [];
    let seq = 1000;
    const msg = (role, text) => rows.push({ botId: id, generation: gen, seq: ++seq, updatedSeq: seq, kind: 'message', body: { type: 'message', role, text }, createdAt: now - 600_000 + seq });
    for (let i = 0; i < 12; i++) msg(i % 2 ? 'assistant' : 'user', `Earlier message ${i}. ${'Some text to make it longer. '.repeat(4)}`);
    msg('user', 'Check the bills');
    const n = 40 + extra;
    for (let i = 1; i <= n; i++) rows.push({ botId: id, generation: gen, seq: ++seq, updatedSeq: seq, kind: 'tool-call', body: { type: 'tool-call', callId: `c${i}`, name: 'terminal', label: `Step number ${i}`, status: i === 7 ? 'error' : 'done', args: { command: `echo ${i}` } }, createdAt: now - 300_000 + i * 1000 });
    msg('assistant', 'Here is what I found about the bills.');
    st.upsertRows(id, gen, rows);
  }, [extra]);
  const box = (sel) => page.locator(sel).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; });
  await put(0);
  await page.locator('.steps__toggle').first().waitFor();
  await sleep(500);

  await test('opening puts the list above the chip, newest step next to it, and the chip does not move', async () => {
    const before = await box('.steps__toggle');
    await page.locator('.steps__toggle').first().click();
    await sleep(300);
    const after = await box('.steps__toggle');
    assert.ok(Math.abs(after.top - before.top) < 2, `chip moved ${before.top} -> ${after.top}`);
    const list = await box('.steps__list');
    assert.ok(list.bottom <= after.top + 1, 'list is above the chip');
    const last = await box('.steps__list .step:last-child');
    assert.ok(last.bottom <= list.bottom + 1 && last.top >= list.top - 1, 'newest step is in view');
    assert.match(await page.locator('.steps__list .step:last-child').innerText(), /Step number 40/);
    assert.ok(list.height <= 482, `list is capped (${list.height})`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'steps-open.png') });
  });
  await test('collapsing is right there and the chip stays put', async () => {
    const before = await box('.steps__toggle');
    await page.locator('.steps__toggle').first().click();
    await sleep(200);
    const after = await box('.steps__toggle');
    assert.ok(Math.abs(after.top - before.top) < 2, `chip moved ${before.top} -> ${after.top}`);
    assert.equal(await page.locator('.steps__list').count(), 0);
  });
  await test('scrolled up in the chat, opening still keeps the chip where it was', async () => {
    await page.locator('.transcript').evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 60; el.dispatchEvent(new Event('scroll')); });
    await sleep(200);
    const before = await box('.steps__toggle');
    const st0 = await page.locator('.transcript').evaluate((el) => [el.scrollTop, el.scrollHeight, el.clientHeight]);
    await page.locator('.steps__toggle').first().click();
    const mid = await box('.steps__toggle');
    await sleep(300);
    const st1 = await page.locator('.transcript').evaluate((el) => [el.scrollTop, el.scrollHeight, el.clientHeight]);
    const after = await box('.steps__toggle');
    assert.ok(Math.abs(after.top - before.top) < 2, `chip moved ${before.top} -> ${mid.top} -> ${after.top} ${st0} ${st1}`);
  });
  await test('a new step streaming in shows at the bottom of the open list', async () => {
    await put(1);
    await sleep(300);
    assert.match(await page.locator('.steps__list .step:last-child').innerText(), /Step number 41/);
    const list = await box('.steps__list');
    const last = await box('.steps__list .step:last-child');
    assert.ok(last.bottom <= list.bottom + 1, 'newest step still in view');
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
