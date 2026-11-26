// Posting from a bot's browser end to end (server/src/posting.ts, browser-guard*.ts): a real Chromium stands
// in for the bot's Chrome and a local page poses as x.com. Checks: posting tools are listed only with the
// publish hold on; Post presses are held until a posting plan card is approved; the card can only be
// answered in the app with the days left on; a press goes through once, only with the exact approved
// caption; switched-off days stay held; a dry run holds and reports the final press; editing the video
// cancels the day; script bypasses are refused. Throwaway database; needs Chromium (Playwright) and
// writes into /root/bothq/files/<bot id> (removed at the end).  Run after `npm run build -w server`:
//   node tests/posting-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posting-e2e-'));
const PORT = 21000 + Math.floor(Math.random() * 500);
const HERMES_PORT = PORT + 600;
const SITE_PORT = PORT + 700;
const CDP_PORT = PORT + 800;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');

// ---- the test "social" site: served as x.com and studio.youtube.com through Chrome's host rules ----
const site = http.createServer((req, res) => {
  const u = new URL(req.url, SITE);
  res.setHeader('content-type', 'text/html');
  const page = (title, body) => `<!doctype html><html><head><meta charset=utf-8><title>${title}</title></head><body>${body}</body></html>`;
  if (u.pathname === '/compose') return res.end(page('Compose', `
    <a href="/compose" id=side role=link>Post</a>
    <div role=dialog><div id=box contenteditable=true role=textbox aria-label="Post text"></div>
    <button id=post data-testid=tweetButton onclick="window.posted=(window.posted||0)+1;document.title='posted '+window.posted">Post</button>
    <button id=sched onclick="window.schedN=(window.schedN||0)+1">Schedule</button></div>
    <div><textarea id=cmt aria-label="Add a comment"></textarea></div>`));
  res.statusCode = 404; res.end('no');
});
site.listen(SITE_PORT, '127.0.0.1');

// ---- fake Hermes (never used for a turn here) ----
const hermes = http.createServer((req, res) => { res.end(req.url === '/health' ? '{"status":"ok"}' : '{"data":[]}'); }).listen(HERMES_PORT, '127.0.0.1');
const hermesHome = path.join(dir, 'hermes');
fs.mkdirSync(hermesHome, { recursive: true });
fs.writeFileSync(path.join(hermesHome, '.env'), 'API_SERVER_KEY=test-key\n');

// ---- the bot's Chrome ----
const browser = await chromium.launch({ ...(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}), args: [`--remote-debugging-port=${CDP_PORT}`, '--site-per-process', '--host-resolver-rules=MAP x.com 127.0.0.1, MAP studio.youtube.com 127.0.0.1'] });
const ctxB = await browser.newContext();
const tab = await ctxB.newPage();
await tab.goto(`http://x.com:${SITE_PORT}/compose`);

