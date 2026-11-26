// The chat list's "Waiting for you" line clears as soon as the card is answered (Alex, 2026-11-23: Howard's row
// still said "Waiting for you: Allow Howard to run code?" while Howard worked after every card was approved).
// Real server, fake Hermes that asks the app's gate; a throwaway database.  Run after `npm run build -w server`:
//   node tests/approval-preview-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-preview-e2e-'));
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
    if (/hang/.test(b.input)) { send('response.output_text.delta', { delta: 'Working on it' }); return; }
    if (/gate/.test(b.input)) {
      const args = { command: `rm -rf /tmp/${b.conversation}` };
      send('response.output_item.added', { item: { type: 'function_call', name: 'terminal', call_id: 'c1', arguments: JSON.stringify(args) } });
      await sleep(100);
      const r = await fetch(`${BASE}/mcp/${botIdForMcp}/gate`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'terminal', args }) }).then((x) => x.json()).catch(() => ({ action: 'block' }));
      send('response.output_item.done', { item: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify(r) } });
      // "slow": after the card, keep working with tool calls only, as Howard did for minutes; no new message.
      if (/slow/.test(b.input)) { send('response.output_item.added', { item: { type: 'function_call', name: 'read_file', call_id: 'c3', arguments: '{}' } }); return; }
      send('response.output_text.delta', { delta: `gate said ${r.action}` });
      send('response.completed', { response: {} });
      return res.end();
    }
    if (/ask/.test(b.input)) {
      const args = { question: `Which one? (${b.conversation})`, options: ['A', 'B'] };
      send('response.output_item.added', { item: { type: 'function_call', name: 'mcp_hq_ask_user', call_id: 'c2', arguments: JSON.stringify(args) } });
      await sleep(100);
      const r = await fetch(`${BASE}/mcp/${botIdForMcp}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_user', arguments: args } }) }).then((x) => x.json());
      send('response.output_item.done', { item: { type: 'function_call_output', call_id: 'c2', output: r.result?.content?.[0]?.text ?? '' } });
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

try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  // A person's sign-in (only a person may answer a card), on this throwaway server.
  const signIn = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'owner@example.com' }) });
  assert.equal(signIn.status, 200, await signIn.text());
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const api = async (method, p, body) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const { json: { bots } } = await api('GET', '/bots');
  const bot = bots.find((b) => b.isPrimary);
  // Howard's free-run lets every terminal command through (maintainer-guard.ts); these cases need a card.
  { const off = await api('PUT', `/bots/${bot.id}/free-terminal`, { on: false }); assert.equal(off.status, 200, JSON.stringify(off.json)); }
  assert.ok(bot, 'the account has a primary bot');
  botIdForMcp = bot.id;
  const rows = async (id) => (await api('GET', `/bots/${id}/rows`)).json.rows;
  const sides = async () => (await api('GET', `/bots/${bot.id}/side-chats`)).json.chats;
  const until = async (what, fn) => {
    for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(100); }
    throw new Error(`timed out waiting for ${what}\n${log.slice(-1500)}`);
  };

  // The apps' event stream: every 'bot' update for this bot, as the list receives it.
  const pushed = [];
  const stop = new AbortController();
  (async () => {
    const r = await fetch(`${BASE}/api/events`, { headers: { cookie }, signal: stop.signal });
    const reader = r.body.getReader(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += new TextDecoder().decode(value);
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        try { const ev = JSON.parse(data); if (ev.type === 'bot' && ev.bot?.id === bot.id) pushed.push(ev.bot); } catch { /* ping */ }
      }
    }
  })().catch(() => {});
  await sleep(300);

  await test('a pending card shows "Waiting for you", and the row is pushed again once it is answered', async () => {
    await api('POST', `/bots/${bot.id}/messages`, { text: 'gate slow please' });
    const card = await until('a card', async () => (await rows(bot.id)).find((x) => x.body.card === 'approval'));
    const listed = async () => (await api('GET', '/bots')).json.bots.find((b) => b.id === bot.id);
    assert.match((await listed()).lastPreview, /^Waiting for you/);
    await until('the waiting row to reach the apps', async () => pushed.some((b) => /^Waiting for you/.test(b.lastPreview ?? '')));
    const d = await api('POST', `/approvals/${card.body.approvalId}`, { decision: 'allow', digest: card.body.digest });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    // The answer alone must update the list, before the turn writes anything else.
    const after = await until('a pushed row without "Waiting for you"', async () => { const last = pushed.at(-1); return last && !/^Waiting for you/.test(last.lastPreview ?? '') ? last : null; });
    assert.doesNotMatch(after.lastPreview ?? '', /Allow/, 'an answered card is not the line either');
    assert.equal(after.lastPreview, 'You posted last.');
    assert.doesNotMatch((await listed()).lastPreview ?? '', /^Waiting for you/);
    const live = (await api('GET', '/bots')).json.live.find((l) => l.botId === bot.id);
    assert.equal(live.awaiting, null, 'nothing is waiting');
  });

  await test('an expired card clears too', async () => {
    await api('POST', `/bots/${bot.id}/interrupt`);
    await until('the first turn to stop', async () => !(await api('GET', '/bots')).json.live.find((l) => l.botId === bot.id).isRunning);
    await api('POST', `/bots/${bot.id}/messages`, { text: 'gate again' });
    await until('a second card', async () => (await rows(bot.id)).filter((x) => x.body.card === 'approval').length === 2);
    await until('the waiting row', async () => /^Waiting for you/.test(pushed.at(-1)?.lastPreview ?? ''));
    await api('POST', `/bots/${bot.id}/interrupt`);
    await until('a pushed row without "Waiting for you"', async () => !/^Waiting for you/.test(pushed.at(-1)?.lastPreview ?? 'x'));
  });
  stop.abort();
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
