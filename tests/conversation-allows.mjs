// Approvals that know the kind of action, and "Allow for this conversation" (from
// OpenBot's docs/approvals.md). Unit checks of action-kinds.ts and allowed-here.ts (and the Android copy), then
// a real server with a fake Hermes that asks the app's gate before Hermes' send_message, a throwaway database.
// Run after `npm run build -w server`:  node tests/conversation-allows.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-allows-'));
const PORT = 19500 + Math.floor(Math.random() * 400);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake Hermes: "hang" hangs until the app goes away; "gate" asks the app's gate before a terminal call;
// "ask" calls the app's ask_user tool over MCP; anything else answers at once. ----
const seen = [];
let botIdForMcp = null;
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url !== '/v1/responses') { res.statusCode = 404; return res.end('{}'); }
    const b = JSON.parse(body);
    seen.push({ conversation: b.conversation, input: b.input, instructions: b.instructions });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const token = crypto.createHmac('sha256', SECRET).update(`mcp:${botIdForMcp}`).digest('hex');
    if (/gate/.test(b.input)) {
      const args = { target: 'telegram', message: `hello ${b.input.slice(-12)}` };
      send('response.output_item.added', { item: { type: 'function_call', name: 'send_message', call_id: 'c1', arguments: JSON.stringify(args) } });
      await sleep(50);
      const r = await fetch(`${BASE}/mcp/${botIdForMcp}/gate`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'send_message', args }) }).then((x) => x.json()).catch(() => ({ action: 'block' }));
      send('response.output_item.done', { item: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify(r) } });
      send('response.output_text.delta', { delta: `gate said ${r.action}` });
      send('response.output_item.done', { item: { type: 'message', content: [{ text: `gate said ${r.action}` }] } });
      send('response.completed', { response: {} });
      return res.end();
    }
    send('response.output_text.delta', { delta: `answer to ${b.input.slice(-20)}` });
    send('response.output_item.done', { item: { type: 'message', content: [{ text: `answer to ${b.input.slice(-20)}` }] } });
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
    APPS_CONFIG: path.join(dir, 'apps.json'), BOTHQ_NO_SCHEDULER: '1', DEV_LOGIN: '1',
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

// ---------------------------------------------------------------- pure parts
const k = await import('../server/dist/action-kinds.js');
const h = await import('../server/dist/allowed-here.js');

await test('tool names: the first verb decides the kind, never what the tool carries', () => {
  const cases = {
    gmail__delete_message: 'delete', trash_thread: 'delete', 'google__batch_delete_events': 'delete', archive_thread: 'delete', remove_file: 'delete',
    send_gmail_message: 'send', reply_to_thread: 'send', forward_message: 'send', matrix_send_message: 'send', invite_user: 'send',
    share_file: 'share', add_collaborator: 'share', update_permissions: 'share', grant_access: 'share',
    publish_post: 'post', create_post: 'post', tweet: 'post', create_release: 'post',
    place_stock_instruction: 'pay', create_payment: 'pay', transfer_funds: 'pay', refund_charge: 'pay',
    reset_password: 'credentials', rotate_api_key: 'credentials', update_security_settings: 'credentials', delete_api_key: 'credentials',
    list_messages: null, get_thread: null, search_gmail_messages: null, mark_as_spam: null, cancel_scheduled_send: null,
    list_archived: null, unarchive_thread: null, create_draft: null, update_event: null, bookmark_post: null, like_post: null,
    stripe_post_v1_plans_overview: null, actual_budgets_transfer: null, batch_clear_values: null, create_label: null,
  };
  for (const [name, want] of Object.entries(cases)) assert.equal(k.toolKind(name), want, name);
  assert.equal(k.toolKind('hubspot__archive_contact'), 'delete');
  assert.equal(k.toolKind('weird_tool_name', { destructive: true }), 'delete', 'destructiveHint makes a delete');
  assert.equal(k.toolKind('get_thing', { destructive: true }), 'delete');
});

