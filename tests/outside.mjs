// Checks for outside members and the Slack link (server/src/outside.ts, server/src/slack-link.ts),
// against a fake Slack Web API. Nothing goes to the real Slack.
// Usage: npm run build -w server && node tests/outside.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cleft-outside-'));
process.env.DB_PATH = path.join(TMP, 'db.sqlite');
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.OUTSIDE_BOTS = JSON.stringify({
  'name:Sheldon': { via: 'slack', slackUserId: 'U0SHELDON1', channel: 'C0ASSIST01', channelName: '#assistants', replyMinutes: 75, aliases: { Claude: 'Leonard' } },
  bot_bad: { via: 'slack', slackUserId: 'not an id', channel: 'C0ASSIST01' },
});

// ---------- fake Slack ----------
const calls = [];
const mcpCalls = [];
let mcpFail = false;
let tsN = 1000;
const slack = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/mcp') {
      const m = JSON.parse(body);
      mcpCalls.push({ m, sid: req.headers['mcp-session-id'] ?? null, auth: req.headers.authorization });
      if (m.method === 'initialize') { res.setHeader('Mcp-Session-Id', 'sess-1'); res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {} } })); }
      if (!m.id) { res.statusCode = 202; return res.end(); }
      res.setHeader('Content-Type', 'text/event-stream');
      if (mcpFail) return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'not_allowed' }] } })}\n\n`);
      const ts = `1795500000.${String(tsN++).padStart(6, '0')}`;
      const out = { message_link: `https://example.slack.com/archives/${m.params.arguments.channel_id}/p${ts.replace('.', '')}`, message_context: { message_ts: ts, channel_id: m.params.arguments.channel_id } };
      return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } })}\n\n`);
    }
    const method = req.url.replace(/^\/api\//, '');
    const j = Object.fromEntries(new URLSearchParams(body)); // like Slack's read methods, a JSON body is not read
    calls.push({ method, auth: req.headers.authorization, body: j });
    res.setHeader('Content-Type', 'application/json');
    if (method === 'chat.postMessage') return res.end(JSON.stringify({ ok: true, ts: `1795400000.${tsN++}` }));
    if (method === 'chat.getPermalink' && !j.message_ts) return res.end(JSON.stringify({ ok: false, error: 'invalid_arguments' }));
    if (method === 'chat.getPermalink') return res.end(JSON.stringify({ ok: true, permalink: `https://example.slack.com/archives/${j.channel}/p${j.message_ts.replace('.', '')}` }));
    res.end(JSON.stringify({ ok: false, error: 'unknown_method' }));
  });
});
await new Promise((r) => slack.listen(0, '127.0.0.1', r));
process.env.SLACK_API_URL = `http://127.0.0.1:${slack.address().port}/api`;
process.env.SLACK_MCP_URL = `http://127.0.0.1:${slack.address().port}/mcp`;

const outside = await import('../server/dist/outside.js');
const link = await import('../server/dist/slack-link.js');
const { db } = await import('../server/dist/db.js');
const store = await import('../server/dist/store.js');
link.initSlackLink();
(await import('../server/dist/agent/rooms.js')).initRooms();
(await import('../server/dist/agent/subagents.js')).initSubagents();

const now = Date.now();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'owner@test.invalid', 'Alex Owner', now);
for (const [id, name] of [['b_sheldon', 'Sheldon'], ['b_leonard', 'Leonard'], ['b_robin', 'Robin']]) {
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, 'u1', name, now, now);
}
db.prepare("INSERT INTO bots(id,user_id,name,kind,members,created_at,updated_at) VALUES ('b_team','u1','Team','room',?,?,?)").run(JSON.stringify(['b_leonard', 'b_robin', 'b_sheldon']), now, now);

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`PASS ${name}`); };
const settle = async () => { for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 60)); if (!db.prepare("SELECT 1 FROM outside_messages WHERE state='sending'").get()) return; } };
const woken = [];
const wake = (botId, trig) => woken.push({ botId, trig });

