// End-to-end check of choice buttons (server/src/choices.ts) through the real server: offer_choices over /mcp,
// a tap posting the answer as the person's message (with the question for the bot), no second tap, "Other",
// the fallback that spots an obvious question at the end of a reply, groups (@mention and who pressed),
// list previews and the phone notice. Throwaway database; needs no Hermes.  Run after `npm run build -w server`:
//   node tests/choices-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'choices-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 500);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// ---- fake Hermes: every turn answers "ok" at once and records what it was told ----
const told = [];
let reply = 'ok';
let duringTurn = null;
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url === '/v1/responses') {
      told.push(body);
      if (duringTurn) { const f = duringTurn; duringTurn = null; await f(); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.output_text.delta', { delta: reply });
      send('response.output_item.done', { item: { type: 'message', content: [{ text: reply }] } });
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
  const rows = async () => (await api('GET', `/bots/${bot.id}/rows`)).json.rows;
  const until = async (what, fn) => {
    for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}\n${log.slice(-1500)}`);
  };
  const token = crypto.createHmac('sha256', SECRET).update(`mcp:${bot.id}`).digest('hex');
  let rpc = 0;
  const mcp = async (method, params) => {
    const r = await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, params }) });
    return r.json();
  };
  const call = async (args) => (await mcp('tools/call', { name: 'show_view', arguments: args })).result?.content?.[0]?.text ?? '';


  const tool = async (name, args, id = bot.id, tok = token) => {
    const r = await fetch(`${BASE}/mcp/${id}`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }) });
    return (await r.json()).result?.content?.[0]?.text ?? '';
  };
  const quick = async (id = bot.id) => (await api('GET', `/bots/${id}/rows`)).json.rows.filter((r) => r.body.card === 'view' && r.body.quick);
  const userMsgs = async (id = bot.id) => (await api('GET', `/bots/${id}/rows`)).json.rows.filter((r) => r.body.type === 'message' && r.body.role === 'user').map((r) => r.body.text);
  const pick = (seq, b, id = bot.id) => api('POST', `/bots/${id}/cards/${seq}/view`, b);

  await test('bots are offered offer_choices over /mcp', async () => {
    const list = await mcp('tools/list');
    assert.ok(list.result.tools.some((t) => t.name === 'offer_choices'));
  });

  await test('bad choices are refused', async () => {
    assert.match(await tool('offer_choices', { question: 'Q?', options: ['a'] }), /^Not shown/);
    assert.match(await tool('offer_choices', { question: 'Q?', options: ['a', 'b', 'c', 'd', 'e'] }), /^Not shown/);
    assert.equal((await quick()).length, 0);
  });

  let card;
  await test('offer_choices with no turn running shows the buttons at once', async () => {
    const out = await tool('offer_choices', { question: 'Delete the $813.87 PayPal entry?', options: ['Yes', 'No'] });
    assert.match(out, /Shown/, out);
    [card] = await quick();
    assert.ok(card);
    assert.deepEqual(card.body.blocks[0].options, ['Yes', 'No']);
    assert.ok(!card.body.auto);
    assert.ok(!JSON.stringify(card.body).match(/approvalId|digest/), 'carries no approval');
  });

  await test('a tap posts the answer as the person, the bot is told which question, and it locks', async () => {
    const before = told.length;
    reply = 'Done: it is gone.';
    const r = await pick(card.seq, { op: 'pick', block: 'c', picked: [0] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await userMsgs()).at(-1), 'Yes');
    await until('the bot to be told', async () => told.slice(before).some((t) => /\[Answer to \\"Delete the \$813\.87 PayPal entry\?\\"\] Yes/.test(t)));
    const now = (await quick())[0].body.blocks[0];
    assert.ok(now.sentAt);
    assert.deepEqual(now.picked, [0]);
    assert.equal((await pick(card.seq, { op: 'pick', block: 'c', picked: [1] })).status, 409);
  });

  await test('the chat list still shows the bot’s words, not the buttons', async () => {
    await until('the reply', async () => (await api('GET', '/bots')).json.bots.find((b) => b.id === bot.id).lastPreview === 'Done: it is gone.');
  });

  await test('"Other" sends the person’s own words', async () => {
    await tool('offer_choices', { question: 'Which day?', options: ['Tuesday', 'Wednesday'], other: true });
    const c = (await quick()).at(-1);
    assert.equal(c.body.blocks[0].other, true);
    assert.equal((await pick(c.seq, { op: 'pick', block: 'c', text: '  ' })).status, 400);
    assert.equal((await pick(c.seq, { op: 'pick', block: 'c', text: 'Friday after 3' })).status, 200);
    assert.equal((await userMsgs()).at(-1), 'Friday after 3');
    assert.equal((await quick()).at(-1).body.blocks[0].otherText, 'Friday after 3');
  });

  await test('the fallback adds buttons when a reply ends with an obvious question', async () => {
    const n = (await quick()).length;
    reply = 'I found the PayPal charge twice.\n\nShould I hold at $1,000 or budget $1,200?';
    await api('POST', `/bots/${bot.id}/messages`, { text: 'how are groceries?' });
    const got = await until('fallback buttons', async () => { const q = await quick(); return q.length > n && q.at(-1); });
    assert.equal(got.body.auto, true);
    assert.deepEqual(got.body.blocks[0].options, ['Hold at $1,000', 'Budget $1,200']);
    const rows = (await api('GET', `/bots/${bot.id}/rows`)).json.rows;
    const lastMsg = rows.filter((r) => r.body.type === 'message' && r.body.role === 'assistant').at(-1);
    assert.ok(got.seq > lastMsg.seq, 'the buttons sit under the reply');
  });

  await test('buttons offered during a turn wait and sit under the reply; no guessed ones then', async () => {
    const n = (await quick()).length;
    reply = 'Your Chase bill is $82. Should I pay it today or wait for payday?';
    duringTurn = async () => assert.match(await tool('offer_choices', { question: 'Pay it today or wait for payday?', options: ['Pay today', 'Wait for payday'] }), /when you finish/);
    await api('POST', `/bots/${bot.id}/messages`, { text: 'chase bill?' });
    await until('the held buttons', async () => (await quick()).length > n);
    await sleep(500);
    const q = (await quick()).slice(n);
    assert.equal(q.length, 1, 'only the bot’s own buttons, no guessed second set');
    assert.deepEqual(q[0].body.blocks[0].options, ['Pay today', 'Wait for payday']);
    const rows = (await api('GET', `/bots/${bot.id}/rows`)).json.rows;
    const lastMsg = rows.filter((r) => r.body.type === 'message' && r.body.role === 'assistant').at(-1);
    assert.ok(q[0].seq > lastMsg.seq, 'under the reply');
  });

  await test('a display-only view does not hide the set-reply buttons ("Reply \"approve all\" or tell me...")', async () => {
    const n = (await quick()).length;
    reply = 'Morning briefing: three charges to categorize.\n\nReply "approve all" or tell me which numbers to change.';
    duringTurn = async () => assert.match(await tool('show_view', { title: 'Briefing', blocks: [{ type: 'stats', items: [{ label: 'Checking', value: '$100' }] }, { type: 'table', columns: ['A'], rows: [['1']] }] }), /Shown/);
    await api('POST', `/bots/${bot.id}/messages`, { text: 'briefing' });
    const got = await until('set-reply buttons', async () => { const q = await quick(); return q.length > n && q.at(-1); });
    assert.equal(got.body.auto, true);
    assert.deepEqual(got.body.blocks[0].options, ['Approve all']);
    assert.equal(got.body.blocks[0].other, true);
  });

  await test('offer_choices takes one option with an Other box', async () => {
    assert.match(await tool('offer_choices', { question: 'Approve all?', options: ['Approve all'], other: true }), /Shown/);
    const q = (await quick()).at(-1);
    assert.deepEqual(q.body.blocks[0].options, ['Approve all']);
    assert.equal(q.body.blocks[0].other, true);
    assert.match(await tool('offer_choices', { question: 'Approve all?', options: ['Approve all'] }), /at least two/);
  });

  await test('a view that asks something still stands in for guessed buttons', async () => {
    const n = (await quick()).length;
    reply = 'Pick one on the card. Should I hold at $1,000 or budget $1,200?';
    duringTurn = async () => assert.match(await tool('show_view', { blocks: [{ type: 'choice', question: 'Hold or raise?', options: ['Hold', 'Raise'] }] }), /Shown/);
    const before = told.length;
    await api('POST', `/bots/${bot.id}/messages`, { text: 'groceries?' });
    await until('the turn', async () => told.length > before);
    await sleep(800);
    assert.equal((await quick()).length, n);
  });

  await test('no fallback buttons for an open question', async () => {
    const n = (await quick()).length;
    reply = 'What would you like for dinner?';
    const before = told.length;
    await api('POST', `/bots/${bot.id}/messages`, { text: 'dinner?' });
    await until('the turn', async () => told.length > before);
    await sleep(800);
    assert.equal((await quick()).length, n);
  });

  await test('in a group, choices go under the post; a tap @mentions the bot that asked and records who pressed', async () => {
    const made = await api('POST', '/bots', { name: 'Bea' });
    const bea = made.json.bot;
    const room = await api('POST', '/rooms', { name: 'Pair', botIds: [bot.id, bea.id] });
    const roomId = room.json.id;
    const out = await tool('post_to_group', { group_name: 'Pair', text: 'Which plan should we take?', choices: { question: 'Which plan?', options: ['Mint', 'Visible'] } });
    assert.match(out, /^Posted to the group/, out);
    const rows = (await api('GET', `/bots/${roomId}/rows`)).json.rows;
    const msg = rows.findIndex((r) => r.body.type === 'message');
    const c = rows.findIndex((r) => r.body.quick);
    assert.ok(msg >= 0 && c > msg);
    assert.equal(rows[c].body.from.id, bot.id);
    assert.equal((await pick(rows[c].seq, { op: 'pick', block: 'c', picked: [1] }, roomId)).status, 200);
    const me = (await api('GET', '/auth/me')).json;
    const after = (await api('GET', `/bots/${roomId}/rows`)).json.rows;
    const myName = after.find((r) => r.seq === rows[c].seq).body.blocks[0].pickedBy;
    assert.ok(myName, `who pressed is recorded (${JSON.stringify(me)})`);
    assert.equal((await userMsgs(roomId)).at(-1), `@${bot.name} Visible`);
    const fb = await tool('post_to_group', { group_name: 'Pair', text: 'Done. Want me to set up autopay?' });
    assert.match(fb, /^Posted/);
    const q = (await quick(roomId)).at(-1);
    assert.deepEqual(q.body.blocks[0].options, ['Yes', 'No']);
    assert.equal(q.body.auto, true);
    const bad = await tool('post_to_group', { group_name: 'Pair', text: 'x', choices: { question: 'Q', options: ['one'] } });
    assert.match(bad, /^Not posted/);
  });

  await test('the bot cannot press its own buttons', async () => {
    const c = (await quick()).at(-1);
    const r = await fetch(`${BASE}/api/bots/${bot.id}/cards/${c.seq}/view`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'pick', block: 'c', picked: [0] }) });
    assert.ok(r.status === 401 || r.status === 403, `got ${r.status}`);
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