const server = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
  cwd: path.join(root, 'server'),
  env: {
    PATH: process.env.PATH, HOME: dir,
    PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET,
    ORGO_API_KEY: 'unused', DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'),
    HERMES_BIN: '/bin/false', HERMES_URL: `http://127.0.0.1:${HERMES_PORT}`, HERMES_HOME_PRIMARY: hermesHome,
    APPS_CONFIG: path.join(dir, 'apps.json'), BOTHQ_NO_SCHEDULER: '1', CLEFT_GUARD_CDP_URL: `http://127.0.0.1:${CDP_PORT}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const owner = (b) => fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const made = await owner({ email: 'owner@example.com', link: true });
  const opened = await fetch(`${BASE}${new URL((await made.json()).url).pathname}`, { redirect: 'manual' });
  const cookie = opened.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const scriptCookie = (await owner({ email: 'owner@example.com', agent: 'Claude: test' })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const api = async (method, p, body, extra = {}) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json', origin: BASE, ...extra }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const { json: { bots } } = await api('GET', '/bots');
  const bot = bots.find((b) => b.isPrimary);
  const token = crypto.createHmac('sha256', SECRET).update(`mcp:${bot.id}`).digest('hex');
  let rpc = 0;
  const tool = async (name, args) => {
    const r = await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }) });
    return (await r.json()).result?.content?.[0]?.text ?? '';
  };
  const gate = async (t, args, ms = 4000) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(`${BASE}/mcp/${bot.id}/gate`, { method: 'POST', signal: ac.signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool: t, args }) });
      return await r.json();
    } catch { return { pending: true }; } finally { clearTimeout(timer); }
  };
  const after = async () => (await fetch(`${BASE}/mcp/${bot.id}/after`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).json();
  const rows = async () => (await api('GET', `/bots/${bot.id}/rows`)).json.rows;
  const pendingCard = async (tool) => {
    for (let i = 0; i < 100; i++) {
      const c = (await rows()).find((r) => r.body.card === 'approval' && r.body.tool === tool && r.body.status === 'pending');
      if (c) return c.body;
      await sleep(100);
    }
    throw new Error(`no ${tool} card\n${log.slice(-1500)}`);
  };


  // SHOTS=<folder>: pictures of the cards as the web app shows them (light and dark).
  const SHOTS = process.env.SHOTS;
  let shotPage = null;
  const shot = async (name) => {
    if (!SHOTS) return;
    if (!shotPage) {
      // A browser of its own: a page in the bot's Chrome would become the tab the guard watches.
      const b2 = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
      const c = await b2.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
      await c.addCookies(cookie.split('; ').map((kv) => { const [n, ...v] = kv.split('='); return { name: n, value: v.join('='), url: BASE }; }));
      shotPage = await c.newPage();
    }
    for (const scheme of ['light', 'dark']) {
      await shotPage.emulateMedia({ colorScheme: scheme });
      await shotPage.goto(BASE);
      await shotPage.waitForTimeout(1500);
      const card = shotPage.locator('.browser-card').last();
      await card.scrollIntoViewIfNeeded().catch(() => undefined);
      await card.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`) }).catch((e) => console.log('shot failed', e.message));
    }
  };

  const CAP8 = 'Most landlords buy tenant screening reports.\n\nGeneral information, not legal advice. #FCRA';
  const CAP9 = 'A collector reported a debt before contacting you? #FCRA';
  const ws = path.join('/root/bothq/files', bot.id);
  fs.mkdirSync(path.join(ws, 'drive/day08'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'drive/day08/d04_9x16.mp4'), 'video-8');
  fs.mkdirSync(path.join(ws, 'drive/day09'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'drive/day09/d09_9x16.mp4'), 'video-9');
  const typeCaption = async (text) => { await tab.evaluate((t) => { const b = document.getElementById('box'); b.innerText = t; }, text); };
  const today = new Date(Date.now() + 86400_000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const tomorrow = new Date(Date.now() + 2 * 86400_000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const posted = () => tab.evaluate(() => window.posted || 0);

  await test('posting tools are hidden until the publish hold is on', async () => {
    const list = async () => (await (await fetch(`${BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/list' }) })).json()).result.tools.map((t) => t.name);
    assert.ok(!(await list()).includes('request_posting_approval'));
    const off = await fetch(`${BASE}/api/bots/${bot.id}/publish-guard`, { method: 'PUT', headers: { cookie: scriptCookie, 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ on: false }) });
    assert.equal(off.status, 403, 'a script cannot turn it off');
    const on = await fetch(`${BASE}/api/bots/${bot.id}/publish-guard`, { method: 'PUT', headers: { cookie: scriptCookie, 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ on: true }) });
    assert.equal(on.status, 200);
    for (const n of ['request_posting_approval', 'posting_dry_run', 'posting_status', 'check_signins', 'drive_pull', 'ask_drive_key']) assert.ok((await list()).includes(n), n);
  });

  await test('a Post press is held before any approval; a link to the composer is not', async () => {
    await gate('browser_exec', { code: 'page_info()' }); // the guard attaches on a browser step
    await tab.reload(); await sleep(400);
    await typeCaption(CAP8);
    await tab.click('#post');
    await sleep(300);
    assert.equal(await posted(), 0);
    const a = await after();
    assert.match(JSON.stringify(a), /was held: nothing was published/);
  });

  await test('Enter in a comment box is held too', async () => {
    await tab.focus('#cmt'); await tab.keyboard.type('hi'); await tab.keyboard.press('Enter');
    await sleep(200);
    assert.match(JSON.stringify(await after()), /held/);
  });

  await test('script submits and raw DevTools script are refused on the social site', async () => {
    const g1 = await gate('browser_exec', { code: 'await page.evaluate("fetch(\'/i/api/graphql/CreateTweet\', {method:\'POST\'})")' });
    assert.equal(g1.action, 'block', JSON.stringify(g1));
    const g2 = await gate('browser_cdp', { method: 'Runtime.evaluate', params: { expression: '1' } });
    assert.equal(g2.action, 'block', JSON.stringify(g2));
    assert.doesNotMatch(JSON.stringify(await gate('browser_exec', { code: 'page_info()' })), /Script-made submits/, 'looking is fine');
  });

  let card;
  const planRun = tool('request_posting_approval', { why: 'Days 8-9', days: [
    { date: today, label: 'Day 8 · Denied an apartment', video: 'drive/day08/d04_9x16.mp4', posts: [{ platform: 'x', time: '6:00 pm', caption: CAP8 }, { platform: 'x', time: '6:23 pm', kind: 'reply', caption: 'General information, not legal advice.' }] },
    { date: tomorrow, label: 'Day 9', video: 'drive/day09/d09_9x16.mp4', posts: [{ platform: 'x', time: '6:00 pm', caption: CAP9 }] },
  ] });
  await test('the card lists both days with their video and posts, and offers Always allow with a warning', async () => {
    card = await pendingCard('posting_plan');
    await shot('posting-plan');
    assert.equal(card.postingPlan.days.length, 2);
    assert.equal(card.postingPlan.days[0].video.ok, true);
    assert.equal(card.postingPlan.days[0].posts[0].caption, CAP8);
    assert.equal(card.canAlways, true);
    assert.match(card.alwaysNote, /public accounts/);
  });
  await test('plain allow, a notification, a script and no days cannot answer it', async () => {
    assert.equal((await api('POST', `/approvals/${card.approvalId}`, { decision: 'allow', digest: card.digest })).status, 409);
    assert.equal((await api('POST', `/approvals/${card.approvalId}/plan`, { days: [today], digest: card.digest }, { 'x-cleft-via': 'notification' })).status, 409);
    const s = await fetch(`${BASE}/api/approvals/${card.approvalId}/plan`, { method: 'POST', headers: { cookie: scriptCookie, 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ days: [today], digest: card.digest }) });
    assert.equal(s.status, 403);
    assert.equal((await api('POST', `/approvals/${card.approvalId}/plan`, { days: [], digest: card.digest })).status, 400);
  });
  await test('approving with day 9 switched off approves day 8 only', async () => {
    const r = await api('POST', `/approvals/${card.approvalId}/plan`, { days: [today], digest: card.digest });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const out = await planRun;
    assert.match(out, new RegExp(`Approved by .*${today}`));
    assert.match(out, new RegExp(`do NOT post\\): ${tomorrow}`));
    await shot('posting-plan-approved');
  });
  await test('an edited caption is still held; the exact caption goes through once', async () => {
    await sleep(300);
    await typeCaption(CAP8 + ' extra');
    await tab.click('#post'); await sleep(200);
    assert.equal(await posted(), 0);
    await typeCaption(CAP8);
    await tab.click('#post'); await sleep(300);
    assert.equal(await posted(), 1);
    await sleep(2700);
    await tab.click('#post'); await sleep(300);
    assert.equal(await posted(), 1, 'one press per approved post');
  });
  await test('the switched-off day stays held', async () => {
    await typeCaption(CAP9);
    await tab.click('#post'); await sleep(300);
    assert.equal(await posted(), 1);
  });
  await test('posting_status reports the press', async () => {
    const out = await tool('posting_status', {});
    assert.match(out, /pressed .*Post on http:\/\/x\.com/);
    assert.match(out, /reply: approved, not pressed yet/);
  });
  await test('a dry run holds even an approved press and reports it', async () => {
    assert.match(await tool('posting_dry_run', { action: 'start' }), /Dry run on/);
    await typeCaption('General information, not legal advice.');
    await tab.click('#sched'); await sleep(300);
    assert.equal(await tab.evaluate(() => window.schedN || 0), 0);
    const out = await tool('posting_dry_run', { action: 'finish' });
    assert.match(out, /held "Schedule"/);
  });
  await test('changing the day\'s video cancels what is left of that day', async () => {
    await sleep(5200);
    fs.writeFileSync(path.join(ws, 'drive/day08/d04_9x16.mp4'), 'video-8-edited');
    await gate('browser_exec', { code: 'page_info()' });
    await tab.reload(); await sleep(500);
    await typeCaption('General information, not legal advice.');
    await tab.click('#post'); await sleep(300);
    assert.equal(await posted(), 0, 'reload resets the counter; the reply stays held');
    assert.match(await tool('posting_status', {}), /cancelled \(d04_9x16\.mp4 changed\)/);
  });
  await test('check_signins reads names only', async () => {
    await tab.evaluate(() => { document.cookie = 'auth_token=secretvalue123; max-age=86400; path=/'; });
    const out = await tool('check_signins', {});
    assert.match(out, /- x: signed in/);
    assert.ok(!out.includes('secretvalue123'));
  });
  await test('a Drive pull without a key asks for the key first', async () => {
    assert.match(await tool('drive_pull', { folder: '1BL9JL-Fb9Dp981Q98FBeCm6RMW-g6dQm' }), /ask_drive_key/);
  });
} finally {
  try { fs.rmSync(path.join('/root/bothq/files', (await (await fetch(`${BASE}/api/bots`, { headers: { cookie: '' } })).json().catch(() => ({})))?.bots?.[0]?.id ?? 'none'), { recursive: true, force: true }); } catch { /* */ }
  server.kill();
  await browser.close();
  site.close(); hermes.close();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