await t('config: by name, bad entries ignored, not a silo or engine bot', async () => {
  assert.equal(outside.isOutside('b_sheldon'), true);
  assert.equal(outside.outsideFor('b_sheldon').channelName, 'assistants');
  assert.equal(outside.isOutside('b_leonard'), false);
  // "Call" goes to ChatGPT: the voice page by default, and only ever to an https ChatGPT link.
  assert.equal(outside.outsideFor('b_sheldon').callUrl, 'https://chatgpt.com/voice');
  assert.equal(outside.callUrlOf('https://chatgpt.com/dots/0000-aaaa~bbbb'), 'https://chatgpt.com/dots/0000-aaaa~bbbb');
  assert.equal(outside.callUrlOf('https://chatgpt.com/g/g-p-abc123/project'), 'https://chatgpt.com/g/g-p-abc123/project');
  for (const bad of ['http://chatgpt.com/voice', 'https://chatgpt.com.evil.example/voice', 'https://evil.example/?chatgpt.com', 'javascript:alert(1)', 'https://u:p@chatgpt.com/', 42])
    assert.equal(outside.callUrlOf(bad), 'https://chatgpt.com/voice');
  assert.equal(outside.isOutside('bot_bad'), false);
  const eng = await import('../server/dist/engine.js');
  assert.equal(eng.engineKind('b_sheldon'), null);
  assert.equal(eng.assignEngine('b_sheldon'), null);
});

await t('outgoing: needs a type, caps length, refuses secrets and balances', async () => {
  assert.deepEqual(outside.checkOutgoing('Q is Alex free Tue at noon?'), { ok: true, type: 'Q', body: 'is Alex free Tue at noon?' });
  assert.equal(outside.checkOutgoing('is he free?', 'q').type, 'Q');
  assert.match(outside.checkOutgoing('is he free?').why, /Start with a type/);
  assert.equal(outside.checkOutgoing('BUY milk').ok, false);
  assert.equal(outside.checkOutgoing('Q ' + 'x'.repeat(1001)).ok, false);
  assert.match(outside.checkOutgoing('FYI card 4111 1111 1111 1111').why, /card/);
  assert.match(outside.checkOutgoing('FYI checking balance is $4,210').why, /balance/);
  assert.match(outside.checkOutgoing('FYI token xoxb-1234567890-abcdef').why, /Slack token/);
  assert.equal(outside.checkOutgoing('FYI heads up @channel').body, 'heads up');
});

await t('format and parse follow the channel rules', async () => {
  assert.equal(outside.formatOutgoing('Leonard', 'Sheldon', 'Q', 'free Tue?', 'U0SHELDON1'), '[Leonard]>@Sheldon Q free Tue? <@U0SHELDON1>');
  assert.deepEqual(outside.parseIncoming('[Sheldon]>@Leonard Q work-cal: anything Tue?'), { to: 'Leonard', type: 'Q', body: 'Q work-cal: anything Tue?' });
  assert.deepEqual(outside.parseIncoming('[Sheldon]>@Hermes A identity: My name is Sheldon.').to, 'Hermes');
  assert.equal(outside.parseIncoming('just text').to, null);
  assert.equal(outside.STOP.test('Assistants, stop'), true);
});

await t('not set up: refused with a reason, nothing posted', async () => {
  const r = link.sendOutside({ outsideId: 'b_sheldon', fromBotId: 'b_leonard', text: 'Q hi' });
  assert.equal(r.ok, false);
  assert.match(r.why, /not set up/);
  assert.equal(calls.length, 0);
  assert.equal(store.getBot('b_sheldon').outside.status, 'not-set-up');
});

process.env.SLACK_USER_TOKEN = 'xoxp-user-test';
process.env.SLACK_BOT_TOKEN = 'xoxb-bot-test';
process.env.SLACK_APP_TOKEN = 'xapp-app-test';

let qTs;
await t('a bot asks: posted with the owner token, a real mention, and waits for an answer', async () => {
  const r = link.sendOutside({ outsideId: 'b_sheldon', fromBotId: 'b_leonard', text: 'Q work-cal: anything 11:30-1:30 Tue?', depth: 1 });
  assert.equal(r.ok, true);
  await settle();
  const post = calls.find((c) => c.method === 'chat.postMessage');
  assert.equal(post.auth, 'Bearer xoxp-user-test');
  assert.equal(post.body.channel, 'C0ASSIST01');
  assert.equal(post.body.text, '[Leonard]>@Sheldon Q work-cal: anything 11:30-1:30 Tue? <@U0SHELDON1>');
  assert.equal(post.body.thread_ts, undefined);
  const row = db.prepare("SELECT * FROM outside_messages WHERE direction='out'").get();
  assert.equal(row.state, 'sent');
  assert.match(row.link, /^https:\/\/example\.slack\.com/);
  qTs = row.slack_ts;
  assert.deepEqual(store.getBot('b_leonard').waitingFor.map((w) => w.name), ['Sheldon']);
  assert.equal(store.getBot('b_sheldon').outside.waiting, 1);
});

