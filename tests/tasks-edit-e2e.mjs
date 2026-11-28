// End-to-end checks for the person's own changes to a bot's tasks (Tasks page and a bot's Tasks tab, all apps):
// rename, note, state, delete with Undo (restore), the "stalled" mark on a working task the bot left behind,
// that another account cannot touch them, and that the bot's update_task cannot bring back a deleted task.
// Throwaway database, fake Hermes. Run after `npm run build -w server`:   node tests/tasks-edit-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-edit-e2e-'));
const PORT = 21000 + Math.floor(Math.random() * 500);
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
  const tokenFor = async (email) => {
    const linked = await (await owner({ email, link: true })).json();
    return (await (await fetch(linked.url.replace(/^https?:\/\/[^/]+/, BASE), { headers: { accept: 'application/json' } })).json()).token;
  };
  const token = await tokenFor('owner@example.com');
  const call = async (tok, method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const api = (m, p, b) => call(token, m, p, b);
  const bot = (await api('GET', '/bots')).json.bots.find((b) => b.isPrimary);
  assert.ok(bot, 'the account has a primary bot');
  const mcp = async (name, args) => {
    const mcpToken = crypto.createHmac('sha256', SECRET).update(`mcp:${bot.id}`).digest('hex');
    const r = await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${mcpToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const m = (await r.text()).match(/\{.*\}/s);
    return JSON.parse(m[0]).result.content[0].text;
  };
  const all = async () => (await api('GET', '/tasks')).json.tasks;
  const mine = async () => (await api('GET', `/bots/${bot.id}/tasks`)).json.tasks;

  const { task_id: id } = JSON.parse(await mcp('create_task', { title: 'Add the systemd list' }));
  assert.ok(id, 'the bot made a task');

  await test('a fresh working task is not marked stalled', async () => {
    const t = (await all()).find((x) => x.id === id);
    assert.equal(t.state, 'working');
    assert.equal(t.stale, undefined);
  });

  await test('a working task untouched for hours while the bot is idle is marked stalled', async () => {
    const { default: Database } = await import(path.join(root, 'node_modules/better-sqlite3/lib/index.js'));
    const db = new Database(path.join(dir, 'test.db'));
    db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(Date.now() - 3 * 24 * 3600_000, id);
    db.close();
    assert.equal((await all()).find((x) => x.id === id).stale, true, 'on the Tasks page');
    assert.equal((await mine()).find((x) => x.id === id).stale, true, "on the bot's Tasks tab");
  });

  await test('the person can rename it, add a note and mark it done', async () => {
    const r = await api('PATCH', `/bots/${bot.id}/tasks/${id}`, { title: '  Systemd timer list  ', note: 'Finished in the app', state: 'done' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.task.title, 'Systemd timer list');
    assert.equal(r.json.task.note, 'Finished in the app');
    assert.equal(r.json.task.state, 'done');
    assert.equal(r.json.task.stale, undefined, 'done is never stalled');
  });

  await test('bad edits are refused with a sentence', async () => {
    for (const body of [{ title: '   ' }, { state: 'gone' }, {}, null]) {
      const r = await api('PATCH', `/bots/${bot.id}/tasks/${id}`, body ?? undefined);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(typeof r.json.error, 'string');
    }
    assert.equal((await api('PATCH', `/bots/${bot.id}/tasks/task_nope`, { state: 'done' })).status, 404);
  });

  await test('another account cannot edit or delete it', async () => {
    const other = await tokenFor('someone@example.com');
    assert.equal((await call(other, 'PATCH', `/bots/${bot.id}/tasks/${id}`, { state: 'working' })).status, 404);
    assert.equal((await call(other, 'DELETE', `/bots/${bot.id}/tasks/${id}`)).status, 404);
    assert.equal((await all()).find((x) => x.id === id).state, 'done');
  });

  let removed;
  await test('delete removes it everywhere and the bot cannot revive it', async () => {
    const r = await api('DELETE', `/bots/${bot.id}/tasks/${id}`);
    assert.equal(r.status, 200);
    removed = r.json.removed;
    assert.equal(removed.title, 'Systemd timer list');
    assert.ok(!(await all()).some((x) => x.id === id));
    assert.ok(!(await mine()).some((x) => x.id === id));
    assert.match(await mcp('update_task', { task_id: id, state: 'working' }), /no task with that id/);
    assert.ok(!(await all()).some((x) => x.id === id));
  });

  await test('Undo puts it back as it was, once', async () => {
    const r = await api('POST', `/bots/${bot.id}/tasks/restore`, removed);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const t = (await all()).find((x) => x.id === id);
    assert.equal(t.title, 'Systemd timer list');
    assert.equal(t.state, 'done');
    assert.equal(t.note, 'Finished in the app');
    assert.equal((await api('POST', `/bots/${bot.id}/tasks/restore`, removed)).status, 409);
    assert.equal((await api('POST', `/bots/${bot.id}/tasks/restore`, { id: 'not a task', title: 'x' })).status, 400);
  });
} finally {
  server.kill();
  hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
