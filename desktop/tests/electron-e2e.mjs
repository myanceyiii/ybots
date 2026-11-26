// Drives the real Electron app (Playwright's _electron) against a small local stand-in for the Cleft
// Bot server. Run under a display (xvfb-run on Linux). Checks first-run setup, sign-in by link, the
// navigation and permission locks, and that the web app gets no bridge into the shell.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { makeZip } from './zip-helper.mjs';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');
const executablePath = require('electron'); // the path to the Electron binary when required from Node

const TOKEN = 'T'.repeat(32);
const PAIR_TOKEN = 'P'.repeat(32);
const SECRET = 's'.repeat(43);
let linkUsed = false;
let pairAllowed = false;
let pairDevice = '';
let down = false; // the address answers, but with a proxy's 502 page
const sent = []; // messages Quick Chat posted
const uploads = []; // files Quick Chat attached
const BOTS = {
  bots: [
    { id: 'howard', name: 'Howard', isPrimary: true, unread: 0, lastActivityAt: 10, chatColor: 'blue' },
    { id: 'leonard', name: 'Leonard', unread: 2, lastActivityAt: 30, chatColor: 'green' },
    { id: 'robin', name: 'Robin', unread: 0, lastActivityAt: 20, chatColor: 'magenta' },
  ],
  live: [{ botId: 'howard', isRunning: true, awaiting: { reason: 'approval', since: 1 } }],
};
// An update the stand-in server offers: a small zip, signed with a key made here.
const updateKey = crypto.generateKeyPairSync('ed25519');
const otherKey = crypto.generateKeyPairSync('ed25519');
const UPDATE_PUB = updateKey.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const updateZip = makeZip([{ name: 'YanceyBot.exe', data: 'MZ pretend app' }, { name: 'resources/app.asar', data: 'pretend asar' }]);
const updateSha = crypto.createHash('sha256').update(updateZip).digest('hex');
const signUpdate = (version, key) => crypto.sign(null, Buffer.from(`yanceybot-update:v1:${version}:${updateSha}:${updateZip.length}`), key).toString('base64');
const offer = { on: false, version: '9.1.0', key: updateKey.privateKey, corrupt: false };
const deviceHeaders = new Set();
const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const server = http.createServer((req, res) => {
  const signedIn = (req.headers.cookie ?? '').includes('bothq_session=ok');
  if (req.method === 'POST' && req.url === '/api/auth/pair') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      pairDevice = JSON.parse(body).device;
      // The server names itself by another host (as Host2 does with its tailnet name).
      json(res, 200, { id: 'pairing-id-0123456789', code: 'K7P-4QD', secret: SECRET, expiresAt: Date.now() + 120_000, url: 'https://host2.example.ts.net/pair/pairing-id-0123456789' });
    });
    return;
  }
  if (req.url === '/api/auth/pair/pairing-id-0123456789') {
    if (req.headers['x-pair-secret'] !== SECRET) return json(res, 404, { state: 'gone' });
    return json(res, 200, pairAllowed ? { state: 'allowed', link: `https://host2.example.ts.net/api/auth/link/${PAIR_TOKEN}` } : { state: 'waiting' });
  }
  if (req.url === `/api/auth/link/${PAIR_TOKEN}`) {
    res.writeHead(302, { 'set-cookie': 'bothq_session=ok; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400', location: '/' });
    return res.end();
  }
  if (req.url === `/api/auth/link/${TOKEN}`) {
    if (linkUsed) return res.writeHead(410).end('used');
    linkUsed = true;
    res.writeHead(302, { 'set-cookie': 'bothq_session=ok; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400', location: '/' });
    return res.end();
  }
  if (req.url.startsWith('/api/')) deviceHeaders.add(req.headers['x-cleft-device'] ?? '(none)');
  if (req.url === '/api/desktop/latest') {
    if (!signedIn) return json(res, 401, { error: 'not signed in' });
    if (!offer.on) return json(res, 200, { version: null });
    return json(res, 200, { version: offer.version, file: `yanceybot-windows-${offer.version}.zip`, size: updateZip.length, sha256: updateSha, sig: signUpdate(offer.version, offer.key), notes: 'Faster and tidier.' });
  }
  if (req.url === `/api/desktop/download/yanceybot-windows-${offer.version}.zip`) {
    if (!signedIn) return json(res, 401, { error: 'not signed in' });
    const body = offer.corrupt ? Buffer.concat([Buffer.from('XX'), updateZip.subarray(2)]) : updateZip;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
    return res.end(body);
  }
  if (req.url === '/api/bots') return signedIn ? json(res, 200, BOTS) : json(res, 401, { error: 'not signed in' });
  if (req.method === 'PUT' && /^\/api\/bots\/[a-z]+\/attachments\?name=/.test(req.url)) {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      if (!signedIn) return json(res, 401, { error: 'not signed in' });
      const name = decodeURIComponent(req.url.split('name=')[1]);
      if (name === 'setup.exe') return json(res, 400, { error: "Programs and installers (.exe) can't be attached." });
      uploads.push({ bot: req.url.split('/')[3], name, bytes: Buffer.concat(chunks), type: req.headers['content-type'] });
      json(res, 200, { file: { path: `uploads/2026-11-24/${name}`, name } });
    });
    return;
  }
  if (req.method === 'POST' && /^\/api\/bots\/[a-z]+\/messages$/.test(req.url)) {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (!signedIn) return json(res, 401, { error: 'not signed in' });
      sent.push({ bot: req.url.split('/')[3], ...JSON.parse(body), origin: req.headers.origin ?? null });
      json(res, 200, { row: { seq: sent.length } });
    });
    return;
  }
  if (req.url === '/file.txt') {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="notes.txt"' });
    return res.end('hello from a bot');
  }
  if (down && !req.url.startsWith('/api/')) {
    res.writeHead(502, { 'content-type': 'text/html' });
    return res.end('<!doctype html><title>502 Bad Gateway</title>bad gateway');
  }
  if (req.url === '/frame') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><title>frame</title>');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>${signedIn ? 'Fake Cleft (signed in)' : 'Fake Cleft (signed out)'}</title><a id="out" href="https://example.com/">out</a>
