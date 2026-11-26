// End-to-end check of the Slack link through the real server, against a fake Slack (Web API and a
// Socket Mode WebSocket). Sends from the app to an outside member, gets a thread reply and a
// top-level ask back over the socket, and checks the exchange log. Nothing goes to the real Slack.
//   npm run build && node tests/outside-e2e.mjs        (SHOTS=/dir also saves phone and desktop screenshots)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { WebSocketServer } = createRequire(path.join(root, 'server/package.json'))('ws');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
const SHELDON = 'U0SHELDON1', CHANNEL = 'C0ASSIST01';

// ---------- fake Slack ----------
const posts = [];
let tsN = 100;
const slack = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const method = req.url.replace(/^\/api\//, '');
    const j = Object.fromEntries(new URLSearchParams(body)); // like Slack's read methods, a JSON body is not read
    res.setHeader('Content-Type', 'application/json');
    if (method === 'apps.connections.open') return res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${slack.address().port}/socket` }));
    if (method === 'chat.postMessage') { const ts = `1795400000.${String(tsN++).padStart(6, '0')}`; posts.push({ ...j, ts, auth: req.headers.authorization }); return res.end(JSON.stringify({ ok: true, ts })); }
    if (method === 'chat.getPermalink' && !j.message_ts) return res.end(JSON.stringify({ ok: false, error: 'invalid_arguments' }));
    if (method === 'chat.getPermalink') return res.end(JSON.stringify({ ok: true, permalink: `https://example.slack.com/archives/${j.channel}/p${j.message_ts.replace('.', '')}` }));
    res.end(JSON.stringify({ ok: false, error: 'unknown_method' }));
  });
});
const wss = new WebSocketServer({ server: slack, path: '/socket' });
let sock = null;
const acks = new Set();
wss.on('connection', (s) => { sock = s; s.send(JSON.stringify({ type: 'hello' })); s.on('message', (d) => acks.add(JSON.parse(String(d)).envelope_id)); });
await new Promise((r) => slack.listen(0, '127.0.0.1', r));
let envN = 0;
const emit = (event) => { const id = `env-${++envN}`; sock.send(JSON.stringify({ envelope_id: id, type: 'events_api', payload: { event: { type: 'message', channel: CHANNEL, ...event } } })); return id; };

