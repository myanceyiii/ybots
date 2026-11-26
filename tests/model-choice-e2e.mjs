// End-to-end check of per-bot model choice through the real server, with a fake Hermes that records
// the provider, model and reasoning effort each turn asks for. Throwaway database; needs no Hermes.
// Run after `npm run build -w server`:  node tests/model-choice-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-choice-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 500);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// ---- fake Hermes ----
const asked = [];
let failNext = false;
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url === '/api/model/options') return res.end(JSON.stringify({
      provider: 'anthropic', model: 'claude-sonnet-5',
      providers: [
        { slug: 'anthropic', name: 'Anthropic', authenticated: true, auth_type: 'oauth', featured_models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5-5'] },
        { slug: 'openai-codex', name: 'OpenAI Codex', authenticated: true, auth_type: 'oauth_external', featured_models: ['gpt-5.4-mini', 'gpt-5.5', 'gpt-6-sol'] },
      ],
    }));
    if (req.url === '/v1/responses') {
      const b = JSON.parse(body);
      asked.push({ provider: b.provider ?? null, model: b.model, effort: b.model_options?.reasoning_effort });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      if (failNext) { const m = failNext === true ? 'the answer came back malformed' : failNext; failNext = false; send('response.failed', { response: { error: { message: m } } }); return res.end(); }
      send('response.output_text.delta', { delta: 'done' });
      send('response.output_item.done', { item: { type: 'message', content: [{ text: 'done' }] } });
      send('response.completed', { response: { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } });
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
  const signIn = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com' }) });
  assert.equal(signIn.status, 200, await signIn.text());
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const api = async (method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const { json: { bots } } = await api('GET', '/bots');
  const bot = bots.find((b) => b.isPrimary);
  assert.ok(bot, 'the account has a primary bot');
  const say = async (text) => {
    const before = asked.length;
    const r = await api('POST', `/bots/${bot.id}/messages`, { text });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    for (let i = 0; asked.length === before; i++) { if (i > 150) throw new Error(`no turn reached Hermes:\n${log.slice(-2000)}`); await sleep(100); }
    await sleep(300);
    return asked[asked.length - 1];
  };

  await test('new bots start in manual mode', async () => {
    assert.equal(bot.modelMode, 'manual');
    const { json } = await api('GET', `/bots/${bot.id}/engine`);
    assert.equal(json.engine.modelMode, 'manual');
    assert.ok(json.engine.tierPresets.anthropic && json.engine.tierPresets['openai-codex']);
  });

  await test('manual: every turn asks for exactly the chosen provider and model', async () => {
    const r = await api('PATCH', `/bots/${bot.id}/engine`, { provider: 'anthropic', model: 'claude-opus-5-5' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    for (const t of ['thanks', 'Plan and analyze our tax strategy step by step']) {
      const a = await say(t);
      assert.deepEqual([a.provider, a.model], ['anthropic', 'claude-opus-5-5'], t);
    }
  });

  await test('auto needs a provider', async () => {
    const r = await api('PATCH', `/bots/${bot.id}/engine`, { provider: null, modelMode: 'auto' });
    assert.equal(r.status, 400);
  });

  const presets = (await api('GET', `/bots/${bot.id}/engine`)).json.engine.tierPresets;

  await test('auto: light for small talk, heavy for hard work, same provider', async () => {
    const r = await api('PATCH', `/bots/${bot.id}/engine`, { provider: 'anthropic', modelMode: 'auto', modelTiers: presets.anthropic.tiers });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.engine.modelMode, 'auto');
    await api('POST', `/bots/${bot.id}/clear`).catch(() => {});
    const heavy = await say('Plan the migration and analyze the risks step by step');
    assert.deepEqual([heavy.provider, heavy.model, heavy.effort], ['anthropic', 'claude-opus-5-5', 'high']);
    const sticky = await say('thanks');
    assert.equal(sticky.model, 'claude-opus-5-5', 'first lighter turn stays put');
    const light = await say('ok');
    assert.deepEqual([light.provider, light.model, light.effort], ['anthropic', 'claude-haiku-4-5-20251001', 'low']);
  });

  await test('auto: a failed turn makes the next one step up', async () => {
    failNext = true;
    await say('ok');
    const next = await say('cool');
    assert.equal(next.model, 'claude-sonnet-5');
  });

  await test('a sign-in failure does not escalate (a bigger model would not fix it)', async () => {
    await say('ok'); await say('cool');
    failNext = 'No Codex credentials stored. Run `hermes auth add openai-codex`';
    const failed = await say('ok');
    const next = await say('thanks');
    assert.equal(next.model, failed.model, `stayed on ${failed.model}`);
  });

  await test('the panel shows the last route and token usage', async () => {
    const { json } = await api('GET', `/bots/${bot.id}/engine`);
    assert.equal(json.engine.lastRoute.mode, 'auto');
    assert.equal(json.engine.lastRoute.mode, 'auto');
    const u = await api('GET', `/bots/${bot.id}/engine/usage?days=7`);
    assert.equal(u.status, 200);
    const total = u.json.usage.rows.reduce((n, r) => n + r.inputTokens, 0);
    assert.ok(total >= 600, `input tokens counted (${total})`);
  });

  await test('provider lock: other providers are refused, turns stay on the locked one', async () => {
    let r = await api('PATCH', `/bots/${bot.id}/engine`, { provider: 'openai-codex', model: 'gpt-5.5', modelMode: 'auto', modelTiers: presets['openai-codex'].tiers, providerLock: 'openai-codex' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await api('PATCH', `/bots/${bot.id}/engine`, { provider: 'anthropic' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /locked to openai-codex/);
    const a = await say('Review this contract clause and draft a memo on negotiation strategy');
    assert.deepEqual([a.provider, a.model], ['openai-codex', 'gpt-6-sol']);
  });

  await test('the bot record carries the settings for other clients', async () => {
    const { json } = await api('GET', '/bots');
    const b = json.bots.find((x) => x.id === bot.id);
    assert.deepEqual([b.modelMode, b.providerLock, b.modelTiers.light.model], ['auto', 'openai-codex', 'gpt-5.4-mini']);
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
