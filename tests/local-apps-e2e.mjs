// End-to-end check of local apps through the real server: sign in with the owner key, then act as
// a bot's Hermes engine on /mcp and check what runs, what waits for an approval card and what is
// refused. Uses the fake MCP server in tests/fixtures and a throwaway database; needs no Hermes,
// Orgo, Composio or xAI. Run after `npm run build -w server`:  node tests/local-apps-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-apps-e2e-'));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
fs.writeFileSync(path.join(dir, 'apps.json'), JSON.stringify({ apps: [{
  id: 'demo', name: 'Demo CMS', command: process.execPath,
  args: [path.join(root, 'tests/fixtures/demo-mcp-server.mjs')], block: ['delete_*'],
}] }));

const server = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
  cwd: path.join(root, 'server'),
  env: {
    PATH: process.env.PATH, HOME: dir,
    PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET,
    ORGO_API_KEY: 'unused', DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'),
    HERMES_BIN: '/bin/false', HERMES_URL: 'http://127.0.0.1:9', HERMES_HOME_PRIMARY: path.join(dir, 'hermes'),
    APPS_CONFIG: path.join(dir, 'apps.json'), CLEFTBOT_NO_SCHEDULER: '1',
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

try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await new Promise((r) => setTimeout(r, 200)); }
  }

  // A person's sign-in, the way scripts/sign-in-link.sh does it: the owner key makes a link, a browser opens it.
  // (A session made straight from the owner key is a script's, and may not answer cards: see below.)
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const owner = (body) => fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const made = await owner({ email: 'owner@example.com', link: true });
  assert.equal(made.status, 200, await made.clone().text());
  const opened = await fetch(`${BASE}${new URL((await made.json()).url).pathname}`, { redirect: 'manual' });
  const cookie = opened.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookie, 'the link signs the browser in');
  const scriptSignIn = await owner({ email: 'owner@example.com', agent: 'Claude: test thread' });
  assert.equal(scriptSignIn.status, 200);
  const scriptCookie = scriptSignIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const asScript = async (method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie: scriptCookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const api = async (method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  const { json: { bots } } = await api('GET', '/bots');
  const bot = bots.find((b) => b.isPrimary);
  assert.ok(bot, 'the account has a primary bot');
  const token = crypto.createHmac('sha256', SECRET).update(`mcp:${bot.id}`).digest('hex');
  let id = 0;
  const mcp = async (method, params) => {
    const r = await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    return (await r.json()).result;
  };
  const call = (name, args) => mcp('tools/call', { name, arguments: args });
  const pendingApproval = async () => {
    for (let i = 0; i < 50; i++) {
      const { json } = await api('GET', `/bots/${bot.id}/rows`);
      const card = (json.rows ?? []).map((r) => r.body).find((b) => b.type === 'card' && b.card === 'approval' && b.status === 'pending');
      if (card) return card;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('no approval card appeared');
  };

  await test('the bot sees the app tools next to the app\'s own', async () => {
    const names = (await mcp('tools/list')).tools.map((t) => t.name);
    for (const n of ['save_file', 'list_apps', 'demo__list_cases', 'demo__send_note', 'demo__delete_case']) assert.ok(names.includes(n), `missing ${n}`);
    assert.ok(!names.includes('x_search'), 'x_search is offered without an xAI key');
    assert.ok(!names.some((n) => /composio|request_app_connection|event_routine|event_triggers/i.test(n)), 'a Composio tool is still offered');
  });

  await test('a read-only tool runs without asking', async () => {
    const r = await call('demo__list_cases', {});
    assert.match(r.content[0].text, /C-1/);
  });

  await test('a blocked tool is refused', async () => {
    const r = await call('demo__delete_case', { id: 'C-1' });
    assert.match(r.content[0].text, /declined/);
  });

  await test('an unknown tool is refused', async () => {
    const r = await call('demo__not_a_tool', {});
    assert.match(r.content[0].text, /declined/);
  });

  await test('a write waits for an approval card that shows the nested fields, and runs once allowed', async () => {
    const pending = call('demo__send_note', { to: 'jane@example.com', message: { subject: 'Hearing moved', body: 'Now on the 14th' } });
    const card = await pendingApproval();
    assert.match(card.title, /send note/i);
    assert.equal(card.toolkitName, 'Demo CMS');
    assert.match(card.detail, /message\.subject: Hearing moved/);
    assert.equal((await api('POST', `/approvals/${card.approvalId}`, { decision: 'allow' })).status, 400);
    assert.equal((await api('POST', `/approvals/${card.approvalId}`, { decision: 'allow', digest: 'stale' })).status, 409);
    assert.equal((await api('POST', `/approvals/${card.approvalId}`, { decision: 'allow', digest: card.digest })).status, 200);
    const r = await pending;
    assert.match(r.content[0].text, /^\[Approval card shown and allowed \(.+, web\)\.\]\nsent "Hearing moved" to jane@example\.com$/);
    const answered = (await api('GET', `/bots/${bot.id}/rows`)).json.rows.map((x) => x.body).find((b) => b.approvalId === card.approvalId);
    assert.equal(`${answered.status} ${answered.answeredVia}`, 'allowed web');
    assert.ok(answered.answeredBy, 'the card says who answered');
  });

  await test('a script signed in to the account cannot answer a card, and what it writes is labelled as its own', async () => {
    const pending = call('demo__send_note', { to: 'x', message: { subject: 's', body: 'b' } });
    const card = await pendingApproval();
    const tried = await asScript('POST', `/approvals/${card.approvalId}`, { decision: 'allow' });
    assert.equal(tried.status, 403);
    assert.equal(tried.json.code, 'agent_session');
    assert.equal((await pendingApproval()).approvalId, card.approvalId, 'the card is still waiting');
    await api('POST', `/approvals/${card.approvalId}`, { decision: 'deny', digest: card.digest });
    assert.match((await pending).content[0].text, /declined this action on its approval card \(.+, web\)/);
    assert.equal((await asScript('POST', `/bots/${bot.id}/messages`, { text: 'hello from a test' })).status, 200);
    const msg = (await api('GET', `/bots/${bot.id}/rows`)).json.rows.map((x) => x.body).filter((b) => b.type === 'message' && b.role === 'user').at(-1);
    assert.equal(`${msg.text} | ${msg.from?.kind} | ${msg.from?.name}`, 'hello from a test | agent | Claude: test thread');
    // An unnamed owner-key session is a script too.
    const plain = (await owner({ email: 'owner@example.com' })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const r = await fetch(`${BASE}/api/approvals/apr_none`, { method: 'POST', headers: { cookie: plain, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'deny' }) });
    assert.equal(r.status, 403);
  });

  await test('a denied write does not run', async () => {
    const pending = call('demo__send_note', { to: 'x', message: { subject: 's', body: 'b' } });
    const card = await pendingApproval();
    await api('POST', `/approvals/${card.approvalId}`, { decision: 'deny', digest: card.digest });
    assert.match((await pending).content[0].text, /declined/);
  });

  await test('the phone app (a bearer token) answers with the card digest and gets a read-back; a send card warns next to "Always allow"', async () => {
    const { url } = await (await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', link: true }) })).json();
    const { token: phone } = await (await fetch(`${BASE}${new URL(url).pathname}`, { headers: { accept: 'application/json' } })).json();
    assert.ok(phone, 'a phone token');
    const answer = (approvalId, body) => fetch(`${BASE}/api/approvals/${approvalId}`, { method: 'POST', headers: { authorization: `Bearer ${phone}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const pending = call('demo__send_note', { to: 'phone@example.com', message: { subject: 'From the phone', body: 'b' } });
    const card = await pendingApproval();
    assert.match(card.digest, /^[0-9a-f]{64}$/);
    assert.equal(card.canAlways, true, 'offered: the owner decides');
    assert.equal(card.lowRisk, false);
    assert.equal(card.risk, 'message');
    assert.match(card.alwaysNote, /send messages/);
    assert.equal((await answer(card.approvalId, { decision: 'allow' })).status, 400, 'no digest');
    const wrong = await answer(card.approvalId, { decision: 'allow', digest: '0'.repeat(64) });
    assert.equal(wrong.status, 409, 'wrong digest');
    assert.equal((await wrong.json()).code, 'digest_mismatch');
    const ok = await answer(card.approvalId, { decision: 'allow', digest: card.digest });
    assert.equal(ok.status, 200, 'right digest');
    const { approval } = await ok.json();
    assert.equal(approval.id, card.approvalId);
    assert.equal(approval.status, 'allowed');
    assert.equal(approval.tool, card.tool);
    assert.ok(approval.resolvedAt > 0, 'resolvedAt');
    assert.equal((await pending).content[0].text, '[Approval card shown and allowed (owner, phone app).]\nsent "From the phone" to phone@example.com');
    const again = await answer(card.approvalId, { decision: 'deny', digest: card.digest });
    assert.equal(again.status, 409, 'answering twice');
    assert.equal((await again.json()).approval.status, 'allowed');
    const { json } = await api('GET', '/policies');
    assert.deepEqual(json.policies, [], 'nothing stored as always allowed');
  });

  await test('"Always allow" from the phone (with the digest) makes a rule for this bot, listed with who made it, and its uses are logged', async () => {
    const { url } = await (await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', link: true }) })).json();
    const { token: phone } = await (await fetch(`${BASE}${new URL(url).pathname}`, { headers: { accept: 'application/json' } })).json();
    const first = call('DEMO__TAG_CASE', { id: 'C-1', tag: 'urgent' });
    const card = await pendingApproval();
    assert.equal(card.canAlways, true);
    const r = await fetch(`${BASE}/api/approvals/${card.approvalId}`, { method: 'POST', headers: { authorization: `Bearer ${phone}`, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'always', digest: card.digest }) });
    assert.equal(r.status, 200, await r.text());
    assert.equal((await first).content[0].text, '[Approval card shown and allowed (owner, phone app).]\ntagged C-1 urgent');
    const again = await call('demo__tag_case', { id: 'C-2', tag: 'x' });
    assert.equal(again.content[0].text, 'tagged C-2 x', 'ran without a card');
    const { json } = await api('GET', `/allow-rules?botId=${bot.id}`);
    assert.equal(json.rules.length, 1);
    assert.equal(json.rules[0].tool, 'demo__tag_case');
    assert.equal(json.rules[0].botId, bot.id);
    assert.equal(json.rules[0].createdVia, 'phone app');
    assert.equal(json.rules[0].uses, 1);
    assert.equal(json.log.length, 1);
    assert.equal((await api('GET', '/policies')).json.policies.length, 0, 'nothing stored for every bot');
    assert.equal((await api('DELETE', `/allow-rules/${json.rules[0].id}`)).status, 200);
    const asks = call('demo__tag_case', { id: 'C-3', tag: 'y' });
    const card2 = await pendingApproval();
    await api('POST', `/approvals/${card2.approvalId}`, { decision: 'deny', digest: card2.digest });
    assert.match((await asks).content[0].text, /declined/, 'asks again once removed');
  });

  await test('a bot cannot answer a card or make, list or remove a rule with its own token', async () => {
    const asBot = (method, p, body) => fetch(`${BASE}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const pending = call('demo__tag_case', { id: 'C-9', tag: 'z' });
    const card = await pendingApproval();
    assert.equal((await asBot('POST', `/approvals/${card.approvalId}`, { decision: 'always', digest: card.digest })).status, 401);
    assert.equal((await asBot('GET', '/allow-rules')).status, 401);
    assert.equal((await asBot('DELETE', '/allow-rules/alw_x')).status, 401);
    // Nor through its own door: there is no tool for it.
    const names = (await mcp('tools/list')).tools.map((t) => t.name);
    assert.ok(!names.some((n) => /allow|approv|polic|rule/i.test(n)), `a tool that sounds like it: ${names.filter((n) => /allow|approv|polic|rule/i.test(n))}`);
    await api('POST', `/approvals/${card.approvalId}`, { decision: 'deny', digest: card.digest });
    await pending;
    assert.equal((await api('GET', '/allow-rules')).json.rules.length, 0);
  });

  await test('the app list reports the app as running', async () => {
    const { json } = await api('GET', '/apps');
    assert.equal(json.apps.length, 1);
    assert.equal(json.apps[0].slug, 'demo');
    assert.equal(json.apps[0].connected, true);
    assert.equal(json.apps[0].status, 'ready');
  });

  await test('connecting or disconnecting from the browser is refused', async () => {
    assert.equal((await api('POST', '/apps/demo/connect', {})).status, 400);
    assert.equal((await api('DELETE', '/apps/demo')).status, 400);
  });

  await test('Google sign-in is gone: its old address starts no sign-in', async () => {
    const r = await fetch(`${BASE}/api/auth/google/start`, { redirect: 'manual' });
    assert.ok(r.status < 300 || r.status >= 400, `answered ${r.status}`);
    assert.equal(r.headers.get('location'), null);
  });

  await test('the /mcp endpoint refuses a wrong token', async () => {
    const r = await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(r.status, 401);
  });
} catch (e) {
  failures++;
  console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (failures && process.env.SHOW_LOG) console.log(log);
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