await t('his thread reply wakes the bot that asked, as information only', async () => {
  const res = await link.handleEvent({ type: 'message', channel: 'C0ASSIST01', user: 'U0SHELDON1', bot_id: 'B0X', ts: '1795400001.1', thread_ts: qTs, text: '[Sheldon]>@Cleft A work-cal: busy 11:30-1:00 Tue.' }, { wake });
  assert.equal(res, 'delivered to Leonard');
  assert.equal(woken.length, 1);
  assert.equal(woken[0].botId, 'b_leonard');
  assert.equal(woken[0].trig.type, 'external');
  assert.equal(woken[0].trig.kind, 'A');
  assert.equal(woken[0].trig.depth, 2);
  assert.equal(db.prepare("SELECT state FROM outside_messages WHERE slack_ts=? AND direction='out'").get(qTs).state, 'answered');
  assert.equal(store.getBot('b_leonard').waitingFor, undefined);
  const last = store.listRows('b_leonard', {}).at(-1);
  assert.equal(last.body.from.via, 'slack');
  assert.equal(last.body.from.name, 'Sheldon');
  const log = store.listRows('b_sheldon', {}).at(-1);
  assert.equal(log.body.role, 'assistant');
  const ex = link.listExchanges('b_sheldon');
  assert.equal(ex[0].replies.length, 1);
});

await t('duplicates, other people, other channels and edits are ignored', async () => {
  const before = woken.length;
  assert.equal(await link.handleEvent({ type: 'message', channel: 'C0ASSIST01', user: 'U0SHELDON1', ts: '1795400001.1', thread_ts: qTs, text: 'again' }, { wake }), 'ignored: duplicate');
  assert.equal(await link.handleEvent({ type: 'message', channel: 'C0ASSIST01', user: 'U0SAM', ts: '1795400002.1', text: '[Robin]>@Leonard FYI hi' }, { wake }), 'ignored: not from an outside member');
  assert.equal(await link.handleEvent({ type: 'message', channel: 'C0OTHER', user: 'U0SHELDON1', ts: '1795400003.1', text: '[Sheldon]>@Leonard Q x' }, { wake }), 'ignored: other channel');
  assert.equal(await link.handleEvent({ type: 'message', subtype: 'message_changed', channel: 'C0ASSIST01', ts: '1795400004.1' }, { wake }), 'ignored: not a new message');
  assert.equal(woken.length, before);
});

await t('his own post to a bot by name (or alias) wakes that bot; an answer goes back in his thread', async () => {
  assert.equal(await link.handleEvent({ type: 'message', channel: 'C0ASSIST01', user: 'U0SHELDON1', ts: '1795400005.1', text: '[Sheldon]>@Claude Q personal-cal: is Alex free Fri 6pm?' }, { wake }), 'delivered to Leonard');
  assert.equal(woken.at(-1).trig.kind, 'Q');
  assert.equal(woken.at(-1).trig.depth, 1);
  assert.equal(await link.handleEvent({ type: 'message', channel: 'C0ASSIST01', user: 'U0SHELDON1', ts: '1795400006.1', text: '[Sheldon]>@all FYI online' }, { wake }), 'logged');
  link.sendOutside({ outsideId: 'b_sheldon', fromBotId: 'b_leonard', text: 'A free Fri 6pm.' });
  await settle();
  const post = calls.filter((c) => c.method === 'chat.postMessage').at(-1);
  assert.equal(post.body.thread_ts, '1795400005.1');
  assert.equal(db.prepare("SELECT state FROM outside_messages WHERE direction='out' ORDER BY id DESC").get().state, 'answered');
});

await t('the owner writes on his page or @mentions him in a group: posted as the owner, no bot label', async () => {
  const loop = await import('../server/dist/agent/loop.js');
  loop.enqueue('b_sheldon', { type: 'user', text: 'Can you check Friday?' });
  await settle();
  assert.equal(calls.filter((c) => c.method === 'chat.postMessage').at(-1).body.text, '[Alex]>@Sheldon Can you check Friday? <@U0SHELDON1>');
  const rooms = await import('../server/dist/agent/rooms.js');
  const enq = [];
  rooms.dispatchRoomMessage('b_team', '@Sheldon @Leonard dentist Tue at noon?', (id, tr) => enq.push(id));
  await settle();
  assert.deepEqual(enq, ['b_leonard']);
  const out = db.prepare("SELECT * FROM outside_messages WHERE direction='out' ORDER BY id DESC").get();
  assert.equal(out.room_id, 'b_team');
  assert.equal(out.bot_id, null);
  rooms.dispatchRoomMessage('b_team', 'anyone free for dinner?', (id) => enq.push(id));
  assert.deepEqual(enq.slice(1).sort(), ['b_leonard', 'b_robin']);
  const n0 = calls.length;
  await link.handleEvent({ type: 'message', channel: 'C0ASSIST01', user: 'U0SHELDON1', ts: '1795400007.1', thread_ts: out.slack_ts, text: 'Busy 11:30 to 1.' }, { wake });
  assert.equal(store.listRows('b_team', {}).at(-1).body.from.name, 'Sheldon');
  assert.equal(calls.length - n0, 1); // only the permalink lookup
});

