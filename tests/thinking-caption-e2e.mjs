// End-to-end check of the live thinking line (server/src/caption.ts): a fake Hermes streams a long thought,
// and the live state carries a short recap (never cut mid-sentence, no "…") plus the whole thought for the
// apps' expanded bubble. Throwaway database; needs no Hermes. Run after `npm run build -w server`:
//   node tests/thinking-caption-e2e.mjs        (SHOT_DIR=dir also screenshots the web bubble; needs web/dist)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-caption-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 500);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// ---- fake Hermes: one long thought, then it waits until the test lets the turn finish ----
const THOUGHT = "I'm weighing whether the read-only Actual Budget tools could give me enough to build the morning briefing, or whether I need the Plaid connector for live balances. The last two tries failed, so I'll check the connection first.";
let release;
const released = new Promise((r) => { release = r; });
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.output_item.added', { item: { type: 'reasoning' } });
      for (const piece of THOUGHT.match(/.{1,30}/g)) send('response.reasoning_text.delta', { delta: piece });
      await Promise.race([released, new Promise((r) => setTimeout(r, 60_000))]);
      send('response.output_text.delta', { delta: 'Done.' });
      send('response.output_item.done', { item: { type: 'message', content: [{ text: 'Done.' }] } });
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

try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const owner = (body) => fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // A person's session: a one-time sign-in link opened by "the phone app" (bearer token).
  const linked = await (await owner({ email: 'owner@example.com', link: true })).json();
  const { token } = await (await fetch(linked.url.replace(/^https?:\/\/[^/]+/, BASE), { headers: { accept: 'application/json' } })).json();
  assert.ok(token, 'a person session');
  const call = async (auth, method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { ...auth, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const api = (m, p, b) => call({ authorization: `Bearer ${token}` }, m, p, b);
  const { json: { bots } } = await api('GET', '/bots');
  const bot = bots.find((b) => b.isPrimary);
  assert.ok(bot, 'the account has a primary bot');
  const liveOf = async () => (await api('GET', '/bots')).json.live.find((l) => l.botId === bot.id);
  const until = async (what, fn) => {
    for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}`);
  };
  await api('POST', `/bots/${bot.id}/messages`, { text: 'When is the morning briefing?' });

  await test('the live line is a short recap, never cut mid-word or with an ellipsis', async () => {
    const live = await until('the whole thought', async () => { const l = await liveOf(); return l?.captionFull === THOUGHT ? l : null; });
    assert.equal(live.caption, 'Weighing whether read-only Actual Budget tools');
    assert.ok(!/…$/.test(live.caption));
  });

  if (process.env.SHOT_DIR) {
    await test('web: the recap expands to the whole thought and back', async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
      const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2, colorScheme: 'dark' });
      const link = await (await owner({ email: 'owner@example.com', link: true })).json();
      await page.goto(link.url.replace(/^https?:\/\/[^/]+/, BASE));
      await page.waitForSelector('.thinking__more', { timeout: 20_000 });
      await page.locator('.thinking').screenshot({ path: path.join(process.env.SHOT_DIR, 'web-collapsed.png') });
      await page.click('.thinking__more');
      assert.equal(await page.locator('.thinking__full').innerText(), THOUGHT);
      await sleep(400);
      await page.locator('.thinking').screenshot({ path: path.join(process.env.SHOT_DIR, 'web-expanded.png') });
      await page.click('.thinking__more');
      assert.equal(await page.locator('.thinking__full').count(), 0);
      await browser.close();
    });
  }

  await test('the line clears when the turn ends', async () => {
    release();
    const live = await until('the turn to finish', async () => { const l = await liveOf(); return l && !l.isRunning ? l : null; });
    assert.equal(live.caption, null);
    assert.equal(live.captionFull, null);
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
