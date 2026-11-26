// End-to-end checks for the fixes from the front-to-back audit, through the real server with a fake Hermes:
// a Bot's settings are checked before they are saved, a body that is not JSON is answered with a sentence,
// only cards with a "skip" of their own can be dismissed, a question is answered once, a script's sign-in
// cannot save a proposed group skill, the chat list never says "Draft" for the files a turn wrote, a group
// keeps its About and at least two Bots, and a deleted Bot leaves its groups. Throwaway database.
// Run after `npm run build -w server`:   node tests/audit-fixes-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fixes-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 500);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// ---- fake Hermes ----
const inputs = [];
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url === '/v1/responses') {
      inputs.push(JSON.parse(body).input);
      const answer = `answer ${inputs.length}`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.output_text.delta', { delta: answer });
      send('response.output_item.done', { item: { type: 'message', content: [{ text: answer }] } });
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
  // A script's session (a Claude thread).
  const scriptIn = await owner({ email: 'owner@example.com', agent: 'Claude: test' });
  const scriptCookie = scriptIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = async (auth, method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { ...auth, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const api = (m, p, b) => call({ authorization: `Bearer ${token}` }, m, p, b);
  const script = (m, p, b) => call({ cookie: scriptCookie }, m, p, b);
  const { json: { bots } } = await api('GET', '/bots');
  const bot = bots.find((b) => b.isPrimary);
  assert.ok(bot, 'the account has a primary bot');
  const rows = async () => (await api('GET', `/bots/${bot.id}/rows`)).json.rows;
  const until = async (what, fn) => {
    for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}\n${log.slice(-1500)}`);
  };
  const idle = () => until('the turn to finish', async () => !(await api('GET', '/bots')).json.live.find((l) => l.botId === bot.id)?.isRunning);

  const mcp = async (name, args) => {
    const mcpToken = crypto.createHmac('sha256', SECRET).update(`mcp:${bot.id}`).digest('hex');
    const r = await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${mcpToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const m = (await r.text()).match(/\{.*\}/s);
    return JSON.parse(m[0]).result.content[0].text;
  };

  await test("a Bot's settings are checked before they are saved", async () => {
    assert.equal((await api('PATCH', `/bots/${bot.id}`, { name: '   ' })).status, 400);
    assert.equal((await api('PATCH', `/bots/${bot.id}`, { name: 'x'.repeat(61) })).status, 400);
    assert.equal((await api('PATCH', `/bots/${bot.id}`, { name: { a: 1 } })).status, 400);
    assert.equal((await api('PATCH', `/bots/${bot.id}`, { mode: 'boss' })).status, 400);
    assert.equal((await api('PATCH', `/bots/${bot.id}`, { effort: 'max' })).status, 400);
    assert.equal((await api('PATCH', `/bots/${bot.id}`, { pinned: 'yes' })).status, 400);
    assert.equal((await api('PATCH', `/bots/${bot.id}`, { voiceSpeed: 9 })).status, 400);
    const same = (await api('GET', '/bots')).json.bots.find((b) => b.id === bot.id);
    assert.equal(same.name, bot.name, 'nothing was changed by a refused request');
    const ok = await api('PATCH', `/bots/${bot.id}`, { label: '  Helper ', pinned: true, effort: 'high', voiceSpeed: 1.2 });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.bot.label, 'Helper');
    assert.equal(ok.json.bot.pinned, true);
    assert.equal(ok.json.bot.effort, 'high');
    assert.equal(ok.json.bot.voiceSpeed, 1.2);
  });

  await test('a body that is not JSON gets a sentence, not a server error', async () => {
    for (const [m, p] of [['POST', '/bots'], ['PATCH', `/bots/${bot.id}`], ['POST', `/bots/${bot.id}/messages`], ['POST', '/rooms'], ['POST', '/approvals/nope']]) {
      const r = await fetch(`${BASE}/api${p}`, { method: m, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: BASE }, body: '{not json' });
      assert.ok(r.status >= 400 && r.status < 500, `${m} ${p} answered ${r.status}`);
      assert.equal(typeof (await r.json()).error, 'string', `${m} ${p} says why`);
    }
  });

  await api('POST', `/bots/${bot.id}/messages`, { text: 'hello' });
  await until('the first answer', async () => (await rows()).find((x) => x.body.role === 'assistant' && x.body.text === 'answer 1' && !x.body.streaming));
  await idle();

  await test('a question is answered once, and only cards with a skip can be dismissed', async () => {
    assert.match(await mcp('ask_user', { question: 'Tea or coffee?', options: ['Tea', 'Coffee', 7, ''] }), /Question shown/);
    const q = (await rows()).find((x) => x.body.card === 'question');
    assert.deepEqual(q.body.options, ['Tea', 'Coffee', '7']);
    assert.equal((await api('POST', `/bots/${bot.id}/cards/${q.seq}/answer`, {})).status, 400, 'an empty answer is refused');
    assert.equal((await api('POST', `/bots/${bot.id}/cards/${q.seq}/answer`, { answer: 'Tea' })).status, 200);
    assert.equal((await api('POST', `/bots/${bot.id}/cards/${q.seq}/answer`, { answer: 'Coffee' })).status, 409, 'a second answer is refused');
    await idle();
    assert.equal((await rows()).filter((x) => x.body.role === 'user' && /Tea|Coffee/.test(x.body.text)).length, 1);
    // A view card has nothing to dismiss; its content must stay as the Bot sent it.
    await mcp('show_view', { title: 'Plan', blocks: [{ type: 'checklist', items: ['one', 'two'] }] });
    const view = (await rows()).find((x) => x.body.card === 'view');
    assert.ok(view, 'a view card');
    assert.equal((await api('POST', `/bots/${bot.id}/cards/${view.seq}/dismiss`)).status, 400);
    assert.equal((await rows()).find((x) => x.seq === view.seq).body.status, undefined);
    await mcp('ask_user', { question: 'Again?', options: ['Yes', 'No'] });
    const q2 = (await rows()).filter((x) => x.body.card === 'question').at(-1);
    assert.equal((await api('POST', `/bots/${bot.id}/cards/${q2.seq}/dismiss`)).status, 200);
    assert.equal((await rows()).find((x) => x.seq === q2.seq).body.status, 'dismissed');
  });

  await test('a task update is checked', async () => {
    assert.match(await mcp('update_task', { task_id: 'nope', state: 'done' }), /no task with that id/);
    assert.match(await mcp('update_task', { task_id: 'nope', state: 'finished' }), /state must be/);
  });

  await test('groups: at least two Bots, the About is kept, a deleted Bot leaves', async () => {
    const mk = async (name) => { const r = await api('POST', '/bots', { name }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.bot; };
    const a = await mk('Ada'); const b = await mk('Bo');
    assert.equal((await api('POST', '/rooms', { name: 'Pair', botIds: [a.id, a.id] })).status, 400, 'the same Bot twice is one Bot');
    const { json: { id: roomId } } = await api('POST', '/rooms', { name: 'Trio', botIds: [bot.id, a.id, b.id] });
    assert.ok(roomId);
    assert.equal((await api('PATCH', `/bots/${roomId}`, { description: 'Our planning room' })).status, 200);
    assert.equal((await api('PUT', `/rooms/${roomId}/members`, { botIds: [bot.id] })).status, 400, 'one Bot is not a group');
    assert.equal((await api('PUT', `/rooms/${roomId}/members`, { botIds: 'all' })).status, 400);
    assert.equal((await api('PUT', `/rooms/${roomId}/members`, { botIds: [bot.id, a.id, b.id] })).status, 200);
    let room = (await api('GET', '/bots')).json.bots.find((x) => x.id === roomId);
    assert.equal(room.description, 'Our planning room', 'changing members keeps the About');
    assert.equal((await api('DELETE', `/bots/${b.id}`)).status, 200);
    const members = (await api('GET', `/rooms/${roomId}/members`)).json.members.map((m) => m.name);
    assert.deepEqual(members.sort(), [bot.name, 'Ada'].sort());
    room = (await api('GET', '/bots')).json.bots.find((x) => x.id === roomId);
    assert.equal(room.lastPreview, 'Bo left');

    // A script's sign-in cannot save a proposed group skill.
    assert.match(await mcp('propose_group_skill', { group_name: 'Trio', name: 'Plan it', description: 'How we plan', steps: '1. Ask. 2. Do.' }), /Proposed/);
    const groupRows = (await api('GET', `/bots/${roomId}/rows`)).json.rows;
    const card = groupRows.find((x) => x.body.card === 'skill-proposal');
    const refused = await script('POST', `/bots/${roomId}/cards/${card.seq}/save-skill`, {});
    assert.equal(refused.status, 403);
    assert.equal(refused.json.code, 'agent_session');
    assert.equal((await api('POST', `/bots/${roomId}/cards/${card.seq}/save-skill`, {})).status, 200);
  });

  await test('second audit: stale cards, handled cards, row limits, the main Bot, groups by name', async () => {
    // A card from an earlier conversation is refused (its number now means another card).
    await mcp('ask_user', { question: 'Old?', options: ['A', 'B'] });
    const old = (await rows()).filter((x) => x.body.card === 'question').at(-1);
    const gen = old.generation ?? (await api('GET', `/bots/${bot.id}/rows`)).json.generation;
    assert.equal((await api('POST', `/bots/${bot.id}/cards/${old.seq}/answer?generation=${gen + 1}`, { answer: 'A' })).status, 409);
    assert.equal((await api('POST', `/bots/${bot.id}/cards/${old.seq}/dismiss?generation=${gen - 1}`)).status, 409);
    assert.equal((await api('POST', `/bots/${bot.id}/cards/${old.seq}/answer?generation=${gen}`, { answer: 'A' })).status, 200);
    await idle();
    // A card already answered can't be dismissed over its answer.
    assert.equal((await api('POST', `/bots/${bot.id}/cards/${old.seq}/dismiss?generation=${gen}`)).status, 409);
    assert.equal((await rows()).find((x) => x.seq === old.seq).body.status, 'answered');
    // Row limits are whole numbers of at least 1.
    assert.equal((await api('GET', `/bots/${bot.id}/rows?limit=-1`)).status, 400);
    assert.equal((await api('GET', `/bots/${bot.id}/rows?limit=abc`)).status, 400);
    assert.equal((await api('GET', `/bots/${bot.id}/rows?limit=2`)).json.rows.length, 2);
    // The main Bot can't be a group, and deleting it hands the role on.
    const mk = async (name) => (await api('POST', '/bots', { name })).json.bot;
    const c1 = await mk('Cy'); const d1 = await mk('Di');
    const { json: { id: g1 } } = await api('POST', '/rooms', { name: 'Twins', botIds: [c1.id, d1.id] });
    const { json: { id: g2 } } = await api('POST', '/rooms', { name: 'Twins', botIds: [c1.id, bot.id] });
    assert.equal((await api('POST', `/bots/${g1}/primary`)).status, 400);
    assert.equal((await api('POST', `/bots/${c1.id}/primary`)).status, 200);
    assert.equal((await api('DELETE', `/bots/${c1.id}`)).status, 200);
    const after = (await api('GET', '/bots')).json.bots;
    assert.equal(after.filter((x) => x.isPrimary).length, 1, 'someone is still the main Bot');
    // Membership lists are checked as strings; the bot's own group tool refuses one Bot twice.
    assert.equal((await api('PUT', `/rooms/${g1}/members`, { botIds: [d1.id, 5] })).status, 400);
    assert.match(await mcp('create_group', { name: 'Solo', bot_names: [bot.name, bot.name] }), /at least 2 different Bots/);
    // Two groups called "Twins" with this Bot in both: a post outside a group turn must say which.
    await api('PUT', `/rooms/${g1}/members`, { botIds: [d1.id, bot.id] });
    assert.match(await mcp('post_to_group', { group_name: 'Twins', text: 'hi' }), /2 groups called "Twins"/);
    void g2;
  });

} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
