// Shared provider catalog through the app's own routes (GET/PATCH /bots/:id/engine, POST .../engine/check),
// against fake Hermes gateways: the catalog with listed / access / verified for a managed bot and for the
// owner's own agent; the Claude subscription opt-in (owner only, warning accepted, off by default, cannot
// be picked while off, cannot be switched off while in use); explicit fallbacks (managed bots only, never
// the default itself); Check records a verified answer, and a fallback answer is not counted as verified.
// Hermetic. Set SHOT_DIR to also save web screenshots of the Providers section (light and dark).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-catalog-e2e-'));
const PORT = 20000 + Math.floor(Math.random() * 400);
const HERMES_PORT = PORT + 500;
const ENGINE_PORT = PORT + 900;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
const SUB = 'claude-subscription-directsdk-experimental';

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack ?? e.message}`); } };

const asked = [];
let answerWith = null; // model the fake says answered; null = the one asked for
const fake = () => http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url?.startsWith('/api/model/options')) return res.end(JSON.stringify({ model: 'claude-sonnet-5', provider: 'anthropic', providers: [
      { slug: 'anthropic', name: 'Anthropic', authenticated: true, models: ['claude-sonnet-5', 'claude-opus-5-5'] },
      { slug: SUB, name: 'Claude Subscription DirectSDK (Experimental)', auth_type: 'external_process', authenticated: false, models: [], warning: 'run `hermes model` to configure (external_process)' },
      { slug: 'openrouter', name: 'OpenRouter', authenticated: true, models: ['anthropic/claude-haiku-5.5'] },
      { slug: 'openai-codex', name: 'ChatGPT', auth_type: 'oauth_external', authenticated: false, models: [] },
    ] }));
    if (req.url === '/v1/responses') {
      const b = JSON.parse(body || '{}');
      asked.push(b);
      return res.end(JSON.stringify({ status: 'completed', model: answerWith ?? b.model, output_text: 'OK', usage: { input_tokens: 12, output_tokens: 1 } }));
    }
    res.statusCode = 404; res.end('{}');
  });
});
const primaryFake = fake().listen(HERMES_PORT, '127.0.0.1');
const engineFake = fake().listen(ENGINE_PORT, '127.0.0.1');

const hermesHome = path.join(dir, 'hermes');
fs.mkdirSync(hermesHome, { recursive: true });
fs.writeFileSync(path.join(hermesHome, '.env'), 'ANTHROPIC_API_KEY=sk-ant-e2e\nAPI_SERVER_KEY=primary\n');
fs.writeFileSync(path.join(hermesHome, 'config.yaml'), '# owner\'s own\nmodel:\n  default: claude-sonnet-5\n  provider: anthropic\n');
const pluginsDir = path.join(dir, 'provider-plugins');
fs.mkdirSync(path.join(pluginsDir, SUB), { recursive: true });
fs.writeFileSync(path.join(pluginsDir, SUB, 'plugin.yaml'), 'name: fake\nversion: 0.3.4\n');
const server = spawn(process.execPath, ['dist/index.js'], {
  cwd: path.join(root, 'server'),
  env: {
    PATH: process.env.PATH, HOME: dir, PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET,
    ORGO_API_KEY: 'unused', DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'), ENGINE_PORT_BASE: String(ENGINE_PORT),
    HERMES_BIN: '/bin/false', HERMES_URL: `http://127.0.0.1:${HERMES_PORT}`, HERMES_HOME_PRIMARY: hermesHome, HERMES_KEY: 'primary',
    APPS_CONFIG: path.join(dir, 'apps.json'), BOTHQ_NO_SCHEDULER: '1', MAINTAINER_LOG: path.join(dir, 'maint.log'), PRIMARY_BACKUP_DIR: path.join(dir, 'pb'), CLAUDE_LOGIN_DIR: path.join(dir, 'claude-login'), PROVIDER_PLUGINS_DIR: pluginsDir,
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
  const linked = await (await owner({ email: 'owner@example.com', link: true })).json();
  const { token } = await (await fetch(linked.url.replace(/^https?:\/\/[^/]+/, BASE), { headers: { accept: 'application/json' } })).json();
  const api = async (method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const primary = (await api('GET', '/bots')).json.bots.find((b) => b.isPrimary);
  const made = await api('POST', '/bots', { name: 'Testbot', description: 'throwaway' });
  assert.ok(made.json?.bot?.id, `bot created: ${JSON.stringify(made.json)}`);
  const bot = made.json.bot;
  // The managed bot's "gateway" is the fake on ENGINE_PORT; give its home the key so the app adopts it.
  const h = path.join(dir, 'engines', bot.id);
  for (let i = 0; i < 50 && !fs.existsSync(path.join(h, '.env')); i++) await sleep(100);
  await sleep(1500);
  const envText = fs.existsSync(path.join(h, '.env')) ? fs.readFileSync(path.join(h, '.env'), 'utf8') : '';
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(path.join(h, '.env'), envText.replace(/^API_SERVER_KEY=.*$/m, '') + '\nAPI_SERVER_KEY=managed\n');
  await api('POST', `/bots/${bot.id}/engine/restart`);
  const engineOf = async (id) => {
    for (let i = 0; i < 50; i++) { const r = await api('GET', `/bots/${id}/engine`); if (r.json?.engine?.status === 'ready') return r.json.engine; await sleep(200); }
    throw new Error(`engine not ready: ${JSON.stringify((await api('GET', `/bots/${id}/engine`)).json)}\n${log.slice(-2000)}`);
  };

  await test('a managed bot shows the catalog: listed, access and verified kept apart; subscription off', async () => {
    const e = await engineOf(bot.id);
    assert.equal(e.appManaged, true);
    assert.equal(e.subscriptionAllowed, false);
    assert.deepEqual(e.fallbacks, []);
    const by = Object.fromEntries(e.catalog.map((p) => [p.id, p]));
    assert.equal(by.anthropic.access, 'ready');
    assert.equal(by.anthropic.verified, null, 'access is not verification');
    assert.equal(by[SUB].access, 'off');
    assert.ok(by[SUB].warning);
    assert.equal(by['openai-codex'].access, 'not_signed_in');
    const sub = e.providers.find((p) => p.id === SUB);
    assert.ok(sub, 'in the provider picker, labelled off');
    assert.equal(sub.optIn, true);
    assert.equal(sub.enabled, false);
    assert.equal(sub.connected, false, 'never connected while off');
    assert.equal(e.providers.find((p) => p.id === 'anthropic').kind, 'api_key', 'Anthropic is the API-key route');
  });

  await test('the subscription cannot be picked or checked while off', async () => {
    let r = await api('PATCH', `/bots/${bot.id}/engine`, { provider: SUB, model: 'sonnet' });
    assert.equal(r.status, 409);
    r = await api('PATCH', `/bots/${bot.id}/engine`, { fallbacks: [{ provider: SUB, model: 'sonnet' }] });
    assert.equal(r.status, 409);
    r = await api('POST', `/bots/${bot.id}/engine/check`, { provider: SUB, model: 'sonnet' });
    assert.equal(r.status, 409);
    assert.equal(asked.length, 0, 'nothing was sent');
  });

  await test('switching it on needs the warning accepted', async () => {
    let r = await api('PATCH', `/bots/${bot.id}/engine`, { allowSubscription: true });
    assert.equal(r.status, 400);
    r = await api('PATCH', `/bots/${bot.id}/engine`, { allowSubscription: true, acknowledgeSubscriptionTerms: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.engine.subscriptionAllowed, true);
    assert.ok(r.json.engine.catalog, 'the catalog stays on screen while the agent restarts');
    const e = await engineOf(bot.id);
    assert.equal(e.catalog.find((p) => p.id === SUB).access, 'not_signed_in', 'on, but no login: not ready');
    assert.equal(e.providers.find((p) => p.id === SUB).enabled, true, 'now switched on in the picker');
    assert.deepEqual(e.providers.find((p) => p.id === SUB).models, ['sonnet', 'opus', 'haiku']);
  });

  await test('fallbacks are explicit, ordered, and never the default itself', async () => {
    let r = await api('PATCH', `/bots/${bot.id}/engine`, { provider: 'anthropic', model: 'claude-sonnet-5', fallbacks: [{ provider: 'anthropic', model: 'claude-sonnet-5' }] });
    assert.equal(r.status, 400);
    r = await api('PATCH', `/bots/${bot.id}/engine`, { fallbacks: [{ provider: SUB, model: 'sonnet' }, { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.engine.fallbacks, [{ provider: SUB, model: 'sonnet' }, { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }]);
    r = await api('PATCH', `/bots/${bot.id}/engine`, { fallbacks: [{ provider: 'x', model: '' }] });
    assert.equal(r.status, 400);
  });

  await test('it cannot be switched off while a fallback uses it', async () => {
    let r = await api('PATCH', `/bots/${bot.id}/engine`, { allowSubscription: false });
    assert.equal(r.status, 409);
    r = await api('PATCH', `/bots/${bot.id}/engine`, { fallbacks: [{ provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }] });
    assert.equal(r.status, 200);
    r = await api('PATCH', `/bots/${bot.id}/engine`, { allowSubscription: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.engine.subscriptionAllowed, false);
  });

  await test('Check makes one real request through the bot\'s agent, tools refused, nothing stored', async () => {
    const r = await api('POST', `/bots/${bot.id}/engine/check`, { provider: 'anthropic', model: 'claude-sonnet-5' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.result.ok, true);
    const sent = asked.at(-1);
    assert.equal(sent.provider, 'anthropic');
    assert.equal(sent.model, 'claude-sonnet-5');
    assert.equal(sent.store, false);
    const v = r.json.engine.catalog.find((p) => p.id === 'anthropic').verified;
    assert.equal(v.ok, true);
    assert.equal(v.model, 'claude-sonnet-5');
  });

  await test('an answer from another model (a fallback) is not counted as verified', async () => {
    answerWith = 'anthropic/claude-haiku-5.5';
    const r = await api('POST', `/bots/${bot.id}/engine/check`, { provider: 'anthropic', model: 'claude-opus-5-5' });
    answerWith = null;
    assert.equal(r.json.result.ok, false);
    assert.match(r.json.result.detail, /fallback/);
  });

  await test('the owner\'s own agent: same catalog and picker; picking the subscription with the warning switches it on and writes his home', async () => {
    const e = await engineOf(primary.id);
    assert.equal(e.appManaged, true);
    assert.equal(e.catalog.find((p) => p.id === SUB).eligible, true);
    assert.equal(e.providers.find((p) => p.id === SUB).enabled, false);
    let r = await api('PATCH', `/bots/${primary.id}/engine`, { provider: SUB, model: 'sonnet' });
    assert.equal(r.status, 409, 'not while off');
    r = await api('PATCH', `/bots/${primary.id}/engine`, { provider: SUB, model: 'sonnet', allowSubscription: true, acknowledgeSubscriptionTerms: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.engine.subscriptionAllowed, true);
    assert.ok(r.json.engine.restartNote, 'says it restarts when idle');
    const cfgText = fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8');
    assert.match(cfgText, /provider: claude-subscription-directsdk-experimental/);
    assert.doesNotMatch(fs.readFileSync(path.join(hermesHome, '.env'), 'utf8'), /ANTHROPIC_API_KEY/);
    assert.match(fs.readFileSync(path.join(hermesHome, 'auth.json'), 'utf8'), /sk-ant-e2e/);
    r = await api('PATCH', `/bots/${primary.id}/engine`, { fallbacks: [{ provider: 'anthropic', model: 'claude-sonnet-5' }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.engine.fallbacks, [{ provider: 'anthropic', model: 'claude-sonnet-5' }]);
    const m = await engineOf(bot.id);
    assert.equal(m.catalog.find((p) => p.id === 'anthropic').access, 'ready', 'the managed bots still get the shared key');
  });

  if (process.env.SHOT_DIR) {
    await api('PATCH', `/bots/${bot.id}/engine`, { allowSubscription: true, acknowledgeSubscriptionTerms: true });
    await api('PATCH', `/bots/${bot.id}/engine`, { fallbacks: [{ provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }] });
    const { chromium } = await import('playwright');
    const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1600 }, deviceScaleFactor: 2, colorScheme: scheme });
      const link = await (await owner({ email: 'owner@example.com', link: true })).json();
      await page.goto(link.url.replace(/^https?:\/\/[^/]+/, BASE));
      await page.goto(`${BASE}/?bot=${bot.id}&details=1`).catch(() => {});
      await page.waitForTimeout(1500);
      const sel = page.locator('.providers');
      if (await sel.count()) await sel.first().screenshot({ path: path.join(process.env.SHOT_DIR, `providers-${scheme}.png`) });
      else await page.screenshot({ path: path.join(process.env.SHOT_DIR, `providers-page-${scheme}.png`) });
      await page.close();
    }
    await browser.close();
  }
} catch (e) {
  failures++;
  console.log(`FAIL setup\n     ${e.stack ?? e.message}\n${log.slice(-3000)}`);
} finally {
  server.kill();
  primaryFake.close(); engineFake.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
