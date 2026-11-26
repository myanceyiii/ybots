// End-to-end check of answer views (server/src/views.ts) through the real server: a bot calls show_view over
// /mcp, bad blocks are dropped and reported, and a person's ticks, picks, form and button go through
// POST /bots/:id/cards/:seq/view (a Send becomes the person's chat message and reaches the bot).
// Throwaway database; needs no Hermes.  Run after `npm run build -w server`:
//   node tests/views-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'views-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 500);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// ---- fake Hermes: every turn answers "ok" at once and records what it was told ----
const told = [];
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url === '/v1/responses') {
      told.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.output_text.delta', { delta: 'ok' });
      send('response.output_item.done', { item: { type: 'message', content: [{ text: 'ok' }] } });
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

  await test('bots are offered show_view over /mcp', async () => {
    const list = await mcp('tools/list');
    assert.ok(list.result.tools.some((t) => t.name === 'show_view'));
  });

  let card;
  await test('a bot shows a view: good blocks kept, bad ones reported, nothing that runs', async () => {
    const out = await call({
      title: 'Phone plans',
      blocks: [
        { type: 'stats', items: [{ label: 'Cheapest', value: '$25', tone: 'good' }, { label: 'Now paying', value: '$70' }] },
        { id: 'plans', type: 'table', columns: ['Plan', 'Price'], rows: [['Mint', '25'], ['Visible', '30'], ['Verizon', '70']] },
        { type: 'chart', chart: 'bar', from: 'plans', title: 'Monthly price' },
        { type: 'checklist', items: [{ text: 'Check coverage' }, { text: 'Port number' }] },
        { id: 'pick', type: 'choice', question: 'Which one?', options: ['Mint', 'Visible'] },
        { id: 'many', type: 'choice', question: 'Extras?', options: ['Hotspot', 'Intl', 'Watch'], multi: true },
        { id: 'f', type: 'form', title: 'Your usage', fields: [{ id: 'gb', label: 'GB a month', kind: 'number' }, { id: 'lines', label: 'Lines', kind: 'number' }] },
        { id: 'go', type: 'button', label: 'Compare more', message: 'Compare three more carriers' },
        { type: 'link', label: 'Mint', url: 'https://www.mintmobile.com' },
        { type: 'link', label: 'bad', url: 'javascript:alert(1)' },
        { type: 'script', code: 'alert(1)' },
        { type: 'html', html: '<img onerror=alert(1)>' },
      ],
    });
    assert.match(out, /^Shown/);
    assert.match(out, /block 10: a link needs an https url/);
    assert.match(out, /block 11: unknown block type "script"/);
    assert.match(out, /block 12: unknown block type "html"/);
    card = (await rows()).find((r) => r.body.type === 'card' && r.body.card === 'view');
    assert.ok(card, 'a view card row was added');
    assert.deepEqual(card.body.blocks.map((b) => b.type), ['stats', 'table', 'chart', 'checklist', 'choice', 'choice', 'form', 'button', 'link']);
    assert.ok(!JSON.stringify(card.body).includes('javascript:'), 'no javascript: URL is stored');
    assert.match(card.body.text, /\*\*Phone plans\*\*/);
    assert.match(card.body.text, /\| Mint \| 25 \|/);
    const bots2 = (await api('GET', '/bots')).json.bots;
    assert.equal(bots2.find((b) => b.id === bot.id).lastPreview, 'Phone plans');
  });

  await test('an empty or all-bad view is refused', async () => {
    assert.match(await call({ blocks: [] }), /Nothing to show/);
    assert.match(await call({ blocks: [{ type: 'script' }] }), /Nothing to show/);
    assert.equal((await rows()).filter((r) => r.body.card === 'view').length, 1);
  });

  const view = (b) => api('POST', `/bots/${bot.id}/cards/${card.seq}/view`, b);
  const current = async () => (await rows()).find((r) => r.seq === card.seq).body;
  const userMsgs = async () => (await rows()).filter((r) => r.body.type === 'message' && r.body.role === 'user').map((r) => r.body.text);

  await test('ticking a checklist only saves state; no message', async () => {
    const before = (await userMsgs()).length;
    const cl = card.body.blocks.find((b) => b.type === 'checklist');
    const r = await view({ op: 'check', block: cl.id, item: cl.items[0].id, done: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await current()).blocks.find((b) => b.id === cl.id).items[0].done, true);
    assert.equal((await userMsgs()).length, before);
  });

  await test('a single pick is sent as the person, once', async () => {
    const turnsBefore = told.length;
    const r = await view({ op: 'pick', block: 'pick', picked: [1] });
    assert.equal(r.status, 200);
    assert.ok((await userMsgs()).includes('Which one? Visible'));
    assert.ok((await current()).blocks.find((b) => b.id === 'pick').sentAt);
    await until('the bot to be told', async () => told.length > turnsBefore && told.slice(turnsBefore).some((t) => t.includes('Which one? Visible')));
    const again = await view({ op: 'pick', block: 'pick', picked: [0] });
    assert.equal(again.status, 409);
  });

  await test('multi picks wait for Send', async () => {
    assert.equal((await view({ op: 'pick', block: 'many', picked: [0, 2, 2, 9] })).status, 200);
    assert.deepEqual((await current()).blocks.find((b) => b.id === 'many').picked, [0, 2]);
    assert.ok(!(await userMsgs()).some((t) => t.startsWith('Extras?')));
    assert.equal((await view({ op: 'send', block: 'many' })).status, 200);
    assert.ok((await userMsgs()).includes('Extras? Hotspot, Watch'));
  });

  await test('a form sends what is in the boxes with Send', async () => {
    await view({ op: 'field', block: 'f', field: 'gb', value: '5' });
    const r = await view({ op: 'send', block: 'f', values: { gb: '8', lines: '2' } });
    assert.equal(r.status, 200);
    assert.ok((await userMsgs()).some((t) => t.startsWith('Your usage ("Phone plans"):') && t.includes('- GB a month: 8') && t.includes('- Lines: 2')));
    assert.equal((await view({ op: 'field', block: 'f', field: 'gb', value: '1' })).status, 409);
  });

  await test('a button sends its message as the person', async () => {
    assert.equal((await view({ op: 'send', block: 'go' })).status, 200);
    assert.ok((await userMsgs()).includes('Compare three more carriers'));
  });

  await test('bad changes are refused without touching the card', async () => {
    const before = JSON.stringify((await current()).blocks);
    assert.equal((await view({ op: 'pick', block: 'nope', picked: [0] })).status, 400);
    assert.equal((await view({ op: 'check', block: 'plans' })).status, 400);
    assert.equal((await view({ op: 'erase', block: 'plans' })).status, 400);
    assert.equal(JSON.stringify((await current()).blocks), before);
  });

  await test('the bot cannot press its own view (route needs a signed-in person)', async () => {
    const r = await fetch(`${BASE}/api/bots/${bot.id}/cards/${card.seq}/view`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'send', block: 'go' }) });
    assert.ok(r.status === 401 || r.status === 403, `got ${r.status}`);
  });

  // ---- phase 2: calculators, update_view, Open as Page, views in groups ----
  const tool = async (name, args) => (await mcp('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  let calcCard, calcViewId;
  await test('a calculator view: formulas checked against its inputs, bad ones reported', async () => {
    const out = await call({
      title: 'Car loan',
      blocks: [
        { id: 'c', type: 'calc', inputs: [
          { id: 'balance', label: 'Balance', kind: 'slider', value: 18000, min: 1000, max: 40000, step: 500, prefix: '$' },
          { id: 'months', label: 'Term', kind: 'choice', value: 48, options: [{ label: '36', value: 36 }, { label: '48', value: 48 }] },
        ], outputs: [
          { id: 'pay', label: 'Monthly', formula: 'balance / months', format: 'money', big: true },
          { id: 'twice', label: 'Twice', formula: 'pay * 2', format: 'money' },
        ] },
        { type: 'calc', inputs: [{ id: 'a', label: 'A', kind: 'number', value: 1 }], outputs: [{ id: 'b', label: 'B', formula: 'a + nope' }] },
        { type: 'calc', inputs: [{ id: 'a', label: 'A', kind: 'number', value: 1 }], outputs: [{ id: 'b', label: 'B', formula: 'alert(1)' }] },
        { id: 'p', type: 'progress', label: 'Checking rates', value: 1, max: 4 },
        { id: 'todo', type: 'checklist', items: [{ text: 'Call the bank' }, { text: 'Sign' }] },
      ],
    });
    assert.match(out, /as view (vw_[0-9a-f]+)/);
    calcViewId = out.match(/as view (vw_[0-9a-f]+)/)[1];
    assert.match(out, /block 2: .*"nope"/);
    assert.match(out, /block 3: .*unknown function "alert"/);
    calcCard = (await rows()).filter((r) => r.body.card === 'view').pop();
    assert.equal(calcCard.body.viewId, calcViewId);
    assert.deepEqual(calcCard.body.blocks.map((b) => b.type), ['calc', 'progress', 'checklist']);
    assert.match(calcCard.body.text, /Monthly: \$375\.00/);
  });

  const viewOn = (b) => api('POST', `/bots/${bot.id}/cards/${calcCard.seq}/view`, b);
  const calcNow = async () => (await rows()).find((r) => r.seq === calcCard.seq).body;
  await test('moving a slider saves clamped values and no message', async () => {
    const before = (await userMsgs()).length;
    const r = await viewOn({ op: 'calc', block: 'c', values: { balance: 99999, months: 37, extra: 5 } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const b = (await calcNow()).blocks.find((x) => x.id === 'c');
    assert.equal(b.values.balance, 40000);
    assert.equal(b.values.months, 48, 'a value that is not one of the options is not kept');
    assert.ok(!('extra' in b.values));
    assert.equal((await userMsgs()).length, before);
  });

  await test("Send these numbers posts the inputs and worked-out answers as the person", async () => {
    const r = await viewOn({ op: 'send', block: 'c', values: { balance: 24000, months: 36 } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const m = (await userMsgs()).find((t) => t.startsWith('Calculator ("Car loan"):'));
    assert.ok(m && m.includes('$24,000') && m.includes('Monthly: $666.67') && m.includes('Twice: $1,333.33'), m);
    assert.equal((await viewOn({ op: 'send', block: 'c', values: { balance: 30000, months: 36 } })).status, 200, 'a calculator can be sent again');
  });

  await test('update_view moves progress and keeps what the person did', async () => {
    await viewOn({ op: 'check', block: 'todo', item: (await calcNow()).blocks.find((x) => x.id === 'todo').items[0].id, done: true });
    const out = await tool('update_view', { view_id: calcViewId, changes: [{ id: 'p', value: 3, note: 'Two banks left' }] });
    assert.match(out, /^Updated/, out);
    const b = await calcNow();
    assert.equal(b.blocks.find((x) => x.id === 'p').value, 3);
    assert.ok(b.updatedAt);
    assert.equal(b.blocks.find((x) => x.id === 'todo').items[0].done, true);
    assert.equal(b.blocks.find((x) => x.id === 'c').values.balance, 30000);
    const out2 = await tool('update_view', { view_id: calcViewId, blocks: [{ id: 'todo', type: 'checklist', items: [{ text: 'Call the bank' }, { text: 'Sign' }, { text: 'Cancel autopay' }] }] });
    assert.match(out2, /^Updated/);
    const b2 = await calcNow();
    assert.deepEqual(b2.blocks.find((x) => x.id === 'todo').items.map((i) => i.done), [true, false, false]);
    assert.match(b2.text, /Cancel autopay/);
  });

  await test('update_view refuses an unknown view or another bot’s', async () => {
    assert.match(await tool('update_view', { view_id: 'vw_0000000000', changes: [] }), /no view|not found|can't|cannot/i);
    const made = await api('POST', '/bots', { name: 'Bea' });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    globalThis.bea = made.json.bot;
    const beaToken = crypto.createHmac('sha256', SECRET).update(`mcp:${bea.id}`).digest('hex');
    const r = await fetch(`${BASE}/mcp/${bea.id}`, { method: 'POST', headers: { authorization: `Bearer ${beaToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_view', arguments: { view_id: calcViewId, title: 'Hijacked' } } }) });
    const text = (await r.json()).result?.content?.[0]?.text ?? '';
    assert.doesNotMatch(text, /^Updated/, text);
    assert.equal((await calcNow()).title, 'Car loan');
  });

  await test('Open as Page makes one Page from the view and returns the same one again', async () => {
    const r = await api('POST', `/bots/${bot.id}/cards/${calcCard.seq}/page`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(r.json.path, /\.page\.json$/);
    const again = await api('POST', `/bots/${bot.id}/cards/${calcCard.seq}/page`, {});
    assert.equal(again.json.path, r.json.path);
    assert.equal((await calcNow()).pagePath, r.json.path);
  });

  await test('the Pages list answers (empty off the bots\' computer, where Pages need local files)', async () => {
    const list = await api('GET', `/bots/${bot.id}/pages/list`);
    assert.equal(list.status, 200, JSON.stringify(list.json));
    assert.ok(Array.isArray(list.json.pages));
  });

  await test('in a group, post_to_group carries a view under the text, named by its bot', async () => {
    const room = await api('POST', '/rooms', { name: 'Pair', botIds: [bot.id, bea.id] });
    assert.equal(room.status, 200, JSON.stringify(room.json));
    const roomId = room.json.id;
    const bad = await tool('post_to_group', { group_name: 'Pair', text: 'Here', view: { blocks: [{ type: 'script' }] } });
    assert.match(bad, /^Not posted/);
    assert.equal((await api('GET', `/bots/${roomId}/rows`)).json.rows.filter((r) => r.body.type === 'message').length, 0, 'nothing posts when the view is bad');
    const out = await tool('post_to_group', { group_name: 'Pair', text: '**Two** plans fit.', view: { title: 'Plans', blocks: [{ type: 'stats', items: [{ label: 'Mint', value: '$25' }] }] } });
    assert.match(out, /^Posted to the group..* as vw_/, out);
    const rr = (await api('GET', `/bots/${roomId}/rows`)).json.rows;
    const msg = rr.findIndex((r) => r.body.type === 'message');
    const vc = rr.findIndex((r) => r.body.card === 'view');
    assert.ok(msg >= 0 && vc > msg, 'the view comes right after the text');
    assert.equal(rr[vc].body.from.id, bot.id);
    const list = (await api('GET', '/bots')).json.bots.find((b) => b.id === roomId);
    assert.equal(list.lastPreview, 'Plans');
    const page = await api('POST', `/bots/${roomId}/cards/${rr[vc].seq}/page`, {});
    assert.ok(page.status >= 400, 'Open as Page is not offered in a group');
  });

  await test('list previews show a bot reply as plain words', async () => {
    await tool('post_to_group', { group_name: 'Pair', text: '**Leonard: money**\n\n- one\n- two' });
    const room = (await api('GET', '/bots')).json.bots.find((b) => b.name === 'Pair');
    assert.match(room.lastPreview, /^\S+: Leonard: money - one - two$/);
    assert.match(room.previewShort, /^\S+ posted last\.$/);
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
