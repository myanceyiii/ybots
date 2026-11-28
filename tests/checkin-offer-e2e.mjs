// End-to-end check of the check-in offer card (server/src/checkin-offer.ts) through the real server:
// offer_check_in over /mcp draws "Keep an eye on X?" buttons; a tap makes one quiet, read-only routine for the
// bot and posts no chat message and starts no turn; Not now makes nothing; a second offer for the same thing is
// refused; bad input is refused. Throwaway database; needs no Hermes.  Run after `npm run build -w server`:
//   node tests/checkin-offer-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-offer-e2e-'));
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

  const tool = async (name, args) => {
    const r = await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }) });
    return (await r.json()).result?.content?.[0]?.text ?? '';
  };
  const offers = async () => (await rows()).filter((r) => r.body.card === 'view' && r.body.quick && r.body.checkin);
  const userMsgs = async () => (await rows()).filter((r) => r.body.type === 'message' && r.body.role === 'user');
  const routines = async () => (await api('GET', `/bots/${bot.id}/routines`)).json;
  const pick = (seq, i) => api('POST', `/bots/${bot.id}/cards/${seq}/view`, { op: 'pick', block: 'c', picked: [i] });

  await test('bots are offered offer_check_in over /mcp', async () => {
    const list = await mcp('tools/list');
    assert.ok(list.result.tools.some((t) => t.name === 'offer_check_in'));
  });

  await test('bad offers are refused', async () => {
    assert.match(await tool('offer_check_in', {}), /^Not shown: give a subject/);
    assert.match(await tool('offer_check_in', { subject: 'Inbox', link: 'http://example.com' }), /https/);
    assert.match(await tool('offer_check_in', { subject: 'Inbox', timezone: 'Mars/Base' }), /not a timezone/);
    assert.equal((await offers()).length, 0);
  });

  let card;
  await test('an offer shows "Keep an eye on X?" with how often and Not now, and no approval', async () => {
    const out = await tool('offer_check_in', { subject: 'Your Gmail inbox', focus: 'replies from the landlord', link: 'https://mail.google.com/', timezone: 'America/Chicago' });
    assert.match(out, /Shown/, out);
    [card] = await offers();
    assert.ok(card);
    const c = card.body.blocks[0];
    assert.equal(c.question, 'Keep an eye on your Gmail inbox?');
    assert.deepEqual(c.options, ['Once a day', 'Twice a day', 'Every 4 hours', 'Not now']);
    assert.deepEqual(card.body.checkin, { subject: 'Your Gmail inbox', focus: 'replies from the landlord', link: 'https://mail.google.com/', timezone: 'America/Chicago' });
    assert.ok(!JSON.stringify(card.body).match(/approvalId|digest/), 'carries no approval');
  });

  await test('a tap makes one quiet read-only routine, posts no message and starts no turn', async () => {
    const before = told.length;
    const msgs = (await userMsgs()).length;
    const r = await pick(card.seq, 1);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const list = await routines();
    const rt = (Array.isArray(list) ? list : list.routines).find((x) => x.name === 'Check on Your Gmail inbox');
    assert.ok(rt, JSON.stringify(list));
    assert.equal(rt.schedule, '0 9,17 * * *');
    assert.equal(rt.timezone, 'America/Chicago');
    assert.equal(rt.enabled, true);
    assert.equal(rt.quiet, true);
    assert.match(rt.prompt, /^\[check-in on\] Your Gmail inbox\nLook for: replies from the landlord\nWhere: https:\/\/mail\.google\.com\//);
    assert.match(rt.prompt, /Only read: never change/);
    const ev = (await rows()).filter((x) => x.body.type === 'event' && x.body.ref === rt.id).at(-1);
    assert.match(ev.body.text, /^Check-in on: Your Gmail inbox · twice a day/);
    assert.equal((await userMsgs()).length, msgs, 'no chat message');
    await sleep(600);
    assert.equal(told.length, before, 'no turn');
    assert.ok((await offers())[0].body.blocks[0].sentAt, 'the card is answered');
    assert.equal((await pick(card.seq, 0)).status, 409, 'a second tap is refused');
  });

  await test('a second offer for the same thing is refused, by subject or by link', async () => {
    assert.match(await tool('offer_check_in', { subject: 'your gmail inbox' }), /already have a check-in/);
    assert.match(await tool('offer_check_in', { subject: 'Mail', link: 'https://mail.google.com/' }), /already have a check-in/);
  });

  await test('Not now makes nothing and says so', async () => {
    const n = (await routines());
    const count = (Array.isArray(n) ? n : n.routines).length;
    assert.match(await tool('offer_check_in', { subject: 'The Chase checking balance' }), /Shown/);
    const c = (await offers()).at(-1);
    assert.equal((await pick(c.seq, 3)).status, 200);
    const after = await routines();
    assert.equal((Array.isArray(after) ? after : after.routines).length, count);
    assert.match((await rows()).filter((x) => x.body.type === 'event').at(-1).body.text, /^No check-in on The Chase checking balance/);
  });

  await test('offers during a turn wait under the reply, and stop the guessed buttons', async () => {
    const n = (await offers()).length;
    reply = 'Your calendar has three things tomorrow. Should I move the dentist?';
    duringTurn = async () => assert.match(await tool('offer_check_in', { subject: 'Your calendar' }), /when you finish/);
    await api('POST', `/bots/${bot.id}/messages`, { text: 'calendar?' });
    await until('the held offer', async () => (await offers()).length > n);
    await sleep(400);
    const all = await rows();
    const lastMsg = all.filter((r) => r.body.type === 'message' && r.body.role === 'assistant').at(-1);
    const offer = (await offers()).at(-1);
    assert.ok(offer.seq > lastMsg.seq, 'under the reply');
    assert.equal(all.filter((r) => r.body.card === 'view' && r.body.quick && !r.body.checkin && r.seq > lastMsg.seq).length, 0, 'no guessed Yes/No as well');
  });

  // SHOTS=<dir>: pictures of the card in the web app (light and dark), for the PR. Needs `npm run build -w web`.
  if (process.env.SHOTS) {
    const { chromium } = (await import('node:module')).createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
    try {
      for (const scheme of ['light', 'dark']) {
        const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2, colorScheme: scheme });
        await ctx.addCookies(cookie.split('; ').map((c) => { const [n, ...v] = c.split('='); return { name: n, value: v.join('='), url: BASE }; }));
        const page = await ctx.newPage();
        await page.goto(BASE);
        await page.locator('[data-checkin-offer]').last().waitFor({ timeout: 15000 });
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(process.env.SHOTS, `web-${scheme}.png`) });
        await ctx.close();
      }
    } finally { await browser.close(); }
  }
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}`);
} finally {
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
