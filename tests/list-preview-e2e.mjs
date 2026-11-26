// End-to-end check of the chat list's line (server/src/list-preview.ts) and AI summaries (list-summary.ts)
// through the real server, with a fake Hermes. Throwaway database.  Run after `npm run build -w server`:
//   node tests/list-preview-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-preview-e2e-'));
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
    if (req.url === '/api/model/options') return res.end(JSON.stringify({ provider: 'openai-codex', model: 'gpt-5.5', providers: [{ slug: 'openai-codex', name: 'ChatGPT', authenticated: true, auth_type: 'oauth', models: ['gpt-5.5', 'gpt-5.4-mini'] }] }));
    if (req.url === '/v1/responses' && JSON.parse(body).stream === false) {
      told.push(body);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '"Comparing phone plans for Sam."' }] }] }));
    }
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
  const { default: Database } = await import(path.join(root, 'node_modules/better-sqlite3/lib/index.js'));
  const db = new Database(path.join(dir, 'test.db'));
  const add = (botId, body, ago = 0) => {
    const b = db.prepare('SELECT generation, next_seq FROM bots WHERE id=?').get(botId);
    db.prepare('UPDATE bots SET next_seq=next_seq+1, rev=rev+1 WHERE id=?').run(botId);
    db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(botId, b.generation, b.next_seq, b.next_seq, body.type === 'card' ? 'card' : 'message', JSON.stringify(body), Date.now() - ago);
  };
  const row = async (id) => (await api('GET', '/bots')).json.bots.find((b) => b.id === id);

  await test("a bot's own reply shows in both whole forms", async () => {
    add(bot.id, { type: 'message', role: 'user', text: 'Which plan?' }, 120_000);
    add(bot.id, { type: 'message', role: 'assistant', text: 'Mint at $25 fits best. Visible is cheaper but slower, and Sam asked for speed on the commute, so I would skip it.' }, 90_000);
    const b = await row(bot.id);
    assert.equal(b.lastPreview, 'Mint at $25 fits best.', 'whole sentences only, never a cut one');
    assert.equal(b.previewBy, 'bot');
    assert.ok(b.previewShort.length <= 48 && !b.previewShort.endsWith('…'), b.previewShort);
  });

  await test('AI summary replaces the reply once turned on, from the cheap model, and goes away when off', async () => {
    const before = (await api('GET', '/list-summary')).json;
    assert.equal(before.prefs.on, false);
    assert.equal(before.options.auto.model, 'gpt-5.4-mini');
    assert.equal((await api('PUT', '/list-summary', { on: true })).status, 200);
    let b;
    for (let i = 0; i < 40; i++) { await sleep(250); b = await row(bot.id); if (b.previewBy === 'summary') break; }
    assert.equal(b.lastPreview, 'Comparing phone plans for Sam');
    const sent = JSON.parse(told.at(-1));
    assert.equal(sent.model, 'gpt-5.4-mini');
    assert.equal(sent.store, false);
    assert.match(sent.input, /Mint at \$25/);
    const calls = told.length;
    await sleep(1500);
    assert.equal(told.length, calls, 'an unchanged chat is not summarized again');
    await api('PUT', '/list-summary', { on: false });
    assert.equal((await row(bot.id)).previewBy, 'bot');
  });

  await test('the model choice is kept', async () => {
    const r = await api('PUT', '/list-summary', { model: 'gpt-5.5', provider: 'openai-codex' });
    assert.deepEqual(r.json.prefs, { on: false, provider: 'openai-codex', model: 'gpt-5.5' });
    assert.equal((await api('PUT', '/list-summary', { model: null })).json.prefs.model, null);
  });

  await test('you posted last', async () => {
    add(bot.id, { type: 'message', role: 'user', text: 'Ok, go with Mint and set it up for both lines please.' });
    const b = await row(bot.id);
    assert.equal(b.lastPreview, 'You posted last.');
    assert.equal(b.previewBy, 'you');
  });

  await test('another bot posted last', async () => {
    add(bot.id, { type: 'message', role: 'user', text: 'The Tasks connector is on now.', from: { kind: 'bot', id: 'x', name: 'Howard' } });
    assert.equal((await row(bot.id)).lastPreview, 'Howard posted last.');
  });

  await test('a pending approval says Waiting for you', async () => {
    add(bot.id, { type: 'card', card: 'approval', approvalId: 'a1', title: 'Allow the bot to run a command on the server', status: 'pending' });
    const b = await row(bot.id);
    assert.equal(b.lastPreview, 'Waiting for you: Allow the bot to run a command on the server');
    assert.equal(b.previewShort, 'Waiting for you.');
  });
  db.close();
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
