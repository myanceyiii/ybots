// End-to-end check of helper (sub-agent) settings through the real server: they are read from and
// written into the primary bot's Hermes config.yaml, with a fake Hermes for the model list.
// Run after `npm run build -w server`:  node tests/helpers-e2e.mjs   (KEEP=1 leaves the server up)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helpers-e2e-'));
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
        { slug: 'openai-codex', name: 'OpenAI Codex', authenticated: true, auth_type: 'oauth_external', featured_models: ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.2-sol'] },
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
fs.mkdirSync(path.join(hermesHome, 'plugins', 'advanced-delegation'), { recursive: true });
fs.writeFileSync(path.join(hermesHome, 'config.yaml'), '# owner comment\nmodel:\n  default: gpt-6.2-sol\n  provider: openai-codex\nagent:\n  disabled_toolsets: [delegation]\nplugins:\n  enabled: [advanced-delegation]\n', { mode: 0o600 });

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
  const signIn = // A person's sign-in: the owner key makes a link and a browser opens it (a session straight from the
  // owner key is a script's and may not answer approval cards).
  await fetch(`${BASE}${new URL((await (await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', link: true }) })).json()).url).pathname}`, { redirect: 'manual' });
  assert.equal(signIn.status, 302, await signIn.text());
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const api = async (method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const { json: { bots } } = await api('GET', '/bots');
  const bot = bots.find((b) => b.isPrimary);
  assert.ok(bot, 'the account has a primary bot');
  await api('PATCH', `/bots/${bot.id}/engine`, { provider: 'openai-codex', model: 'gpt-6.2-sol' });

  await test('reads the primary agent config: off, owner may edit, models listed', async () => {
    const r = await api('GET', `/bots/${bot.id}/helpers`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.helpers.enabled, false);
    assert.equal(r.json.helpers.perJobChoice, true);
    assert.equal(r.json.canEdit, true);
    assert.deepEqual(r.json.models, ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.2-sol']);
    assert.deepEqual(r.json.runs, []);
  });

  await test('saving writes the real config and keeps the owner comment', async () => {
    const r = await api('PUT', `/bots/${bot.id}/helpers`, { enabled: true, maxAtOnce: 4, stepLimit: 60, maxTier: 'standard', defaultTier: 'standard',
      routes: { light: { model: 'gpt-6-luna', effort: null }, standard: { model: 'gpt-6.1-terra', effort: 'medium' }, heavy: { model: 'gpt-6.2-sol', effort: 'high' } } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(Object.keys(r.json.helpers.routes), ['light', 'standard']);
    const text = fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8');
    assert.match(text, /# owner comment/);
    assert.match(text, /name: fast/);
    assert.ok(!/name: deep/.test(text));
    assert.match(text, /subagent_auto_approve: false/);
    assert.match(text, /max_concurrent_children: 4/);
  });

  await test('a model the agent does not list is refused', async () => {
    const r = await api('PUT', `/bots/${bot.id}/helpers`, { enabled: true, maxAtOnce: 4, stepLimit: 60, maxTier: 'heavy', defaultTier: 'light', routes: { heavy: { model: 'gpt-made-up' } } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not in this bot's model list/);
  });

  await test('limits are enforced', async () => {
    const r = await api('PUT', `/bots/${bot.id}/helpers`, { enabled: true, maxAtOnce: 50, stepLimit: 60, maxTier: 'light', routes: { light: { model: 'gpt-6-luna' } } });
    assert.equal(r.status, 400);
  });

  await test('signed out: no access', async () => {
    const r = await fetch(`${BASE}/api/bots/${bot.id}/helpers`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: BASE }, body: '{}' });
    assert.ok(r.status === 401 || r.status === 403, String(r.status));
  });

  if (process.env.KEEP) {
    console.log(`server at ${BASE}  cookie: ${cookie}  bot: ${bot.id}`);
    await new Promise(() => {});
  }
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