<p>The quick brown fox. Another fox. A third fox.</p><a id="dl" href="/file.txt" download>file</a>
<script>window.__keys = []; addEventListener('keydown', (e) => window.__keys.push((e.ctrlKey ? 'ctrl+' : '') + (e.altKey ? 'alt+' : '') + (e.shiftKey ? 'shift+' : '') + e.key.toLowerCase()));</script>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cleft-desktop-'));
const updatesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleft-updates-'));
const app = await electron.launch({
  executablePath,
  args: [appDir, '--use-fake-device-for-media-stream', '--no-sandbox'],
  env: { ...process.env, CLEFT_USER_DATA: userData, CLEFT_TEST: '1', CLEFT_UPDATES_DIR: updatesDir, CLEFT_TEST_UPDATE_KEY: UPDATE_PUB },
});
const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleft-downloads-'));
const pageOf = async (name, timeout = 8000) => {
  const until = Date.now() + timeout;
  for (;;) {
    const p = app.windows().find((w) => w.url().includes(`/pages/${name}`));
    if (p) return p;
    if (Date.now() > until) throw new Error(`no ${name} window`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const savedSettings = () => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
let failed = false;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 4).join(' | ')}`);
  }
};

try {
  const win = await app.firstWindow();
  // Record what the window tried to open outside, instead of really opening a browser.
  await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (u) => void globalThis.__opened.push(u);
  });

  await step('first run shows the address page', async () => {
    await win.waitForSelector('#address');
    assert.match(win.url(), /^file:.*setup\.html/);
  });

  await step('a bad address is refused with a readable error', async () => {
    await win.fill('#address', 'http://example.com');
    await win.click('#address-form button[type=submit]');
    await win.waitForFunction(() => document.getElementById('address-error').textContent.length > 0);
    assert.match(await win.textContent('#address-error'), /https/);
  });

  await step('a good address is remembered and a sign-in QR code shows', async () => {
    await win.fill('#address', origin);
    await win.click('#address-form button[type=submit]');
    await win.waitForSelector('#pair-qr svg');
    assert.equal(await win.textContent('#pair-code'), 'K7P-4QD');
    assert.ok(pairDevice.length > 0, 'the PC sent its name');
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    assert.equal(saved.address, origin);
  });

  await step('when the phone allows it, the window signs in on our own address', async () => {
    pairAllowed = true;
    await win.waitForURL(`${origin}/`, { timeout: 10_000 });
    await win.waitForFunction(() => document.title.includes('signed in'));
  });

  await step('the web app gets no bridge into the shell', async () => {
    assert.equal(await win.evaluate(() => typeof window.cleftSetup), 'undefined');
    for (const name of ['cleftApp', 'cleftQuick', 'cleftFind', 'cleftRemote', 'cleftBar']) assert.equal(await win.evaluate((n) => typeof window[n], name), 'undefined', name);
    // What it does get can show the window, notify, set the theme and clear notices. Nothing else.
    assert.deepEqual(await win.evaluate(() => Object.keys(window.cleftShell).sort()), ['clear', 'notify', 'onOpenChat', 'onTalk', 'setTheme', 'show', 'talkPopup']);
    assert.equal(await win.evaluate(() => typeof require), 'undefined');
  });

  await step('a link to another site opens in the browser, not the window', async () => {
    await win.evaluate(() => document.getElementById('out').click());
    await win.waitForTimeout(500);
    assert.equal(win.url(), `${origin}/`);
    assert.deepEqual(await app.evaluate(() => globalThis.__opened), ['https://example.com/']);
  });

  await step('window.open to another site does not make a window', async () => {
    await win.evaluate(() => window.open('https://example.org/'));
    await win.waitForTimeout(300);
    assert.equal(app.windows().length, 1);
    assert.ok((await app.evaluate(() => globalThis.__opened)).includes('https://example.org/'));
  });

  await step('a file: navigation is dropped', async () => {
    await win.evaluate(() => { location.href = 'file:///etc/passwd'; });
    await win.waitForTimeout(300);
    assert.equal(win.url(), `${origin}/`);
  });

  await step('our origin may use the microphone', async () => {
    const r = await win.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => (s.getTracks().forEach((t) => t.stop()), 'ok'), (e) => e.name));
    assert.equal(r, 'ok');
  });

  await step('our origin may not use the camera or capture the screen', async () => {
    const cam = await win.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'ok', (e) => e.name));
    assert.notEqual(cam, 'ok');
    const screen = await win.evaluate(() => navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => 'ok', (e) => e.name));
    assert.notEqual(screen, 'ok');
  });

  await step('our origin may show notifications; a frame from another origin gets no mic', async () => {
    assert.equal(await win.evaluate(() => Notification.requestPermission()), 'granted');
    await win.evaluate((src) => new Promise((r) => { const f = document.createElement('iframe'); f.src = src; f.onload = r; document.body.append(f); }), `http://localhost:${port}/frame`);
    const frame = win.frames().find((f) => f.url().startsWith(`http://localhost:${port}`));
    assert.ok(frame, 'frame loaded');
    const mic = await frame.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'ok', (e) => e.name)).catch((e) => e.message);
    assert.notEqual(mic, 'ok');
  });

  await step('something that is not a sign-in link is refused', async () => {
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find((i) => i.label.startsWith('Sign in with a link')).click());
    await win.waitForSelector('#link-form:not([hidden])');
    await win.fill('#link', `${origin}/api/auth/owner`);
    await win.click('#link-form button[type=submit]');
    await win.waitForFunction(() => document.getElementById('link-error').textContent.length > 0);
    assert.match(await win.textContent('#link-error'), /not a sign-in link/);
  });

  await step('a sign-in link for our YBots signs the window in', async () => {
    await win.fill('#link', `${origin}/api/auth/link/${TOKEN}`);
    await win.click('#link-form button[type=submit]');
    await win.waitForURL(`${origin}/`);
    await win.waitForFunction(() => document.title.includes('signed in'));
    assert.ok(linkUsed, 'the pasted link was used');
  });

  await step('closing the window keeps the app in the tray', async () => {
    const r = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.close();
      return { alive: !w.isDestroyed(), visible: w.isVisible() };
    });
    assert.deepEqual(r, { alive: true, visible: false });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  });

  await step('the window has the YBots icon file', async () => {
    assert.ok(fs.statSync(path.join(appDir, 'src/assets/icon.png')).size > 1000);
  });


  // ---------- 0.9.0: the shell's own features ----------
  const main = () => app.evaluate(({ BrowserWindow }, o) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith(o)); return w ? { bounds: w.getBounds(), zoom: w.webContents.getZoomFactor(), visible: w.isVisible() } : null; }, origin);

  await step('the title count and the bot list say who needs you', async () => {
    await win.evaluate(() => { document.title = '(2) YBots'; });
    await win.waitForTimeout(1500);
    const t = await app.evaluate(() => globalThis.__yb.tray);
    assert.equal(t.count, 2);
    assert.deepEqual(t.attention.bots.map((b) => `${b.name}:${b.state}`), ['Howard:waiting', 'Leonard:unread']);
    const labels = await app.evaluate(() => globalThis.__yb.trayMenu());
    assert.ok(labels.includes('Howard is waiting for you') && labels.includes('Leonard: 2 new messages'), labels.join(' | '));
    await win.evaluate(() => { document.title = 'YBots (signed in)'; });
    await win.waitForTimeout(300);
    assert.equal((await app.evaluate(() => globalThis.__yb.tray)).count, 0);
  });

  await step('a menu item presses the web app\'s own shortcut for it', async () => {
    await win.evaluate(() => { window.__keys.length = 0; });
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find((i) => i.label.startsWith('Search')).click());
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find((i) => i.label.startsWith('New conversation')).click());
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((m) => m.label.includes('Go')).submenu.items.find((i) => i.label.startsWith('Next chat')).click());
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((m) => m.label.includes('Help')).submenu.items.find((i) => i.label.startsWith('App settings')).click());
    await win.waitForTimeout(300);
    const keys = await win.evaluate(() => window.__keys);
    for (const k of ['ctrl+k', 'ctrl+shift+o', 'alt+arrowdown', 'ctrl+,']) assert.ok(keys.includes(k), `${k} in ${keys.join(' ')}`);
  });

  await step('zoom is applied and remembered', async () => {
    await app.evaluate(() => globalThis.__yb.runCommand('zoom-in'));
    await win.waitForTimeout(200);
    assert.equal(Math.round((await main()).zoom * 100), 110);
    assert.equal(savedSettings().zoom, 1.1);
  });

  await step('find on the page counts the matches', async () => {
    await app.evaluate(() => globalThis.__yb.runCommand('find'));
    const bar = await pageOf('find.html');
    await bar.fill('#q', 'fox');
    await bar.waitForFunction(() => /of 3/.test(document.getElementById('count').textContent), null, { timeout: 5000 });
    await bar.press('#q', 'Enter');
    await bar.waitForFunction(() => /^2 of 3/.test(document.getElementById('count').textContent), null, { timeout: 5000 });
    await bar.fill('#q', 'zebra');
    await bar.waitForFunction(() => document.getElementById('count').textContent === 'No matches', null, { timeout: 5000 });
    await bar.press('#q', 'Escape');
    await win.waitForTimeout(200);
    assert.equal(await app.evaluate(() => globalThis.__yb.findBar.visible), false);
  });

  await step('the settings window changes only what it may, and saves it', async () => {
    await app.evaluate(() => globalThis.__yb.showSettings());
    const page = await pageOf('settings.html');
    await page.waitForFunction(() => document.getElementById('about').textContent.includes('Connected to'));
    assert.equal(win.url(), `${origin}/`, 'the chat stays open behind the settings window');
    await page.uncheck('input[data-key="notifications.sound"]');
    await page.waitForTimeout(200);
    assert.equal(savedSettings().notifications.sound, false);
    assert.equal(savedSettings().notifications.enabled, true);
    const refused = await page.evaluate(() => window.cleftApp.set('address', 'https://evil.example.com').then(() => 'changed', (e) => String(e.message)));
    assert.match(refused, /cannot be changed/);
    assert.equal(savedSettings().address, origin);
    assert.match(await page.evaluate(() => window.cleftApp.action('format-disk').then(() => 'ran', (e) => String(e.message))), /refused/);
    // The shortcut recorder.
    await page.click('#shortcut');
    await page.keyboard.press('Control+Alt+J');
    await page.waitForFunction(() => document.getElementById('shortcut').textContent === 'Ctrl+Alt+J');
    assert.equal(savedSettings().quickChat.shortcut, 'Ctrl+Alt+J');
    assert.match(await page.evaluate(() => window.cleftApp.set('quickChat.shortcut', 'J').then(() => 'changed', (e) => String(e.message))), /Ctrl, Alt/);
    // Downloads go straight to a folder, for the download step below.
    await page.uncheck('input[data-key="downloads.ask"]');
    await page.waitForTimeout(200);
    assert.equal(savedSettings().downloads.ask, false);
  });

  await step('Settings changes the text size; "Use this PC" opens only shared folders', async () => {
    await app.evaluate(() => globalThis.__yb.showSettings());
    const page = await pageOf('settings.html');
    await page.waitForFunction(() => /%$/.test(document.getElementById('zoom').textContent));
    const before = await page.textContent('#zoom');
    await page.click('[data-action="zoom-in"]');
    await page.waitForFunction((b) => document.getElementById('zoom').textContent !== b, before);
    await page.click('[data-action="zoom-out"]');
    await page.waitForFunction((b) => document.getElementById('zoom').textContent === b, before);
    assert.equal(await page.isVisible('[data-action="sign-out"]'), true);
    await app.evaluate(() => globalThis.__yb.showRemote());
    const remote = await pageOf('remote.html');
    assert.match(await remote.evaluate(() => window.cleftRemote.openFolder('/etc').then(() => 'opened', (e) => String(e.message))), /not shared/);
    assert.deepEqual((await remote.evaluate(() => window.cleftRemote.clearLog())).log, []);
    await remote.close();
  });

  await step('Quick Chat lists the bots and sends one message as the person', async () => {
    await app.evaluate(() => globalThis.__yb.quick.show());
    const q = await pageOf('quick.html');
    await q.waitForSelector('.bot[data-id="howard"]');
    assert.deepEqual(await q.$$eval('.bot', (els) => els.map((e) => e.dataset.id)), ['howard', 'leonard', 'robin']);
    assert.equal(await q.getAttribute('.bot[data-id="howard"]', 'aria-checked'), 'true', 'the main bot is picked first');
    await q.click('.bot[data-id="leonard"]');
    await q.fill('#text', 'What is left in groceries this month?');
    await q.press('#text', 'Enter');
    await q.waitForFunction(() => document.getElementById('status').textContent.startsWith('Sent to Leonard'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].bot, 'leonard');
    assert.equal(sent[0].text, 'What is left in groceries this month?');
    assert.match(sent[0].clientId, /^quick-[0-9a-f-]{36}$/);
    assert.equal(sent[0].origin, null, 'no Origin header, so the server treats it as its own app');
    assert.equal(await q.inputValue('#text'), '');
    await win.waitForTimeout(1400);
    assert.equal(savedSettings().quickChat.lastBot, 'leonard');
    assert.equal(await app.evaluate(() => globalThis.__yb.quick.window.isVisible()), false, 'it gets out of the way after sending');
    // Refused ids never reach the server.
    assert.match(await q.evaluate(() => window.cleftQuick.send('../auth/logout', 'x').then(() => 'sent', (e) => String(e.message))), /Pick a bot/);
    assert.equal(sent.length, 1);
  });

  await step('Quick Chat sends files and pictures with a message, and says why one was refused', async () => {
    // A tiny real PNG (1x1), as a pasted picture or a screenshot would be.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await app.evaluate((_e, b64) => { globalThis.__yb.quick.add('notes.txt', Buffer.from('milk, eggs')); globalThis.__yb.quick.add('Pasted picture 2026-11-24 10.00.00.png', Buffer.from(b64, 'base64')); }, png);
    await app.evaluate(() => globalThis.__yb.quick.show());
    const q = await pageOf('quick.html');
    await q.waitForSelector('.file');
    assert.deepEqual(await q.$$eval('.file b', (els) => els.map((e) => e.textContent)), ['notes.txt', 'Pasted picture 2026-11-24 10.00.00.png']);
    assert.equal(await q.$$eval('.file img', (els) => els.length), 1, 'the picture shows a preview');
    assert.equal(await app.evaluate(() => globalThis.__yb.quick.window.getBounds().height), 300, 'the window grows to show them');
    assert.equal(await q.isDisabled('#send'), false, 'files alone can be sent');
    await q.click('.file .x >> nth=0');
    await q.waitForFunction(() => document.querySelectorAll('.file').length === 1);
    await q.click('.bot[data-id="robin"]');
    await q.fill('#text', 'What is this?');
    await q.press('#text', 'Enter');
    await q.waitForFunction(() => document.getElementById('status').textContent.startsWith('Sent to Robin'));
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].bot, 'robin');
    assert.equal(uploads[0].type, 'application/octet-stream');
    assert.equal(uploads[0].bytes.toString('base64'), png);
    assert.deepEqual(sent.at(-1).attachments, ['uploads/2026-11-24/Pasted picture 2026-11-24 10.00.00.png']);
    assert.equal(sent.at(-1).text, 'What is this?');
    assert.equal(await q.$$eval('.file', (els) => els.length), 0);
    await win.waitForTimeout(1400);
    // A refused file: the server's reason shows, nothing is sent, and the file is still there to remove.
    const before = sent.length;
    await app.evaluate(() => { globalThis.__yb.quick.add('setup.exe', Buffer.from('MZ')); globalThis.__yb.quick.show(); });
    await q.waitForSelector('.file');
    await q.press('#text', 'Enter');
    await q.waitForFunction(() => /can't be attached/.test(document.getElementById('status').textContent));
    assert.equal(sent.length, before);
    await q.click('.file .x');
    await q.waitForFunction(() => document.querySelectorAll('.file').length === 0);
    assert.equal(await app.evaluate(() => globalThis.__yb.quick.window.getBounds().height), 228);
    // The limits are the server's own: 8 files, 25 MB each.
    assert.match(await app.evaluate(() => { try { globalThis.__yb.quick.add('big.bin', Buffer.alloc(25 * 1024 * 1024 + 1)); return 'added'; } catch (e) { return e.message; } }), /larger than 25 MB/);
    await q.press('#text', 'Escape');
  });

  await step('the Talk shortcut opens a small popup at the bottom of the screen with the quick-ask page', async () => {
    // The main window's page may not drive the popup.
    assert.match(await win.evaluate(() => window.cleftShell.talkPopup.resize(500).then(() => 'resized', (e) => String(e.message))), /refused/);
    await app.evaluate(() => globalThis.__yb.talk().show());
    let pop = null;
    for (let i = 0; i < 80 && !pop; i++) { pop = app.windows().find((w) => w.url().includes('?talk&popup=1')) ?? null; if (!pop) await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(pop, 'the popup loads /?talk&popup=1 from the signed-in address');
    assert.ok(pop.url().startsWith(origin));
    await pop.waitForLoadState();
    const b1 = await app.evaluate(({ screen }) => ({ b: globalThis.__yb.talk().window.getBounds(), area: screen.getPrimaryDisplay().workArea, top: globalThis.__yb.talk().window.isAlwaysOnTop() }));
    assert.ok(b1.top, 'over other windows');
    assert.ok(b1.b.y + b1.b.height >= b1.area.y + b1.area.height - 40, 'at the bottom of the screen');
    // The page sets the height (the card grows with the answer); the bottom edge stays put.
    assert.equal(await pop.evaluate(() => window.cleftShell.talkPopup.resize(300)), true);
    const b2 = await app.evaluate(() => globalThis.__yb.talk().window.getBounds());
    assert.equal(b2.height, 300);
    assert.equal(b2.y + b2.height, b1.b.y + b1.b.height);
    // Share screen: a JPEG of the screen, taken only when asked.
    const shot = await pop.evaluate(() => window.cleftShell.talkPopup.captureScreen().then((r) => ({ type: r.type, n: r.data.length }), (e) => ({ error: String(e.message) })));
    assert.ok(shot.error || (shot.type === 'image/jpeg' && shot.n > 100), JSON.stringify(shot));
    assert.equal(await app.evaluate(() => globalThis.__yb.talk().window.getOpacity()), 1, 'back in view after the picture');
    // Open in app: the popup goes away and the main window shows that chat.
    await pop.evaluate(() => window.cleftShell.talkPopup.openChat('leonard'));
    assert.equal(await app.evaluate(() => globalThis.__yb.talk().window.isVisible()), false);
    // Pressed again: shown again (and told to start over) without loading the page again.
    await app.evaluate(() => globalThis.__yb.talk().show());
    assert.equal(await app.evaluate(() => globalThis.__yb.talk().window.isVisible()), true);
    await pop.evaluate(() => window.cleftShell.talkPopup.close());
    assert.equal(await app.evaluate(() => globalThis.__yb.talk().window.isVisible()), false);
    // Gone for the steps below, which look for the main window by its address.
    await app.evaluate(() => globalThis.__yb.talk().window.destroy());
  });

  await step('a download goes to the chosen folder under a free name', async () => {
    await app.evaluate((_e, dir) => { globalThis.__yb.setDownloadsFolder(dir); }, downloadsDir);
    fs.writeFileSync(path.join(downloadsDir, 'notes.txt'), 'already here');
    await win.evaluate(() => document.getElementById('dl').click());
    const target = path.join(downloadsDir, 'notes (1).txt');
    for (let i = 0; i < 50 && !fs.existsSync(target); i++) await win.waitForTimeout(100);
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello from a bot');
    assert.equal(fs.readFileSync(path.join(downloadsDir, 'notes.txt'), 'utf8'), 'already here', 'the file that was there is untouched');
  });

  await step('a yanceybot:// link opens a chat; anything else in it is ignored', async () => {
    const got = await app.evaluate(async ({ BrowserWindow }, o) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith(o));
      const sends = [];
      const real = w.webContents.send.bind(w.webContents);
      w.webContents.send = (ch, ...a) => { sends.push([ch, ...a]); real(ch, ...a); };
      globalThis.__yb.runLaunch(globalThis.__yb.parseLaunch(['YanceyBot.exe', 'yanceybot://chat/leonard']));
      globalThis.__yb.runLaunch(globalThis.__yb.parseLaunch(['YanceyBot.exe', 'yanceybot://approve/123']));
      w.webContents.send = real;
      return sends;
    }, origin);
    assert.deepEqual(got, [['cleft:open-chat', 'leonard']]);
  });

  await step('a proxy error page becomes the offline page, which comes back by itself', async () => {
    down = true;
    await app.evaluate(() => globalThis.__yb.runCommand('reload'));
    await win.waitForURL(/offline\.html/, { timeout: 8000 });
    await win.waitForFunction(() => /restarting/.test(document.getElementById('title').textContent));
    assert.match(await win.textContent('#countdown'), /Trying again in \d second/);
    down = false;
    await win.waitForURL(`${origin}/`, { timeout: 12_000 });
    await win.waitForFunction(() => document.title.includes('signed in'));
  });

  await step('diagnostics never include a sign-in link or the pairing secret', async () => {
    const text = await app.evaluate(() => globalThis.__yb.diagnostics());
    assert.match(text, /YBots for Windows \d+\.\d+\.\d+/);
    assert.ok(!text.includes(TOKEN) && !text.includes(PAIR_TOKEN) && !text.includes(SECRET));
  });

  await step('the window opens again where it was left', async () => {
    await app.evaluate(({ BrowserWindow }, o) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith(o)).setBounds({ x: 40, y: 30, width: 1000, height: 640 }); }, origin);
    await win.waitForTimeout(700);
    const w = savedSettings().window;
    assert.equal(w.width, 1000);
    assert.equal(w.height, 640);
  });

  await step('requests to YBots name this PC', async () => {
    await app.evaluate(() => globalThis.__yb.updater.check({ manual: true }));
    assert.deepEqual([...deviceHeaders].filter((h) => h !== '(none)').map((h) => h.split(',')[0]), ['YBots for Windows']);
  });

  await step('updates: nothing on the server, then one signed by a stranger, then a damaged download', async () => {
    const check = () => app.evaluate(() => globalThis.__yb.updater.check({ manual: true }));
    assert.equal((await check()).phase, 'unavailable');
    Object.assign(offer, { on: true, key: otherKey.privateKey });
    let s = await check();
    assert.equal(s.phase, 'failed');
    assert.match(s.text, /not signed by the YBots build server/);
    Object.assign(offer, { key: updateKey.privateKey, corrupt: true });
    s = await check();
    assert.equal(s.phase, 'failed');
    assert.match(s.text, /does not match its signature/);
    assert.deepEqual(fs.readdirSync(updatesDir).filter((n) => /^\d/.test(n)), [], 'nothing was unpacked');
  });

  await step('updates: a signed version is fetched, checked, unpacked and shown as ready in Settings', async () => {
    offer.corrupt = false;
    const s = await app.evaluate(() => globalThis.__yb.updater.check({ manual: true }));
    assert.equal(s.phase, 'ready', s.text);
    assert.equal(s.version, '9.1.0');
    assert.equal(fs.readFileSync(path.join(updatesDir, '9.1.0', 'YanceyBot.exe'), 'utf8'), 'MZ pretend app');
    assert.equal(JSON.parse(fs.readFileSync(path.join(updatesDir, '9.1.0', '.complete'), 'utf8')).sha256, updateSha);
    assert.equal(fs.existsSync(path.join(updatesDir, 'download')), false, 'the zip is removed once unpacked');
    await app.evaluate(() => globalThis.__yb.showSettings());
    const page = await pageOf('settings.html');
    await page.waitForFunction(() => /9\.1\.0 is available/.test(document.getElementById('update-status').textContent));
    assert.equal(await page.isHidden('#restart-to-update'), true, 'a development run cannot restart into it');
    assert.match(await page.textContent('#update-notes'), /Faster and tidier/);
    assert.ok((await app.evaluate(() => globalThis.__yb.diagnostics())).includes('Updates: automatic; YBots 9.1.0 is available.'));
    await page.close();
    offer.on = false;
  });

  await step('the sign-in, the window size and the zoom survive a restart', async () => {
    await app.close();
    const again = await electron.launch({ executablePath, args: [appDir, '--no-sandbox'], env: { ...process.env, CLEFT_USER_DATA: userData, CLEFT_TEST: '1' } });
    const w2 = await again.firstWindow();
    await w2.waitForURL(`${origin}/`);
    await w2.waitForFunction(() => document.title.includes('signed in'));
    const state = await again.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { size: w.getSize(), zoom: w.webContents.getZoomFactor() }; });
    assert.deepEqual(state.size, [1000, 640]);
    assert.equal(Math.round(state.zoom * 100), 110);
    await again.close();
  });

  await step('a settings file cut off mid-write is set aside and the app still starts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleft-bad-'));
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"address": "https://cleft.exam');
    const again = await electron.launch({ executablePath, args: [appDir, '--no-sandbox'], env: { ...process.env, CLEFT_USER_DATA: dir, CLEFT_TEST: '1' } });
    const w = await again.firstWindow();
    await w.waitForSelector('#address');
    assert.ok(fs.readdirSync(dir).some((f) => /^settings\.bad-\d+\.json$/.test(f)), 'the unreadable file is kept beside it');
    await again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await step('updates: a copy hands over to a newer unpacked version, and stops trying one that never comes up', async () => {
    // The "newer version" here is a script that only notes it was started, so it never comes up.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleft-handoff-'));
    const note = path.join(dir, 'started.txt');
    fs.mkdirSync(path.join(dir, '99.0.0'));
    fs.writeFileSync(path.join(dir, '99.0.0', path.basename(executablePath)), `#!/bin/sh\necho "$@" >> "${note}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, '99.0.0', '.complete'), '{}');
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cleft-handoff-data-'));
    const run = (ms) => new Promise((resolve) => {
      const child = spawn(executablePath, [appDir, '--no-sandbox', '--hidden'], { env: { ...process.env, CLEFT_USER_DATA: data, CLEFT_UPDATES_DIR: dir, CLEFT_TEST_APPLY: '1', CLEFT_NO_TRAY: '1' }, stdio: 'ignore' });
      const t = setTimeout(() => { child.kill('SIGKILL'); }, ms);
      child.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
    });
    for (let i = 1; i <= 2; i++) {
      const r = await run(15000);
      assert.equal(r.code, 0, `try ${i} handed over and ended`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).attempts['99.0.0'], i);
    }
    await new Promise((r) => setTimeout(r, 300));
    const lines = fs.readFileSync(note, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /--hidden --yb-from=\S+electron --yb-handed-off$/);
    const r = await run(4000);
    assert.equal(r.signal, 'SIGKILL', 'the third start stays on this copy');
    assert.equal(fs.readFileSync(note, 'utf8').trim().split('\n').length, 2);
    // A copy Windows refuses to start at all is given up on at once, and this copy carries on.
    fs.rmSync(path.join(dir, 'state.json'));
    fs.chmodSync(path.join(dir, '99.0.0', path.basename(executablePath)), 0o644);
    const blocked = await run(4000);
    assert.equal(blocked.signal, 'SIGKILL', 'stays on this copy');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).attempts['99.0.0'], 2);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  await step('when the server is gone, the offline page shows', async () => {
    server.close();
    server.closeAllConnections?.();
    const again = await electron.launch({ executablePath, args: [appDir, '--no-sandbox'], env: { ...process.env, CLEFT_USER_DATA: userData } });
    const w3 = await again.firstWindow();
    await w3.waitForURL(/offline\.html/);
    await w3.waitForFunction(() => /not answering/.test(document.getElementById('title').textContent), null, { timeout: 8000 }).catch(async (e) => { throw new Error(`title was "${await w3.textContent('#title').catch(() => '?')}" reason "${await w3.textContent('#reason').catch(() => '?')}" (${e.message.split('\n')[0]})`); });
    assert.match(await w3.textContent('#countdown'), /Trying again in \d second/);
    assert.match(await w3.textContent('#reason'), /ERR_CONNECTION_REFUSED/);
    await again.close();
  });
} finally {
  await app.close().catch(() => {});
  server.close();
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(downloadsDir, { recursive: true, force: true });
  fs.rmSync(updatesDir, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log('all desktop checks passed');
