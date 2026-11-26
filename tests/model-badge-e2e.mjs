// End-to-end check of the model badge on a working bot's picture (server/src/model-badge.ts): the live state
// names the model and effort the turn runs on, follows Hermes to a fallback model mid-turn, and clears when
// the turn ends. Throwaway database; needs no Hermes. Run after `npm run build -w server`:
//   node tests/model-badge-e2e.mjs        (SHOT_DIR=dir also screenshots the web badges; needs web/dist)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-badge-e2e-'));
const PORT = 19500 + Math.floor(Math.random() * 400);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
};

// ---- naming rules (no server needed) ----
const mb = await import('../server/dist/model-badge.js');
await test('model names: short enough for a picture, full in the tooltip', () => {
  const n = (id, p = null) => mb.nameModel(id, p);
  assert.deepEqual(n('claude-opus-5-5'), { short: 'Opus', name: 'Claude Opus 5.5' });
  assert.deepEqual(n('claude-haiku-4-5-20251001'), { short: 'Haiku', name: 'Claude Haiku 4.5' });
  assert.deepEqual(n('anthropic/claude-sonnet-5'), { short: 'Sonnet', name: 'Claude Sonnet 5' });
  assert.deepEqual(n('gpt-5.5'), { short: 'GPT-5.5', name: 'GPT-5.5' });
  assert.deepEqual(n('gpt-5.4-mini'), { short: '5.4 mini', name: 'GPT-5.4 Mini' });
  assert.deepEqual(n('gpt-6.2-sol'), { short: '6.2 Sol', name: 'GPT-6.2 Sol' });
  assert.equal(n('grok-4-fast').short, 'Grok 4');
  assert.equal(n(null, 'anthropic').short, 'Claude');
  assert.equal(n('hermes-agent', null).short, 'Default');
  for (const id of ['claude-opus-5-5', 'gpt-5.4-mini', 'gpt-6.2-sol', 'grok-4-fast', 'some-new-model-x']) assert.ok(n(id).short.length <= 8, id);
});
await test('Hermes fallback notice is read, other status lines are not', () => {
  assert.deepEqual(mb.parseFallback('🔄 Switched to fallback model: claude-opus-5-5 via anthropic → claude-sonnet-5 via anthropic'), { model: 'claude-sonnet-5', provider: 'anthropic' });
  assert.deepEqual(mb.parseFallback('Switched to fallback model: gpt-5.5 via openai-codex -> claude-sonnet-5 via anthropic'), { model: 'claude-sonnet-5', provider: 'anthropic' });
  assert.equal(mb.parseFallback('Reading the file'), null);
  assert.equal(mb.parseFallback('❌ Rate limited after 3 retries'), null);
});

// ---- fake Hermes: no model set in the app, so it answers with its default; then it falls back mid-turn ----
const steps = [];
const nextStep = () => new Promise((r) => { steps.push(r); });
const go = () => steps.shift()?.();
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url?.startsWith('/api/model/options')) return res.end(JSON.stringify({ model: 'claude-opus-5-5', provider: 'anthropic', providers: [] }));
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.output_item.added', { item: { type: 'reasoning' } });
      send('response.reasoning_text.delta', { delta: 'Looking at the budget first.' });
      await Promise.race([nextStep(), new Promise((r) => setTimeout(r, 60_000))]);
      send('hermes.status', { text: '🔄 Switched to fallback model: claude-opus-5-5 via anthropic → claude-sonnet-5 via anthropic' });
      await Promise.race([nextStep(), new Promise((r) => setTimeout(r, 60_000))]);
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
  await api('POST', `/bots/${bot.id}/messages`, { text: 'How is the budget?' });

  await test('a working bot carries the model and effort it is using', async () => {
    const live = await until('the badge', async () => { const l = await liveOf(); return l?.model?.id === 'claude-opus-5-5' ? l : null; });
    assert.equal(live.isRunning, true);
    assert.equal(live.model.short, 'Opus');
    assert.equal(live.model.name, 'Claude Opus 5.5');
    assert.equal(live.model.effort, 'medium');
    assert.equal(live.model.fallback, false);
    assert.equal(live.model.mode, 'manual');
  });

  const shoot = async (name) => {
    if (!process.env.SHOT_DIR) return;
    const { chromium } = await import('playwright');
    const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1180, height: 720 }, deviceScaleFactor: 2, colorScheme: scheme });
      const link = await (await owner({ email: 'owner@example.com', link: true })).json();
      await page.goto(link.url.replace(/^https?:\/\/[^/]+/, BASE));
      await page.waitForSelector('.thinking', { timeout: 20_000 });
      await page.waitForSelector('.model-badge', { timeout: 10_000 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(process.env.SHOT_DIR, `web-${name}-${scheme}.png`) });
      if (scheme === 'light') {
        await page.locator('.chat__header .model-badge').first().click();
        await page.waitForSelector('.model-badge__pop', { timeout: 3000 });
        const box = await page.locator('.chat__header .model-badge').first().boundingBox();
        await page.screenshot({ path: path.join(process.env.SHOT_DIR, `web-${name}-details.png`), clip: { x: Math.max(0, box.x - 200), y: 0, width: 560, height: Math.min(720, box.y + 160) } });
      }
      await page.close();
    }
    await browser.close();
  };
  await test('web: badge shows on the list row, chat header and thinking picture', () => shoot('working'));

  await test('a mid-turn fallback moves the badge to the model actually answering', async () => {
    go();
    const live = await until('the fallback', async () => { const l = await liveOf(); return l?.model?.fallback ? l : null; });
    assert.equal(live.model.id, 'claude-sonnet-5');
    assert.equal(live.model.short, 'Sonnet');
    assert.equal(live.model.provider, 'anthropic');
  });
  await test('web: fallback badge', () => shoot('fallback'));

  await test('the badge clears when the turn ends, and usage counts the fallback model', async () => {
    go();
    const live = await until('the turn to finish', async () => { const l = await liveOf(); return l && !l.isRunning ? l : null; });
    assert.equal(live.model, null);
    const { json } = await api('GET', `/bots/${bot.id}/engine/usage?days=1`);
    assert.deepEqual(json?.usage?.rows?.map((r) => r.model), ['claude-sonnet-5'], JSON.stringify(json));
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
