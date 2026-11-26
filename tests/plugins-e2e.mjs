// End-to-end check of the plugin routes and the Hermes gate through the real server: owner sign-in,
// propose and confirm a switch and an install, a refused non-owner, and the gate endpoint. Uses a
// throwaway database and the plain plugin fixture. Run after `npm run build -w server`.
//   node tests/plugins-e2e.mjs            (SCREENSHOT=/path.png also saves the Plugins page)
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
fs.writeFileSync(path.join(dir, 'apps.json'), JSON.stringify({ apps: [{ id: 'demo', name: 'Demo CMS', command: process.execPath, args: [path.join(root, 'tests/fixtures/demo-mcp-server.mjs')] }] }));
const work = fs.mkdtempSync(path.join(dir, 'pack-'));
fs.cpSync(path.join(root, 'tests/fixtures/plain-plugin'), path.join(work, 'package'), { recursive: true });
const tgz = path.join(dir, 'plain.tgz');
execFileSync('tar', ['-czf', tgz, '-C', work, 'package']);

const server = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
  cwd: path.join(root, 'server'),
  env: {
    PATH: process.env.PATH, HOME: dir, PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET,
    DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'), HERMES_BIN: '/bin/false', HERMES_URL: 'http://127.0.0.1:9',
    HERMES_HOME_PRIMARY: path.join(dir, 'hermes'), APPS_CONFIG: path.join(dir, 'apps.json'), CLEFTBOT_NO_SCHEDULER: '1',
    OWNER_EMAIL: 'owner@example.com', ALLOWED_EMAILS: 'owner@example.com,other@example.com',
    PLUGINS_DIR: path.join(dir, 'plugins'), PLUGINS_UNSANDBOXED: '1', PLUGINS_ALLOW_LOCAL_TARBALLS: '1',
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
const signIn = async (email) => {
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const r = // A person's sign-in: the owner key makes a link and a browser opens it (a session straight from the
  // owner key is a script's and may not answer approval cards).
  await fetch(`${BASE}${new URL((await (await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email, link: true }) })).json()).url).pathname}`, { redirect: 'manual' });
  assert.equal(r.status, 302, await r.text());
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
};

try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/health`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await new Promise((r) => setTimeout(r, 200)); }
  }
  const cookie = await signIn('owner@example.com');
  const api = async (method, p, body, c = cookie) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie: c, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const { json: { bots } } = await api('GET', '/bots');
  const bot = bots[0];

  await test('the owner proposes and confirms an install; it lands off', async () => {
    const ch = await api('POST', '/plugins/changes', { action: 'install', spec: `file:${tgz}` });
    assert.equal(ch.status, 200, JSON.stringify(ch.json));
    const list = await api('GET', '/plugins');
    assert.equal(list.json.pending[0].id, ch.json.id);
    assert.equal((await api('POST', `/plugins/changes/${ch.json.id}/confirm`, { digest: 'no' })).status, 409);
    const ok = await api('POST', `/plugins/changes/${ch.json.id}/confirm`, { digest: ch.json.digest });
    assert.equal(ok.json.status, 'applied');
    const p = (await api('GET', '/plugins')).json.plugins.find((x) => x.id === 'plain-plugin');
    assert.ok(p.bots.every((b) => !b.enabled));
    assert.equal(p.settings.length, 2);
  });

  await test('switching it on for a bot goes through confirm and shows in the bot\'s tools', async () => {
    const ch = await api('POST', '/plugins/changes', { action: 'enable', pluginId: 'plain-plugin', botId: bot.id });
    await api('POST', `/plugins/changes/${ch.json.id}/confirm`, { digest: ch.json.digest });
    const token = crypto.createHmac('sha256', SECRET).update(`mcp:${bot.id}`).digest('hex');
    const r = await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const names = (await r.json()).result.tools.map((t) => t.name);
    assert.ok(names.includes('plain-plugin__echo'), names.join(','));
  });

  await test('settings: saved by the owner, secrets never sent back', async () => {
    const r = await api('PUT', '/plugins/plain-plugin/settings', { greeting: 'hi', api_key: 's3cret' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.values, { greeting: 'hi', api_key: { set: true } });
    assert.ok(!JSON.stringify((await api('GET', '/plugins')).json).includes('s3cret'));
  });

  await test('another account cannot change plugins', async () => {
    const other = await signIn('other@example.com');
    const r = await api('POST', '/plugins/changes', { action: 'disable', pluginId: 'demo', botId: bot.id }, other);
    assert.equal(r.status, 403);
    assert.equal((await api('PUT', '/plugins/plain-plugin/settings', { greeting: 'x' }, other)).status, 403);
  });

  await test('the Hermes gate: read-only tools pass, wrong token refused, others wait for a card', async () => {
    // The primary Hermes is shared with Telegram and the like: outside an app turn the gate stays out of the way.
    const ptoken = crypto.createHmac('sha256', SECRET).update(`mcp:${bot.id}`).digest('hex');
    const p = await (await fetch(`${BASE}/mcp/${bot.id}/gate`, { method: 'POST', headers: { authorization: `Bearer ${ptoken}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'terminal', args: {} }) })).json();
    assert.equal(p.action, bot.isPrimary ? 'allow' : 'block');
    const made = await api('POST', '/bots', { name: 'Gatekeeper', avatarShape: bots[0].avatarShape, avatarColor: bots[0].avatarColor, mode: bots[0].mode });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const gbot = made.json.bot;
    const token = crypto.createHmac('sha256', SECRET).update(`mcp:${gbot.id}`).digest('hex');
    const gate = (tool, tok = token, signal) => fetch(`${BASE}/mcp/${gbot.id}/gate`, { method: 'POST', signal, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool, args: {} }) });
    assert.deepEqual(await (await gate('read_file')).json(), { action: 'allow' });
    assert.equal((await gate('read_file', 'nope')).status, 401);
    const pending = gate('terminal');
    let card;
    for (let i = 0; i < 50 && !card; i++) {
      await new Promise((r) => setTimeout(r, 100));
      card = (await api('GET', `/bots/${gbot.id}/rows`)).json.rows.find((r) => r.body?.card === 'approval' && r.body.tool === 'hermes__terminal');
    }
    assert.ok(card, 'an approval card appeared');
    await api('POST', `/approvals/${card.body.approvalId}`, { decision: 'deny', digest: card.body.digest });
    const answer = await (await pending).json();
    assert.equal(answer.action, 'block');
  });

  await test('a plugin made with a bot: plan over /mcp, Build by the owner, files over /mcp, Install', async () => {
    const token = crypto.createHmac('sha256', SECRET).update(`mcp:${bot.id}`).digest('hex');
    const call = async (name, args) => (await (await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result.content[0].text;
    const out = await call('propose_plugin', { title: 'Weather', purpose: 'Look up the weather for a city.', tools: [{ name: 'forecast', description: 'Forecast for a city', writes: false }], network: [] });
    const draftId = out.match(/draft (pdr_[\w-]+)/)[1];
    const files = {
      'package.json': JSON.stringify({ name: 'weather-plugin', version: '1.0.0', type: 'module', main: 'index.mjs' }),
      'index.mjs': "import { serve } from './cleftbot-mcp.mjs';\nserve({ name: 'weather', tools: [{ name: 'forecast', description: 'Forecast', readOnly: true, run: async ({ city }) => `sunny in ${city}` }] });\n",
    };
    assert.match(await call('submit_plugin_draft', { draft_id: draftId, files }), /not pressed Build/);
    const other = await signIn('other@example.com');
    assert.equal((await api('POST', `/plugins/drafts/${draftId}/build`, undefined, other)).status, 403);
    assert.equal((await api('POST', `/plugins/drafts/${draftId}/build`)).status, 200);
    assert.match(await call('submit_plugin_draft', { draft_id: draftId, files }), /All checks passed/);
    const review = (await api('GET', `/bots/${bot.id}/rows`)).json.rows.filter((r) => r.body?.card === 'plugin-review').pop();
    // The owner reads the code before Install; nobody else can.
    const code = await api('GET', `/plugins/drafts/${draftId}/files`);
    assert.equal(code.status, 200);
    assert.equal(code.json.digest, review.body.digest);
    assert.equal(code.json.matches, true);
    assert.equal(code.json.files.find((f) => f.path === 'index.mjs').text, files['index.mjs']);
    assert.equal(code.json.files.find((f) => f.path === 'cleftbot-mcp.mjs').text, null);
    assert.equal((await api('GET', `/plugins/drafts/${draftId}/files`, undefined, other)).status, 403);
    assert.equal((await api('POST', `/plugins/drafts/${draftId}/install`, { digest: review.body.digest })).status, 200);
    const list = (await api('GET', '/plugins')).json;
    assert.equal(list.drafts[0].status, 'installed');
    assert.ok(list.plugins.some((p) => p.id === 'weather-plugin'));
  });

  await test('the owner\'s switch applies at once, reads back, and Undo can go back to the default', async () => {
    const before = (await api('GET', '/plugins')).json.plugins.find((p) => p.id === 'demo').bots.find((b) => b.id === bot.id);
    assert.equal(before.fromDefault, true);
    const off = await api('POST', '/plugins/switch', { pluginId: 'demo', botId: bot.id, enabled: false });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.deepEqual(off.json.before, { enabled: before.enabled, fromDefault: true });
    assert.deepEqual(off.json.after, { enabled: false, fromDefault: false });
    assert.equal(off.json.pluginName, 'Demo CMS');
    const undo = await api('POST', '/plugins/switch', { pluginId: 'demo', botId: bot.id, enabled: null });
    assert.deepEqual(undo.json.after, { enabled: before.enabled, fromDefault: true });
    assert.equal((await api('POST', '/plugins/switch', { pluginId: 'demo', botId: bot.id })).status, 400);
    assert.equal((await api('POST', '/plugins/switch', { pluginId: 'nope', botId: bot.id, enabled: true })).status, 404);
    // No pending change is left behind for a switch.
    assert.ok(!(await api('GET', '/plugins')).json.pending.some((c) => c.action === 'enable' || c.action === 'disable'));
  });

  await test('another account and a program signed in as the owner cannot switch or delete', async () => {
    const other = await signIn('other@example.com');
    assert.equal((await api('POST', '/plugins/switch', { pluginId: 'demo', botId: bot.id, enabled: false }, other)).status, 403);
    const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
    const r = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', agent: 'Claude: test' }) });
    const script = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const sw = await api('POST', '/plugins/switch', { pluginId: 'demo', botId: bot.id, enabled: false }, script);
    assert.equal(sw.status, 403, JSON.stringify(sw.json));
    // All plugin administration is person-only, including the older two-step and builder routes.
    for (const [method, route, body] of [
      ['POST', '/plugins/changes', { action: 'enable', pluginId: 'demo', botId: bot.id }],
      ['POST', '/plugins/changes/unknown/confirm', { digest: 'unknown' }],
      ['POST', '/plugins/changes/unknown/cancel'],
      ['POST', '/plugins/drafts/unknown/build'],
      ['POST', '/plugins/drafts/unknown/install', { digest: 'unknown' }],
      ['POST', '/plugins/drafts/unknown/dismiss'],
      ['POST', '/plugins/drafts/unknown/undo'],
      ['PUT', '/plugins/plain-plugin/settings', {}],
      ['POST', '/plugins/create', {}],
    ]) {
      assert.equal((await api(method, route, body, script)).status, 403, route);
    }
    assert.equal((await api('GET', '/plugins', undefined, script)).status, 200);
    assert.equal((await api('POST', '/plugins/changes', { action: 'delete', pluginId: 'weather-plugin' }, script)).status, 403);
    const ch = await api('POST', '/plugins/changes', { action: 'delete', pluginId: 'weather-plugin' });
    assert.equal((await api('POST', `/plugins/changes/${ch.json.id}/confirm`, { digest: ch.json.digest }, script)).status, 403);
    await api('POST', `/plugins/changes/${ch.json.id}/cancel`);
    assert.ok((await api('GET', '/plugins')).json.plugins.some((p) => p.id === 'weather-plugin'));
  });

  await test('Delete: built-in plugins refused; an installed one is gone with its files after one confirm', async () => {
    const built = await api('POST', '/plugins/changes', { action: 'delete', pluginId: 'demo' });
    assert.equal(built.status, 409);
    assert.match(built.json.error, /built in.*switched off/i);
    const dirs = () => fs.existsSync(path.join(dir, 'plugins', 'installed')) ? fs.readdirSync(path.join(dir, 'plugins', 'installed')).filter((d) => d.startsWith('weather-plugin@')) : [];
    assert.ok(dirs().length >= 1);
    const ch = await api('POST', '/plugins/changes', { action: 'delete', pluginId: 'weather-plugin' });
    assert.equal(ch.status, 200, JSON.stringify(ch.json));
    assert.equal(ch.json.action, 'delete');
    assert.match(ch.json.details.join(' '), /can't be undone/);
    const done = await api('POST', `/plugins/changes/${ch.json.id}/confirm`, { digest: ch.json.digest });
    assert.equal(done.json.status, 'applied', JSON.stringify(done.json));
    const list = (await api('GET', '/plugins')).json;
    assert.ok(!list.plugins.some((p) => p.id === 'weather-plugin'));
    assert.equal(dirs().length, 0);
    assert.equal(list.drafts.find((d) => d.pluginId === 'weather-plugin' || d.title === 'Weather').status, 'removed');
    assert.equal((await api('POST', '/plugins/changes', { action: 'delete', pluginId: 'weather-plugin' })).status, 404);
  });

  await test('Create plugin: the owner\'s request goes into the bot\'s chat as their message', async () => {
    const other = await signIn('other@example.com');
    assert.equal((await api('POST', '/plugins/create', { botId: bot.id, idea: 'Look up court holidays for a state' }, other)).status, 403);
    assert.equal((await api('POST', '/plugins/create', { botId: bot.id, idea: 'short' })).status, 400);
    assert.equal((await api('POST', '/plugins/create', { botId: 'bot_nope', idea: 'Look up court holidays for a state' })).status, 404);
    const r = await api('POST', '/plugins/create', { botId: bot.id, idea: 'Look up court holidays for a state' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.botId, bot.id);
    const rows = (await api('GET', `/bots/${bot.id}/rows`)).json.rows;
    const msg = rows.filter((x) => x.body?.type === 'message' && x.body.role === 'user').pop();
    assert.match(msg.body.text, /^Please make me a plugin: Look up court holidays for a state/);
    assert.match(msg.body.text, /propose_plugin/);
  });

  if (process.env.SCREENSHOT) {
    const { chromium } = await import('playwright');
    const b = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
    const pg = await b.newPage({ viewport: { width: 1200, height: 900 } });
    await pg.context().addCookies(cookie.split('; ').map((kv) => { const [name, ...v] = kv.split('='); return { name, value: v.join('='), url: BASE }; }));
    await api('POST', '/plugins/changes', { action: 'disable', pluginId: 'plain-plugin', botId: bot.id });
    await pg.goto(BASE);
    await pg.waitForTimeout(1500);
    // The sidebar's Plugins entry opens Settings › Plugins.
    await pg.locator('.sidebar-island', { hasText: 'Plugins' }).click();
    await pg.waitForTimeout(1000);
    await pg.screenshot({ path: process.env.SCREENSHOT, fullPage: true });
    await pg.locator('.plugin-head').first().click();
    await pg.locator('.plugin-body [role=switch]').first().click();
    await pg.waitForTimeout(400);
    await pg.screenshot({ path: process.env.SCREENSHOT.replace(/\.png$/, '-open.png'), fullPage: true });
    await pg.getByRole('button', { name: 'Create plugin', exact: true }).click();
    await pg.locator('#plugin-create-idea').fill('Look up the weather for a city.');
    await pg.waitForTimeout(300);
    await pg.screenshot({ path: process.env.SCREENSHOT.replace(/\.png$/, '-create.png'), fullPage: true });
    await pg.locator('.app-settings').getByRole('button', { name: 'View code' }).first().click();
    await pg.waitForTimeout(800);
    await pg.screenshot({ path: process.env.SCREENSHOT.replace(/\.png$/, '-code.png') });
    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(300);
    await pg.setViewportSize({ width: 390, height: 844 });
    await pg.locator('.app-settings').getByRole('button', { name: 'View code' }).first().click();
    await pg.waitForTimeout(800);
    await pg.screenshot({ path: process.env.SCREENSHOT.replace(/\.png$/, '-code-phone.png') });
    await pg.keyboard.press('Escape');
    await pg.setViewportSize({ width: 1200, height: 900 });
    await pg.waitForTimeout(300);
    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(500);
    await pg.screenshot({ path: process.env.SCREENSHOT.replace(/\.png$/, '-chat.png'), fullPage: false });
    await b.close();
  }
} catch (e) {
  failures++;
  console.log(`FAIL ${e.message}\n${log.slice(-3000)}`);
} finally {
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