await test('button labels: the label must start with the action', () => {
  const cases = {
    Send: 'send', 'Send now': 'send', 'Send email': 'send', Sent: null, 'Sent mail': null, 'Send $20': null, 'Send money': null,
    Delete: 'delete', 'Yes, delete': 'delete', 'Delete forever': 'delete', 'Move to trash': 'delete', 'Empty trash': 'delete', Remove: 'delete', 'Remove permanently': 'delete',
    'Remove filter': null, 'Remove formatting': null, Discard: 'delete', 'Deleted items': null,
    Share: 'share', Invite: 'share', 'Add people': 'share', 'Shared with me': null,
    Post: 'post', Publish: 'post', 'Go live': 'post', Posts: null, Tweet: 'post',
    'Change password': 'credentials', 'Update your password': 'credentials', 'Turn off two-factor authentication': 'credentials', 'Save': null,
    Comment: 'send', Reply: 'send', Confirm: null, Done: null, Search: null,
  };
  for (const [label, want] of Object.entries(cases)) assert.equal(k.buttonKind(label), want, label);
});

await test('rule keys for a kind on a site', () => {
  assert.equal(k.browserKindKey('send', 'https://www.Mail.Google.com/u/0'), 'browser_kind__send__mail.google.com');
  assert.deepEqual(k.parseBrowserKindKey('browser_kind__delete__drive.google.com'), { kind: 'delete', site: 'drive.google.com' });
  assert.equal(k.parseBrowserKindKey('hermes__terminal'), null);
  assert.match(k.KIND_BUTTON_SOURCE, /needsText/);
  for (const src of Object.values(JSON.parse(k.KIND_BUTTON_SOURCE))) new RegExp(src, 'i'); // every pattern compiles
});

await test('the allowed-here line comes from cards answered for this conversation, and Android has the same copy', () => {
  const rows = [
    { seq: 1, body: { type: 'card', card: 'approval', approvalId: 'a1', status: 'conversation', title: 'Allow Leonard to send a message?' } },
    { seq: 2, body: { type: 'card', card: 'approval', approvalId: 'a2', status: 'always', title: 'Allow Leonard to x?' } },
    { seq: 3, body: { type: 'card', card: 'approval', approvalId: 'a3', status: 'conversation', ruleLabel: 'Send messages on mail.google.com (browser)', title: 'Allow' } },
    { seq: 4, body: { type: 'card', card: 'approval', approvalId: 'a4', status: 'conversation', convOff: 5, title: 'Allow Leonard to y?' } },
    { seq: 5, body: { type: 'message', text: 'hi' } },
  ];
  const list = h.allowedHere(rows);
  assert.deepEqual(list.map((x) => x.label), ['send a message', 'Send messages on mail.google.com (browser)']);
  assert.equal(h.allowedHereLine(list), 'Allowed in this conversation: send a message, Send messages on mail.google.com (browser)');
  assert.equal(h.allowedHereLine([...list, { approvalId: 'z', seq: 9, label: 'z' }]), 'Allowed in this conversation: send a message, Send messages on mail.google.com (browser) and 1 more');
  const mobile = fs.readFileSync(path.join(root, 'mobile/src/allowedHere.ts'), 'utf8');
  assert.equal(mobile, fs.readFileSync(path.join(root, 'server/src/allowed-here.ts'), 'utf8'), 'mobile/src/allowedHere.ts is a word-for-word copy (npm run shared:sync)');
});