await t('no answer: after replyMinutes the asking bot is told, once', async () => {
  link.sendOutside({ outsideId: 'b_sheldon', fromBotId: 'b_robin', text: 'Q are you there?' });
  await settle();
  const before = woken.length;
  link.sweepNoAnswer(Date.now() + 76 * 60_000);
  link.sweepNoAnswer(Date.now() + 80 * 60_000);
  assert.equal(woken.length, before); // the module's own waker is a no-op until startSlackLink
  assert.equal(db.prepare("SELECT state FROM outside_messages WHERE bot_id='b_robin' AND direction='out'").get().state, 'no-answer');
});

await t('"Assistants, stop" from a person pauses the link; a bot cannot', async () => {
  assert.equal(await link.handleEvent({ type: 'message', channel: 'C0ASSIST01', user: 'U0SHELDON1', bot_id: 'B0X', ts: '1795400008.1', text: 'Assistants, stop' }, { wake }), 'logged');
  assert.equal(link.isPaused('b_sheldon'), false);
  assert.equal(await link.handleEvent({ type: 'message', channel: 'C0ASSIST01', user: 'U0SAM', ts: '1795400009.1', text: 'Assistants, stop' }, { wake }), 'paused');
  assert.equal(link.isPaused('b_sheldon'), true);
  const r = link.sendOutside({ outsideId: 'b_sheldon', fromBotId: 'b_leonard', text: 'Q hi' });
  assert.match(r.why, /paused/);
  assert.equal(await link.handleEvent({ type: 'message', channel: 'C0ASSIST01', user: 'U0SAM', ts: '1795400010.1', text: 'assistants, start' }, { wake }), 'resumed');
  assert.equal(link.isPaused('b_sheldon'), false);
});

await t('send_to_bot to an outside member: refusals are reported, nothing logged', async () => {
  const { toolMap } = await import('../server/dist/agent/tools.js');
  const tool = toolMap.get('send_to_bot');
  const ctx = { botId: 'b_leonard', userId: 'u1', depth: 0, enqueueBotMessage: () => assert.fail('must not use the bot queue') };
  const r = await tool.impl({ bot_name: 'Sheldon', message: 'tell him my card is 4111 1111 1111 1111' }, ctx);
  assert.match(r.output, /^Not sent\./);
  const ok = await tool.impl({ bot_name: 'Sheldon', message: 'FYI dinner moved to 7.' }, ctx);
  assert.match(ok.output, /^Sent to Sheldon in Slack #assistants/);
});

await t('SLACK_POST_VIA=mcp: posts through Slack MCP (no bot_id), falls back to chat.postMessage', async () => {
  process.env.SLACK_POST_VIA = 'mcp';
  const n0 = calls.filter((c) => c.method === 'chat.postMessage').length;
  link.sendOutside({ outsideId: 'b_sheldon', fromBotId: 'b_leonard', text: 'Q via mcp?' });
  await settle();
  const send = mcpCalls.filter((c) => c.m.method === 'tools/call').at(-1);
  assert.equal(send.m.params.name, 'slack_send_message');
  assert.equal(send.m.params.arguments.channel_id, 'C0ASSIST01');
  assert.match(send.m.params.arguments.message, /^\[Leonard\]>@Sheldon Q via mcp\? <@U0SHELDON1>$/);
  assert.equal(send.sid, 'sess-1');
  assert.equal(mcpCalls.filter((c) => c.m.method === 'initialize').length, 1);
  const row = db.prepare("SELECT * FROM outside_messages WHERE direction='out' ORDER BY id DESC").get();
  assert.match(row.slack_ts, /^1795500000\./);
  assert.match(row.link, /example\.slack\.com/);
  assert.equal(row.state, 'sent');
  assert.equal(calls.filter((c) => c.method === 'chat.postMessage').length, n0);
  mcpFail = true;
  link.sendOutside({ outsideId: 'b_sheldon', fromBotId: 'b_leonard', text: 'FYI fallback works' });
  await settle();
  assert.equal(calls.filter((c) => c.method === 'chat.postMessage').length, n0 + 1);
  assert.match(db.prepare("SELECT error FROM outside_messages WHERE direction='out' ORDER BY id DESC").get().error, /slow way/);
  mcpFail = false;
  delete process.env.SLACK_POST_VIA;
});

console.log(`\n${n} passed`);
slack.close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(0);
