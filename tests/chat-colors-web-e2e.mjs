// Bot colours and face pictures in chats, in the web app (and so the Windows app, which loads it), in a
// real browser against the real server: another bot's message in a bot's chat shows its face (crop=head),
// its name in its colour and a tinted bubble with a bar; each group member has its own colour, in light and
// dark; settings set and reset a colour. Throwaway database; needs no Hermes. SHOTS=<dir> saves screenshots.
// Run after `npm run build` (web and server):   node tests/chat-colors-web-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-colors-web-'));
const PORT = 19100 + Math.floor(Math.random() * 300);
const HERMES_PORT = PORT + 700;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
const SHOTS = process.env.SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url !== '/v1/responses') { res.statusCode = 404; return res.end('{}'); }
    const b = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    if (/slow/.test(b.input)) { send('response.output_text.delta', { delta: 'Still checking the flights' }); return; }
    const text = /grocer/i.test(b.input) ? 'Here is this week\'s grocery list: eggs, rice, apples.' : `Got it: ${b.input.split('\n').pop().slice(0, 40)}`;
    send('response.output_text.delta', { delta: text });
    send('response.output_item.done', { item: { type: 'message', content: [{ text }] } });
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
    APPS_CONFIG: path.join(dir, 'apps.json'), BOTHQ_NO_SCHEDULER: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 6).join('\n     ')}`); }
};
const { chromium } = createRequire(import.meta.url)('playwright');
let browser;

try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const r = await fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com' }) });
  const cookies = r.headers.getSetCookie().map((c) => c.split(';')[0]);
  browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  await ctx.addCookies(cookies.map((c) => { const [n, ...v] = c.split('='); return { name: n, value: v.join('='), url: BASE }; }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 400)));
  const api = async (method, p, b) => {
    const res = await fetch(`${BASE}/api${p}`, { method, headers: { cookie: cookies.join('; '), 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(j)}`);
    return j;
  };
  // A full-body character: a small head on top of a tall body, so a face crop is easy to tell apart.
  const { PNG } = createRequire(path.join(root, 'server/package.json'))('pngjs');
  const png = new PNG({ width: 200, height: 400 });
  for (let y = 0; y < 400; y++) for (let x = 0; x < 200; x++) {
    const i = (y * 200 + x) * 4;
    const head = (x - 100) ** 2 + (y - 70) ** 2 < 40 ** 2;
    const neck = y >= 108 && y < 125 && Math.abs(x - 100) < 14;
    const body = y >= 125 && y < 380 && Math.abs(x - 100) < 60;
    const eye = ((x - 85) ** 2 + (y - 65) ** 2 < 36) || ((x - 115) ** 2 + (y - 65) ** 2 < 36);
    const c = eye ? [20, 20, 20] : head ? [240, 190, 150] : neck ? [230, 180, 140] : body ? [60, 110, 200] : [244, 239, 233];
    png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = 255;
  }
  const picture = `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;

  const { bots: start } = await api('GET', '/bots');
  const howard = (await api('POST', '/bots', { name: 'Howard', avatarShape: 'blob', avatarColor: 'red' })).bot;
  const leonard = (await api('POST', '/bots', { name: 'Leonard', avatarShape: 'cloud', avatarColor: 'green' })).bot;
  const robin = (await api('POST', '/bots', { name: 'Robin', avatarShape: 'heart', avatarColor: 'gray' })).bot;
  await api('PUT', `/bots/${leonard.id}/avatar`, { image: picture, poses: false });

  await test('each bot gets a chat colour: its own colour, or a spare one for gray and black', async () => {
    const { bots } = await api('GET', '/bots');
    const by = Object.fromEntries(bots.map((b) => [b.name, b]));
    assert.equal(by.Howard.chatColor, 'red');
    assert.equal(by.Leonard.chatColor, 'green');
    assert.ok(by.Robin.chatColor && !['red', 'green'].includes(by.Robin.chatColor), `Robin got ${by.Robin.chatColor}`);
    assert.equal(by.Robin.chatColorAuto, true);
    const colours = bots.filter((b) => b.kind !== 'room').map((b) => b.chatColor);
    assert.equal(new Set(colours).size, colours.length, `no two bots share: ${colours}`);
  });
  await test('settings can set a chat colour, refuse a bad one, and go back to automatic', async () => {
    const set = await api('PATCH', `/bots/${robin.id}`, { chatColor: 'magenta' });
    assert.equal(set.bot.chatColor, 'magenta'); assert.equal(set.bot.chatColorAuto, false);
    await assert.rejects(api('PATCH', `/bots/${robin.id}`, { chatColor: 'black' }), /chatColor must be one of/);
    const back = await api('PATCH', `/bots/${robin.id}`, { chatColor: null });
    assert.equal(back.bot.chatColorAuto, true);
    assert.equal(back.bot.avatarImageUrl, null);
    const l = (await api('PATCH', `/bots/${leonard.id}`, { chatColor: 'violet' })).bot;
    assert.equal(l.avatarImageUrl, leonard.avatarImageUrl ?? l.avatarImageUrl, 'the picture address does not change');
    await api('PATCH', `/bots/${leonard.id}`, { chatColor: null });
  });

  const room = (await api('POST', '/rooms', { name: 'Household Huddle', botIds: [howard.id, leonard.id, robin.id] })).id;
  // Rows as the server writes them (agent/loop.ts sendToBot, agent/rooms.ts), straight into the throwaway database.
  const Database = createRequire(path.join(root, 'server/package.json'))('better-sqlite3');
  const db = new Database(path.join(dir, 'test.db'));
  const put = (botId, body, ago) => {
    const b = db.prepare('SELECT generation, next_seq FROM bots WHERE id=?').get(botId);
    db.prepare('UPDATE bots SET next_seq=next_seq+1 WHERE id=?').run(botId);
    db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)').run(botId, b.generation, b.next_seq, b.next_seq, 'message', JSON.stringify(body), Date.now() - ago);
  };
  put(howard.id, { type: 'message', role: 'user', text: 'Can you check whether the bank connector is signed in?' }, 600_000);
  put(howard.id, { type: 'message', role: 'assistant', text: 'It is. Last sync was an hour ago.' }, 590_000);
  put(howard.id, { type: 'message', role: 'user', text: 'Howard, the Chase link needs a new sign-in before tonight\'s sync.', from: { kind: 'bot', id: leonard.id, name: 'Leonard' } }, 300_000);
  put(howard.id, { type: 'message', role: 'assistant', text: 'On it. I will tell you when it is back.' }, 290_000);
  put(howard.id, { type: 'message', role: 'user', text: 'Answered a card', from: { kind: 'agent', id: 'session', name: 'Claude: test' } }, 200_000);
  put(room, { type: 'message', role: 'user', text: 'What is left for Saturday?' }, 120_000);
  put(room, { type: 'message', role: 'assistant', text: 'Budget is fine for the trip.', from: { kind: 'bot', id: leonard.id, name: 'Leonard' } }, 110_000);
  put(room, { type: 'message', role: 'assistant', text: 'I can move the grocery pickup to Friday.', from: { kind: 'bot', id: robin.id, name: 'Robin' } }, 100_000);
  put(room, { type: 'message', role: 'assistant', text: 'Backups ran fine overnight.', from: { kind: 'bot', id: howard.id, name: 'Howard' } }, 90_000);
  db.close();

  for (const theme of ['light', 'dark']) {
    await test(`another bot's message in a bot's chat wears its colour and face (${theme})`, async () => {
      await page.goto(BASE);
      await page.evaluate((t) => { localStorage.setItem('bothq.theme', t); document.documentElement.dataset.theme = t; }, theme);
      await page.locator('.bot-row', { has: page.locator('.bot-row__name', { hasText: /^Howard$/ }) }).first().click();
      const grp = page.locator('.group.is-from-bot');
      await grp.first().waitFor();
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      assert.equal(await grp.count(), 1, 'only Leonard\'s message is coloured');
      assert.equal(await grp.locator('.sender-label__name').innerText(), 'Leonard');
      assert.equal(await grp.locator('.sender-label__to').innerText(), 'to Howard');
      const name = await grp.locator('.sender-label__name').evaluate((el) => getComputedStyle(el).color);
      const want = theme === 'light' ? 'rgb(12, 116, 67)' : 'rgb(29, 195, 117)';
      assert.equal(name, want, `green name in ${theme}`);
      const src = await grp.locator('.sender-label img').getAttribute('src');
      assert.match(src, /crop=head/, 'the face crop');
      const size = await grp.locator('.sender-label__pic').evaluate((el) => el.getBoundingClientRect().width);
      assert.equal(size, 28);
      assert.match(await page.locator('.chat__pill img').getAttribute('src').catch(() => 'crop=head'), /crop=head/);
      assert.ok(await page.getByText('Sent by Claude: test · not you').isVisible(), 'a program\'s message keeps its label');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `web-bot-chat-${theme}.png`) });
    });
    await test(`each member's message in a group has its own colour (${theme})`, async () => {
      await page.locator('.bot-row', { hasText: 'Household Huddle' }).first().click();
      await page.locator('.group.is-from-bot').nth(2).waitFor();
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      const bars = await page.locator('.group.is-from-bot .bubble.is-agent').evaluateAll((els) => els.map((el) => getComputedStyle(el).boxShadow));
      assert.equal(new Set(bars).size, 3, `three different bars: ${bars.join(' | ')}`);
      assert.equal(await page.locator('.sender-label__to').count(), 0, 'no "to" line in a group');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `web-group-${theme}.png`) });
    });
  }
  await test('settings show the colour picker and save a pick', async () => {
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.locator('.bot-row', { has: page.locator('.bot-row__name', { hasText: /^Robin$/ }) }).first().click();
    await page.locator('.chat__pill').click();
    await page.getByRole('menuitem', { name: /settings/i }).first().click();
    await page.getByText('Color in chats').waitFor();
    await page.getByRole('radio', { name: 'cyan' }).click();
    await page.getByText('Use automatic').waitFor();
    const { bots } = await api('GET', '/bots');
    assert.equal(bots.find((b) => b.id === robin.id).chatColor, 'cyan');
    if (SHOTS) await page.locator('.cfg-chatcolor').screenshot({ path: path.join(SHOTS, 'web-settings-color.png') });
  });
} catch (e) {
  failures++; console.log(`FAIL setup\n     ${e.message}\n${log.slice(-1500)}`);
} finally {
  await browser?.close();
  server.kill(); hermes.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