// ---------------------------------------------------------------- the server
try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  const signIn = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'owner@example.com' }) });
  assert.equal(signIn.status, 200, await signIn.text());
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const api = async (method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const { json: { bots } } = await api('GET', '/bots');
  const bot = bots.find((b) => b.isPrimary);
  assert.ok(bot, 'the account has a primary bot');
  botIdForMcp = bot.id;
  const rows = async (id) => (await api('GET', `/bots/${id}/rows`)).json.rows;
  const cards = async () => (await rows(bot.id)).filter((x) => x.body.card === 'approval');
  const until = async (what, fn) => {
    for (let i = 0; i < 150; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}\n${log.slice(-1500)}`);
  };
  const idle = () => until('the turn to end', async () => !(await api('GET', '/bots')).json.live.find((l) => l.botId === bot.id)?.isRunning);
  const said = (n) => until(`reply ${n}`, async () => (await rows(bot.id)).filter((r) => r.kind === 'message' && /gate said/.test(JSON.stringify(r.body))).length >= n);

  await test('a send card says what it does and offers Allow for this conversation', async () => {
    await api('POST', `/bots/${bot.id}/messages`, { text: 'gate one' });
    const card = await until('a card', async () => (await cards()).find((c) => c.body.status === 'pending'));
    assert.equal(card.body.kind, 'send');
    assert.equal(card.body.kindName, 'Send');
    assert.match(card.body.kindSays, /sends something to other people/);
    assert.equal(card.body.canAlways, true);
    assert.equal(card.body.canConversation, true);
    assert.equal(card.body.lowRisk, false, 'a kind is never answered from a notification');
    assert.match(card.body.alwaysNote, /Allow for this conversation/);
    // A notification can't give a conversation answer either (it is never lowRisk), and a script never can.
    const d = await api('POST', `/approvals/${card.body.approvalId}`, { decision: 'conversation', digest: card.body.digest });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    assert.equal(d.json.approval.status, 'conversation');
    await said(1); await idle();
    const after = (await cards()).find((c) => c.body.approvalId === card.body.approvalId);
    assert.equal(after.body.status, 'conversation');
    const here = await api('GET', `/bots/${bot.id}/allowed-here`);
    assert.equal(here.json.allowed.length, 1);
    assert.equal(here.json.allowed[0].tool, 'hermes__send_message');
  });

  await test('the same action again in this conversation runs without a card, and is logged', async () => {
    await api('POST', `/bots/${bot.id}/messages`, { text: 'gate two' });
    await said(2); await idle();
    assert.equal((await cards()).length, 1, 'no second card');
    assert.match(JSON.stringify((await rows(bot.id)).at(-1).body), /gate said allow/);
    const log2 = (await api('GET', `/allow-rules?botId=${bot.id}`)).json.log;
    assert.ok(log2.some((l) => String(l.ruleId).startsWith('conv:') && /allowed for this conversation/.test(l.label)), JSON.stringify(log2));
    assert.equal((await api('GET', `/allow-rules?botId=${bot.id}`)).json.rules.length, 0, 'no Always allow rule was made');
  });

  await test('Turn off ends it at once; the card says so', async () => {
    const off = await api('POST', `/bots/${bot.id}/allowed-here/off`, {});
    assert.equal(off.status, 200, JSON.stringify(off.json));
    assert.equal(off.json.turnedOff, 1);
    assert.equal((await cards())[0].body.convOff > 0, true);
    await api('POST', `/bots/${bot.id}/messages`, { text: 'gate three' });
    const card = await until('a new card', async () => (await cards()).find((c) => c.body.status === 'pending'));
    const d = await api('POST', `/approvals/${card.body.approvalId}`, { decision: 'conversation', digest: card.body.digest });
    assert.equal(d.json.approval.status, 'conversation');
    await said(3); await idle();
  });

  await test('a new conversation starts with nothing allowed', async () => {
    const f = await api('POST', `/bots/${bot.id}/fresh`, {});
    assert.equal(f.status, 200, JSON.stringify(f.json));
    assert.equal((await api('GET', `/bots/${bot.id}/allowed-here`)).json.allowed.length, 0);
    await api('POST', `/bots/${bot.id}/messages`, { text: 'gate four' });
    const card = await until('a card in the new conversation', async () => (await cards()).find((c) => c.body.status === 'pending'));
    await api('POST', `/approvals/${card.body.approvalId}`, { decision: 'deny', digest: card.body.digest });
    await until('the reply', async () => (await rows(bot.id)).some((r) => r.kind === 'message' && /gate said block/.test(JSON.stringify(r.body))));
    await idle();
  });

  await test('a script session can neither answer for this conversation nor turn it off', async () => {
    const owner = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'owner@example.com', agent: 'Claude: test' }) }).catch(() => null);
    if (!owner || owner.status !== 200) return; // that sign-in needs a setup this throwaway server may not have
    const c2 = owner.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const r = await fetch(`${BASE}/api/bots/${bot.id}/allowed-here/off`, { method: 'POST', headers: { cookie: c2, 'content-type': 'application/json', origin: BASE }, body: '{}' });
    assert.equal(r.status, 403);
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
