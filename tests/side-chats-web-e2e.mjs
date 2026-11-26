// Side chats in the web app (and so the Windows app, which loads it), in a real browser against the real
// server and a fake Hermes: + makes a side chat and opens it, a message there is answered there while the
// main chat keeps its own messages, the switcher in the header goes back and forth, rename and delete with
// Undo work (also on a working chat while the list reorders). Throwaway database; needs no Hermes. Set SHOTS=<dir> to save screenshots.
// Run after `npm run build` (web and server):   node tests/side-chats-web-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'side-chats-web-'));
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
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 400)); });
  page.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 400)));
  await page.goto(`${BASE}/`);
  await page.locator('.bot-row').first().waitFor({ timeout: 15000 });
  await page.locator('.bot-row').first().click();
  const composer = page.locator('.composer textarea, textarea').first();
  const sendText = async (t) => { await composer.fill(t); await composer.press('Enter'); };

  await test('the main chat is listed under the bot, with an empty side chat list', async () => {
    await page.locator('.bot-list__item .side-chats').waitFor();
    assert.equal(await page.locator('.bot-list__item .side-chat.is-selected .side-chat__title').innerText(), 'Main chat');
    assert.equal(await page.locator('.chat-switcher__label').innerText(), 'Main chat');
  });

  await test('a slow job in the main chat keeps working while a side chat answers', async () => {
    await sendText('slow: compare the flights');
    await page.locator('.transcript').getByText('Still checking the flights').waitFor();
    await page.locator('.bot-list__item .side-chats__add').click();
    await page.waitForFunction(() => document.querySelector('.chat-switcher__label')?.textContent === 'New chat');
    await sendText('Make the grocery list for this week');
    await page.locator('.transcript').getByText("Here is this week's grocery list").waitFor();
    await page.waitForFunction(() => document.querySelector('.chat-switcher__label')?.textContent === 'Make the grocery list for this week');
    assert.equal(await page.locator('.transcript').getByText('Still checking the flights').count(), 0, 'the main chat is not shown here');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'web-side-chat.png') });
  });

  await test('the header switcher lists the chats and goes back to the main chat', async () => {
    await page.locator('.chat-switcher__btn').click();
    await page.locator('.chat-switcher__menu').waitFor();
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'web-switcher.png') });
    await page.locator('.chat-switcher__menu .side-chat').filter({ hasText: 'Main chat' }).click();
    await page.locator('.transcript').getByText('Still checking the flights').waitFor();
    assert.equal(await page.locator('.transcript').getByText("Here is this week's grocery list").count(), 0);
    // The working main chat and the side chat each show their own state.
    assert.equal(await page.locator('.bot-list__item .side-chat .side-chat__dot.is-working').count(), 1);
  });

  await test('rename and delete with Undo', async () => {
    const row = page.locator('.bot-list__item .side-chat').filter({ hasText: 'grocery' });
    await row.hover();
    await row.getByRole('button', { name: /^Rename/ }).click();
    const input = page.locator('.side-chat__rename input');
    await input.fill('Groceries');
    await input.press('Enter');
    await page.locator('.bot-list__item .side-chat__title', { hasText: 'Groceries' }).waitFor();
    const g = page.locator('.bot-list__item .side-chat').filter({ hasText: 'Groceries' });
    await g.hover();
    await g.getByRole('button', { name: /^Delete/ }).click();
    await page.getByText('Deleted the side chat "Groceries".').waitFor();
    assert.equal(await page.locator('.bot-list__item .side-chat__title', { hasText: 'Groceries' }).count(), 0);
    await page.locator('.undo-toast__btn').click();
    await page.locator('.bot-list__item .side-chat__title', { hasText: 'Groceries' }).waitFor();
    await page.locator('.transcript').getByText("Here is this week's grocery list").waitFor();
  });

  await test('a working side chat can be renamed while the list reorders around it', async () => {
    // Reported 2026-11-25: renaming a running side chat did not stick. A side chat that is working, above Groceries.
    await page.locator('.bot-list__item .side-chats__add').click();
    await page.waitForFunction(() => document.querySelector('.chat-switcher__label')?.textContent === 'New chat');
    await sendText('slow: book the hotel');
    await page.locator('.transcript').getByText('Still checking the flights').waitFor();
    await page.waitForFunction(() => document.querySelector('.bot-list__item .side-chat__open .side-chat__title')?.textContent === 'slow: book the hotel');
    const titles = () => page.locator('.bot-list__item .side-chat__open .side-chat__title').allInnerTexts();
    const hotel = page.locator('.bot-list__item .side-chat').filter({ hasText: 'slow: book the hotel' });
    await hotel.hover();
    await hotel.getByRole('button', { name: /^Rename/ }).click();
    const input = page.locator('.side-chat__rename input');
    await input.fill('Hot');
    // Groceries gets a new answer (asked from another device), which would move it above the chat being renamed.
    const bots = await page.evaluate(() => fetch('/api/bots').then((r) => r.json()));
    const botId = (bots.bots ?? bots).find((b) => b.isPrimary)?.id ?? (bots.bots ?? bots)[0].id;
    const list = await page.evaluate((id) => fetch(`/api/bots/${id}/side-chats`).then((r) => r.json()), botId);
    const hotelId = list.chats.find((c) => c.title === 'slow: book the hotel').id;
    const groceriesId = list.chats.find((c) => c.title === 'Groceries').id;
    assert.equal(list.chats.find((c) => c.id === hotelId).live.isRunning, true, 'the hotel chat is working');
    const sent = await page.evaluate((id) => fetch(`/api/bots/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'add grocery: milk' }) }).then((r) => r.status), groceriesId);
    assert.ok(sent < 300, `sent: ${sent}`);
    await page.waitForFunction(async (id) => { const r = await fetch(`/api/bots/${id}/side-chats`).then((x) => x.json()); return r.chats[0].title === 'Groceries'; }, botId);
    await sleep(800);
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.side-chat__rename') != null), true, 'the name field kept focus');
    assert.equal(await input.inputValue(), 'Hot', 'the field was not saved or closed early');
    await input.press('End');
    await page.keyboard.type('el trip');
    await input.press('Enter');
    await page.locator('.bot-list__item .side-chat__title', { hasText: 'Hotel trip' }).waitFor();
    // Once the name is saved the list catches up: Groceries (newest) first.
    await page.waitForFunction(() => document.querySelector('.bot-list__item .side-chat__open .side-chat__title')?.textContent === 'Groceries');
    assert.deepEqual((await titles()).slice(0, 2), ['Groceries', 'Hotel trip']);
    const after = await page.evaluate((id) => fetch(`/api/bots/${id}/side-chats`).then((r) => r.json()), botId);
    const h = after.chats.find((c) => c.id === hotelId);
    assert.equal(h.title, 'Hotel trip');
    assert.equal(h.live.isRunning, true, 'the turn kept running through the rename');
    assert.equal(await page.locator('.chat-switcher__label').innerText(), 'Hotel trip', 'the header chip shows the new name');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'web-rename-running.png') });
  });

  await test('on a phone the switcher is an icon next to the name', async () => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: SHOTS ? 2 : 1, hasTouch: true, isMobile: true });
    await phone.addCookies(cookies.map((c) => { const [n, ...v] = c.split('='); return { name: n, value: v.join('='), url: BASE }; }));
    const p = await phone.newPage();
    await p.goto(`${BASE}/`);
    await p.locator('.bot-row').first().click();
    await sleep(800);
    await p.locator('.chat-switcher__btn').click({ timeout: 5000 });
    await p.locator('.chat-switcher__menu .side-chat').first().waitFor();
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'phone-web-switcher.png') });
    const box = await p.locator('.chat-switcher__menu').boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, 'the list fits the screen');
    await phone.close();
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