for (const [k, v] of [['user', 'xoxp-test-user'], ['bot', 'xoxb-test-bot'], ['app', 'xapp-test-app']]) fs.writeFileSync(path.join(dir, k), v);
const server = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
  cwd: path.join(root, 'server'),
  env: {
    PATH: process.env.PATH, HOME: dir, PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET,
    DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'), HERMES_BIN: '/bin/false', HERMES_URL: 'http://127.0.0.1:9',
    HERMES_HOME_PRIMARY: path.join(dir, 'hermes'), CLEFTBOT_NO_SCHEDULER: '1', MAX_BOTS: '6',
    OWNER_EMAIL: 'owner@example.com', ALLOWED_EMAILS: 'owner@example.com', PRIMARY_BOT_NAME: 'Howard',
    OUTSIDE_BOTS: JSON.stringify({ 'name:Sheldon': { via: 'slack', slackUserId: SHELDON, channel: CHANNEL, channelName: 'assistants', ownerName: 'Alex', aliases: { Claude: 'Leonard' } } }),
    SLACK_USER_TOKEN_FILE: path.join(dir, 'user'), SLACK_APP_TOKEN_FILE: path.join(dir, 'app'), // no bot token: the app has no bot user
    SLACK_API_URL: `http://127.0.0.1:${slack.address().port}/api`,
    GROUP_UPDATE_QUIET_MS: '1500', GROUP_UPDATE_MAX_MS: '4000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack}`); } };
const until = async (fn, what) => { for (let i = 0; i < 60; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`timed out: ${what}`); };

try {
  await until(async () => { try { return (await fetch(`${BASE}/api/health`)).ok; } catch { return false; } }, `server start\n${log}`);
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const r = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com' }) });
  const scriptCookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const link = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', link: true }) });
  const human = await fetch((await link.json()).url, { redirect: 'manual' });
  const cookie = human.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const api = async (method, p, body, session = cookie) => {
    const x = await fetch(`${BASE}/api${p}`, { method, headers: { cookie: session, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: x.status, json: await x.json().catch(() => null) };
  };
  const ids = {};
  for (const [name, color] of [['Leonard', 'blue'], ['Robin', 'pink'], ['Sheldon', 'purple']]) {
    const b = await api('POST', '/bots', { name, avatarColor: color, avatarShape: 'blob' });
    assert.equal(b.status, 200, JSON.stringify(b.json));
    ids[name] = b.json.bot.id;
  }
  const team = await api('POST', '/rooms', { name: 'Team', botIds: [ids.Leonard, ids.Robin, ids.Sheldon] });
  assert.equal(team.status, 200, JSON.stringify(team.json));
  const bot = async (id) => (await api('GET', '/bots')).json.bots.find((b) => b.id === id);

  await test('the socket connects and Sheldon shows as a linked outside member', async () => {
    const s = await until(async () => { const b = await bot(ids.Sheldon); return b.outside?.status === 'ready' && b; }, 'link ready');
    assert.equal(s.outside.channelName, 'assistants');
  });

  await test('direct and group script messages cannot post under the Slack owner identity', async () => {
    const before = posts.length;
    for (const id of [ids.Sheldon, team.json.id]) {
      const response = await api('POST', `/bots/${id}/messages`, { text: '@Sheldon hello' }, scriptCookie);
      assert.equal(response.status, 200);
      const rows = (await api('GET', `/bots/${id}/rows`)).json.rows;
      assert.ok(rows.some((row) => row.body.type === 'notice' && /a script cannot send/i.test(row.body.text)));
    }
    assert.equal(posts.length, before);
  });

  let first;
  await test('a message typed to Sheldon in the app posts to Slack as the owner', async () => {
    assert.equal((await api('POST', `/bots/${ids.Sheldon}/messages`, { text: 'Q what time is the Thursday hearing?' })).status, 200);
    first = await until(() => posts[0], 'post');
    assert.equal(first.channel, CHANNEL);
    assert.equal(first.auth, 'Bearer xoxp-test-user');
    assert.match(first.text, new RegExp(`^\\[Alex\\]>@Sheldon Q what time.*<@${SHELDON}>$`));
  });

  await test('his thread reply comes back over the socket, is acknowledged and logged as answered', async () => {
    const env = emit({ user: SHELDON, ts: '1795400050.000001', thread_ts: first.ts, text: 'A Thursday 9:30, courtroom 4B.' });
    await until(() => acks.has(env), 'ack');
    const x = await until(async () => (await api('GET', `/bots/${ids.Sheldon}/exchanges`)).json.exchanges.find((e) => e.replies.length), 'answered');
    assert.equal(x.state, 'answered');
    assert.match(x.replies[0].text, /courtroom 4B/);
    assert.match(x.replies[0].link, /^https:\/\/example\.slack\.com\//);
  });

  await test('a top-level [Sheldon]>@Claude post goes to Leonard through the alias', async () => {
    emit({ user: SHELDON, ts: '1795400060.000001', text: '[Sheldon]&gt;@Claude Q can you add the hearing to the family calendar? &amp; the 4B room' }); // Slack escapes & < >
    const t = await until(async () => (await api('GET', `/bots/${ids.Leonard}/rows`)).json.rows.find((row) => row.body?.from?.via === 'slack'), 'Leonard got it');
    assert.equal(t.body.text, 'Q can you add the hearing to the family calendar? & the 4B room');
    assert.ok(t);
    // Sheldon's own chat keeps a record that names who it went to, instead of a plain-text "@Leonard".
    const rec = (await api('GET', `/bots/${ids.Sheldon}/rows`)).json.rows.findLast((row) => row.body?.text === 'Q can you add the hearing to the family calendar? & the 4B room');
    assert.equal(rec?.body?.from?.to?.name, 'Leonard');
  });

  await test('@Sheldon in the Team group posts to Slack; the waiting chip shows for the group', async () => {
    const before = posts.length;
    assert.equal((await api('POST', `/bots/${team.json.id}/messages`, { text: '@Sheldon Q are you free for a call Tuesday at noon?' })).status, 200);
    await until(() => posts.length > before, 'group post');
    const g = await until(async () => { const b = await bot(team.json.id); return b.waitingFor?.length && b; }, 'waiting');
    assert.equal(g.waitingFor[0].name, 'Sheldon');
    assert.match(posts.at(-1).text, /^\[Alex\]>@Sheldon \(In the "Team" group\) @Sheldon Q are you free/);
  });

  await test('a message to the whole group (no @mentions) also reaches Sheldon in Slack', async () => {
    const before = posts.length;
    assert.equal((await api('POST', `/bots/${team.json.id}/messages`, { text: 'Welcome, everyone. Please reintroduce yourselves.' })).status, 200);
    await until(() => posts.length > before, 'whole-group post');
    const t = posts.at(-1).text;
    assert.match(t, new RegExp(`^\\[Alex\\]>@Sheldon \\(In the "Team" group\\) Welcome, everyone.*<@${SHELDON}>$`, 's'));
    // The group's recent messages go along, labelled by speaker, without repeating the new message.
    assert.match(t, /\n\nEarlier in the group:\n(> .*\n)*> Alex: @Sheldon Q are you free for a call Tuesday at noon\?/);
    assert.ok(!/> Alex: Welcome, everyone/.test(t));
  });

  await test('context lines are labelled by speaker, and shapes that never leave the app are blanked', async () => {
    const before = posts.length;
    await api('POST', `/bots/${team.json.id}/messages`, { text: 'Card 4111 1111 1111 1111 is the one to use.' });
    await until(() => posts.length > before, 'post 1');
    await api('POST', `/bots/${team.json.id}/messages`, { text: 'Thanks all.' });
    await until(() => posts.length > before + 1, 'post 2');
    const t = posts.at(-1).text;
    assert.match(t, /> Alex: Card \[a card or account number removed\] is the one to use\./);
    assert.ok(!/4111/.test(t));
  });

  const liveOf = async (id) => (await api('GET', '/bots')).json.live?.find((l) => l.botId === id);
  const groupRows = async () => (await api('GET', `/bots/${team.json.id}/rows`)).json.rows;
  const settle = async () => { await api('POST', `/bots/${team.json.id}/interrupt`, {}); await until(async () => !(await liveOf(team.json.id))?.members?.length, 'group idle'); };
  const woke = async (name) => { for (let i = 0; i < 200; i++) { const l = await liveOf(team.json.id); if (l?.members?.some((m) => m.name === name)) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

  await test('group posts to Sheldon tell him how to answer and start a group', async () => {
    const t = posts.at(-1).text;
    assert.match(t, /Only the bots you @mention by name answer/);
    assert.match(t, /\[Sheldon\]>@<group name>.*your groups: Team/s);
  });

  await test('his reply in a group thread with no @mention is posted to the group but wakes nobody', async () => {
    await settle();
    const root = posts.filter((p) => /\(In the "Team" group\)/.test(p.text)).at(-1);
    emit({ user: SHELDON, ts: '1795400080.000001', thread_ts: root.ts, text: 'Nothing on my side this week.' });
    await until(async () => (await groupRows()).find((r) => r.body?.text === 'Nothing on my side this week.'), 'in group');
    assert.equal(await woke('Leonard'), false);
  });

  await test('his reply in a group thread wakes only the bots he @mentions', async () => {
    await settle();
    const root = posts.filter((p) => /\(In the "Team" group\)/.test(p.text)).at(-1);
    emit({ user: SHELDON, ts: '1795400081.000001', thread_ts: root.ts, text: '@Leonard can you hold Friday afternoon?' });
    assert.equal(await woke('Leonard'), true);
    assert.equal(await woke('Robin'), false);
  });

  await test('a top-level [Sheldon]>@Team post starts a group conversation', async () => {
    await settle();
    emit({ user: SHELDON, ts: '1795400082.000001', text: `[Sheldon]&gt;@Team Q @Robin what is for dinner Sunday? <@U0OWNER001>` });
    const row = await until(async () => (await groupRows()).find((r) => r.body?.text === 'Q @Robin what is for dinner Sunday?'), 'started in group');
    assert.equal(row.body.from.name, 'Sheldon');
    assert.equal(await woke('Robin'), true);
  });

  const asBot = async (botId, name, args) => {
    const t = crypto.createHmac('sha256', SECRET).update(`mcp:${botId}`).digest('hex');
    const r = await fetch(`${BASE}/mcp/${botId}`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return JSON.parse((await r.text()).match(/\{.*\}/s)[0]).result.content[0].text;
  };

  await test("a Bot's group post with no @mention wakes nobody", async () => {
    await settle();
    await new Promise((r) => setTimeout(r, 4500)); // let earlier tests' combined updates go out first
    const before = posts.length;
    assert.equal(await asBot(ids.Leonard, 'post_to_group', { group_name: 'Team', text: 'Budget is on track this week.' }), 'Posted to the group.');
    assert.equal(posts.length, before, 'not posted to Slack on its own (it waits for the combined update)');
    assert.equal(await woke('Robin'), false);
  });

  await test('bot posts without @Sheldon still reach him, gathered into one FYI update, and the group sees it was delivered', async () => {
    await new Promise((r) => setTimeout(r, 2000)); // the previous test's post goes out on its own
    const before = posts.length;
    await asBot(ids.Robin, 'post_to_group', { group_name: 'Team', text: 'Groceries are ordered for Saturday.' });
    await asBot(ids.Leonard, 'post_to_group', { group_name: 'Team', text: 'Card 4111 1111 1111 1111 was charged $40.' });
    assert.equal(posts.length, before, 'nothing goes out while the group is still busy');
    await until(() => posts.length > before, 'combined update');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(posts.length, before + 1, 'two posts, one Slack message');
    const t = posts.at(-1).text;
    assert.match(t, /^\[Team\]>@Sheldon FYI \(Update from the "Team" group, no reply needed\. Bots posted 2 times:\)\n> Robin: Groceries are ordered for Saturday\.\n> Leonard: Card /);
    assert.doesNotMatch(t, /4111 1111/);
    assert.match(t, new RegExp(`<@${SHELDON}>$`));
    await until(async () => (await groupRows()).find((r) => r.body?.type === 'notice' && /Delivered to Sheldon on Slack: the last 2 Bot posts/.test(r.body.text)), 'delivered notice');
  });

  await test("the owner's group message shows a delivered line once it is in Slack", async () => {
    await settle();
    const delivered = async () => (await groupRows()).filter((r) => r.body?.type === 'notice' && r.body.text === 'Delivered to Sheldon on Slack.').length;
    const before = await delivered();
    assert.equal((await api('POST', `/bots/${team.json.id}/messages`, { text: 'Dinner at six tonight.' })).status, 200);
    await until(async () => (await delivered()) > before, 'owner delivered notice');
  });

  await test("a Bot's @mention in a group wakes that member, and @Sheldon goes to Slack with the group context", async () => {
    await settle();
    const before = posts.length;
    const out = await asBot(ids.Robin, 'post_to_group', { group_name: 'Team', text: '@Leonard can you add milk? @Sheldon when do your briefings run?' });
    assert.match(out, /Woke Leonard, Sheldon \(Slack\)/);
    assert.equal(await woke('Leonard'), true);
    const p = await until(() => posts.length > before && posts.at(-1), 'Slack post');
    assert.match(p.text, /^\[Robin\]>@Sheldon Q @Leonard can you add milk\?/);
    assert.match(p.text, /Earlier in the group:/);
  });

  await test("Sheldon's thread answer to a Bot's group question goes to the group and wakes that Bot", async () => {
    await settle();
    const q = posts.at(-1);
    emit({ user: SHELDON, ts: '1795400090.000001', thread_ts: q.ts, text: 'A My briefing runs at 7:15 AM.' });
    await until(async () => (await groupRows()).find((r) => r.body?.text === 'A My briefing runs at 7:15 AM.'), 'answer in group');
    assert.equal(await woke('Robin'), true);
  });

  await test('a message that @mentions only an inside member does not go to Slack', async () => {
    const before = posts.length;
    assert.equal((await api('POST', `/bots/${team.json.id}/messages`, { text: '@Leonard what is on the calendar?' })).status, 200);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(posts.length, before);
  });

  await test('"Assistants, stop" from a person pauses the link', async () => {
    emit({ user: 'U0OWNER001', ts: '1795400070.000001', text: 'Assistants, stop' });
    await until(async () => (await bot(ids.Sheldon)).outside.status === 'paused', 'paused');
    assert.equal((await api('POST', `/bots/${ids.Sheldon}/link`, { paused: false })).status, 200);
    assert.equal((await bot(ids.Sheldon)).outside.status, 'ready');
  });

  if (process.env.SHOTS) {
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
    const [name, value] = cookie.split(';')[0].split('=');
    for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
      await ctx.addCookies(cookie.split('; ').map((c) => { const [n, ...v] = c.split('='); return { name: n, value: v.join('='), url: BASE }; }));
      const page = await ctx.newPage();
      const shot = (what) => page.screenshot({ path: path.join(process.env.SHOTS, `${label}-${what}.png`) });
      await page.goto(`${BASE}/`);
      await page.waitForTimeout(1500);
      const pick = async (name) => { await page.locator('.bot-row').filter({ has: page.locator('.bot-row__name', { hasText: new RegExp(`^${name}`) }) }).first().click(); await page.waitForTimeout(1200); };
      if (label === 'desktop') {
        for (const name of ['Sheldon', 'Team', 'Leonard']) { await pick(name); await shot(name.toLowerCase()); }
      } else {
        await shot('sidebar');
        for (const name of ['Sheldon', 'Team']) { await pick(name); await shot(name.toLowerCase()); await page.goto(`${BASE}/`); await page.waitForTimeout(1200); }
      }
      await ctx.close();
    }
    await browser.close();
  }
} finally {
  server.kill();
  wss.close();
  slack.close();
  slack.closeAllConnections?.();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
if (failures) { console.log(log.slice(-3000)); process.exitCode = 1; }
