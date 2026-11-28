// The activity trail (server/src/activity.ts) through the real server with a fake Hermes: a person's turn,
// a routine's turn and a script's turn each write rows naming what started them; card answers, refusals and
// failures are rows; "Nobody watching" filters the unattended ones; the CSV export is itself a row and
// never lets a cell run as a formula; a send to an outside member that the Slack link refuses is a refused row.
// Run after `npm run build -w server`:   node tests/activity-e2e.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import Database from 'better-sqlite3';
import { runner, sleep, startServer, until } from './lib/server.mjs';

const { test, done } = runner();
const PORT = 19000 + Math.floor(Math.random() * 300);
let SECRET = crypto.randomBytes(32).toString('hex');
let botId = null;
let BASE = `http://127.0.0.1:${PORT}`;

// Fake Hermes: the words of the turn say which tools to try through the app's gate.
//  "gate"  terminal (asks on a card)   "look"  read_file (look-only, then fails)   anything else answers.
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', async () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url !== '/v1/responses') { res.statusCode = 404; return res.end('{}'); }
    const b = JSON.parse(body);
    const input = JSON.stringify(b.input);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const token = crypto.createHmac('sha256', SECRET).update(`mcp:${botId}`).digest('hex');
    const gate = (tool, args) => fetch(`${BASE}/mcp/${botId}/gate`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool, args }) }).then((x) => x.json()).catch(() => ({ action: 'block' }));
    if (/gate/.test(input)) {
      const args = { command: 'rm -rf /tmp/activity-e2e' };
      send('response.output_item.added', { item: { type: 'function_call', name: 'terminal', call_id: 'c1', arguments: JSON.stringify(args) } });
      await sleep(50);
      const r = await gate('terminal', args);
      send('response.output_item.done', { item: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'hi', exit_code: 0 }) } });
      send('response.output_text.delta', { delta: `gate said ${r.action}` });
    } else if (/look/.test(input)) {
      const args = { path: '/tmp/nothing-here' };
      send('response.output_item.added', { item: { type: 'function_call', name: 'read_file', call_id: 'c2', arguments: JSON.stringify(args) } });
      await sleep(50);
      await gate('read_file', args);
      send('response.output_item.done', { item: { type: 'function_call_output', call_id: 'c2', output: JSON.stringify({ error: 'No such file' }) } });
      send('response.output_text.delta', { delta: 'looked' });
    } else if (/sheldon/.test(input)) {
      // send_to_bot over MCP to the outside member, whose Slack link is not set up: the link refuses it.
      const args = { bot_name: 'Sheldon', message: 'Q: are you free Friday?', type: 'Q' };
      send('response.output_item.added', { item: { type: 'function_call', name: 'mcp_hq_send_to_bot', call_id: 'c3', arguments: JSON.stringify(args) } });
      await sleep(50);
      const r = await fetch(`${BASE}/mcp/${botId}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_to_bot', arguments: args } }) }).then((x) => x.json());
      send('response.output_item.done', { item: { type: 'function_call_output', call_id: 'c3', output: r.result?.content?.[0]?.text ?? '' } });
      send('response.output_text.delta', { delta: 'tried' });
    } else send('response.output_text.delta', { delta: 'ok' });
    send('response.completed', { response: {} });
    res.end();
  });
}).listen(PORT + 600, '127.0.0.1');

const s = await startServer({ name: 'activity-e2e', port: PORT, secret: SECRET, noHermes: true, env: { BOTHQ_NO_SCHEDULER: '0', OUTSIDE_BOTS: JSON.stringify({ 'name:Sheldon': { via: 'slack', slackUserId: 'U0SHELDON1', channel: 'C0ASSIST01', channelName: 'assistants', ownerName: 'Alex' } }) } });
BASE = s.BASE;
try {
  const { api } = await s.signIn();
  const { json: { bots } } = await api('GET', '/bots');
  const bot = bots.find((b) => b.isPrimary);
  botId = bot.id;
  await api('PUT', `/bots/${bot.id}/free-terminal`, { on: false });
  const rows = async (id) => (await api('GET', `/bots/${id}/rows`)).json.rows;
  const trail = async (q = '') => (await api('GET', `/activity${q}`)).json;
  const idle = () => until('the turn to end', async () => !(await api('GET', '/bots')).json.live.find((l) => l.botId === bot.id)?.isRunning);
  const answer = async (decision) => {
    const card = await until('a card', async () => (await rows(bot.id)).filter((x) => x.body.card === 'approval' && (!x.body.status || x.body.status === 'pending')).at(-1));
    const r = await api('POST', `/approvals/${card.body.approvalId}`, { decision, digest: card.body.digest });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  };

  await test('a person allows a card: one allowed row, started by a person, saying how', async () => {
    await api('POST', `/bots/${bot.id}/messages`, { text: 'gate please' });
    await answer('allow');
    await idle();
    const t = await trail();
    const row = t.rows.find((r) => r.tool === 'hermes__terminal');
    assert.ok(row, JSON.stringify(t.rows));
    assert.equal(row.outcome, 'allowed');
    assert.equal(row.by.kind, 'person');
    assert.equal(row.by.unwatched, false);
    assert.equal(row.source, 'card');
    assert.match(row.how, /^Asked on its card/);
    assert.equal(row.detail, 'rm -rf /tmp/activity-e2e');
    assert.equal(row.botName, bot.name);
  });

  await test('a refused card is a refused row', async () => {
    await api('POST', `/bots/${bot.id}/messages`, { text: 'gate again' });
    await answer('deny');
    await idle();
    const t = await trail('?outcome=refused');
    assert.ok(t.rows.length >= 1);
    assert.ok(t.rows.every((r) => r.outcome === 'refused'));
    assert.equal(t.rows[0].tool, 'hermes__terminal');
  });

  await test('a look-only step is hidden by default, but its failure shows', async () => {
    await api('POST', `/bots/${bot.id}/messages`, { text: 'look around' });
    await idle();
    const failed = await until('the failed read', async () => (await trail()).rows.find((r) => r.tool === 'hermes__read_file'));
    assert.equal(failed.outcome, 'failed', 'the engine said the read failed, so the row says so');
    assert.equal(failed.looks, true);
    assert.match(failed.detail ?? '', /No such file/);
    const all = (await trail('?looks=1')).rows.filter((r) => r.tool === 'hermes__read_file');
    assert.equal(all.length, 1, 'one row for the step, not one for the gate and one for its result');
  });

  await test('a routine run is "Nobody watching", named by the routine', async () => {
    const db = new Database(s.dbPath);
    db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at,quiet) VALUES ('rt_gate',?,'Night gate','gate at night','0 9 1 1 *','UTC',1,?,0)").run(bot.id, Date.now());
    db.close();
    assert.equal((await api('POST', '/routines/rt_gate/run')).status, 200);
    await answer('allow');
    await idle();
    const t = await trail('?by=unwatched');
    assert.ok(t.rows.length >= 1, 'the routine row is there');
    assert.ok(t.rows.every((r) => r.by.unwatched));
    const row = t.rows.find((r) => r.tool === 'hermes__terminal');
    assert.equal(row.by.kind, 'routine');
    assert.equal(row.by.name, 'Night gate');
    assert.equal(row.by.text, 'Routine · Night gate');
    assert.ok(t.counts.unwatched >= 1 && t.counts.allowed >= 2, JSON.stringify(t.counts));
  });

  await test('a script\'s message is a script\'s turn, and counts as nobody watching', async () => {
    const script = await s.signInScript('Claude: activity test');
    await script.api('POST', `/bots/${bot.id}/messages`, { text: 'gate from a script' });
    await answer('deny');
    await idle();
    const row = (await trail('?by=script')).rows[0];
    assert.ok(row, 'a script row');
    assert.equal(row.by.text, 'A script (Claude: activity test)');
    assert.equal(row.by.unwatched, true);
  });

  await test('a send to the walled outside member that is refused is a refused hand-off row', async () => {
    const made = await api('POST', '/bots', { name: 'Sheldon', label: 'outside', color: 'purple' });
    assert.ok(made.status < 300, made.text);
    await api('POST', `/bots/${bot.id}/messages`, { text: 'ask sheldon' });
    await idle();
    const row = await until('the refused send', async () => (await trail('?outcome=refused')).rows.find((r) => r.tool === 'send_to_bot'));
    assert.equal(row.source, 'handoff');
    assert.match(row.title, /^Message to Sheldon refused/);
    assert.match(row.detail ?? '', /not set up/);
    assert.doesNotMatch(JSON.stringify(row), /free Friday/, 'the message itself is never kept');
  });

  await test('the export is a CSV of the filter, written to the trail itself', async () => {
    const r = await api('POST', '/activity/export', { by: 'unwatched' });
    assert.equal(r.status, 200, r.text);
    const lines = r.json.csv.trim().split('\r\n');
    assert.equal(lines[0], 'Time (UTC),Bot,For,Started by,Nobody watching,Outcome,What,Tool,How,Detail,Via');
    assert.equal(lines.length - 1, r.json.rows);
    assert.ok(lines.slice(1).every((l) => l.includes(',yes,')), 'only unwatched rows');
    assert.match(r.json.filename, /^ybots-activity-\d{4}-\d{2}-\d{2}\.csv$/);
    const own = (await trail()).rows.find((x) => x.tool === 'activity_export');
    assert.ok(own, 'the export has its own row');
    assert.equal(own.by.kind, 'person');
    assert.match(own.title, /^Exported \d+ activity rows$/);
    assert.match(own.detail, /Filter: nobody watching/);
  });

  await test('a cell that looks like a formula is exported as text', async () => {
    const db = new Database(s.dbPath);
    const uid = db.prepare('SELECT user_id FROM bots WHERE id=?').get(bot.id).user_id;
    db.prepare("INSERT INTO activity(at,user_id,bot_id,bot_name,by_kind,source,tool,title,outcome,detail,looks) VALUES (?,?,?,?, 'person','tool','x','=HYPERLINK(\"http://example.com\")','allowed','@SUM(A1)',0)").run(Date.now(), uid, bot.id, bot.name);
    db.close();
    const { json } = await api('POST', '/activity/export', { q: 'HYPERLINK' });
    const line = json.csv.trim().split('\r\n')[1];
    assert.ok(line.includes(`"'=HYPERLINK(""http://example.com"")"`), line);
    assert.ok(line.includes("'@SUM(A1)"), line);
  });

  await test('filters: bot, search, and a bot of another account is not found', async () => {
    assert.ok((await trail(`?botId=${bot.id}`)).rows.every((r) => r.botId === bot.id || r.botId === null));
    assert.ok((await trail('?q=Night%20gate')).rows.every((r) => /Night gate/.test(`${r.by.name}${r.title}`)));
    assert.equal((await api('GET', '/activity?botId=bot_nope')).status, 404);
    const page = await trail('?looks=1');
    assert.equal(typeof page.more, 'boolean');
    assert.ok(Array.isArray(page.bots) && page.bots.some((b) => b.id === bot.id));
  });

  await test('signed out, the trail is not readable', async () => {
    const r = await fetch(`${BASE}/api/activity`);
    assert.equal(r.status, 401);
  });
} finally {
  await s.stop();
  hermes.close();
}
done();
