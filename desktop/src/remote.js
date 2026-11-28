'use strict';
// "Let YBots use this PC" (docs/remote-pc.md), the Electron side. Off until the person turns it on.
//
// Pairing: a key pair made here (the private half encrypted with Windows' per-user protection through
// safeStorage), a QR code like sign-in, approved on a signed-in phone. Then ONE outbound WebSocket to
// <address>/api/machines/link, signed in with the key on every connect. Nothing here listens.
//
// What the server can ask for is limited by remote-core.js: shared folders only, commands only with
// "Allow commands" on, every change only with a matching one-time approval, blocked bots always
// refused. The screen is shared only with "Allow screen viewing" on; while anyone watches or a bot
// works, a bar at the top of the screen says so and has Stop, which turns all of this off.

const { BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, safeStorage, screen, session, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const qrcode = require('qrcode-generator');
const { UsedApprovals, makeExecutor, RfbSession, DEFAULT_BLOCKED, handleClip } = require('./remote-core');
const { InputMapper, createInjector } = require('./input');
const { isRedirectError } = require('./policy');
const { readJson, writeJson } = require('./store');

const SIGN_PREFIX = 'cleft-machine-link:v1:';
const MAX_WIDTH = 1600;
const FRAME_MS = 500;
const CONTROL_FRAME_MS = 150; // quicker while someone is driving

/** The origin (scheme, host, port) an address stands for; pairing is bound to it. */
function originOf(address) {
  try { return new URL(address).origin.toLowerCase(); } catch { return null; }
}

function createRemote({ app, partition, getAddress, pagesDir, onStatus, log = { info() {}, warn() {}, error() {} } }) {
  const file = () => path.join(app.getPath('userData'), 'remote.json');
  const keyFile = () => path.join(app.getPath('userData'), 'remote-key.bin');
  let cfg = { enabled: false, machineId: null, origin: null, folders: [], commands: false, screen: false, control: false, clipboard: false, blocked: [...DEFAULT_BLOCKED], used: [], log: [] };
  // A file that cannot be read (cut off mid-write by a power cut) is set aside; remote use then starts off and unpaired.
  { const { value } = readJson(file()); if (value && typeof value === 'object') cfg = { ...cfg, ...value }; }
  for (const k of ['folders', 'blocked', 'used', 'log']) if (!Array.isArray(cfg[k])) cfg[k] = k === 'blocked' ? [...DEFAULT_BLOCKED] : [];
  for (const b of DEFAULT_BLOCKED) if (!cfg.blocked.some((x) => x.toLowerCase() === b.toLowerCase())) cfg.blocked.push(b);
  const used = new UsedApprovals(cfg.used);
  const save = () => {
    cfg.used = used.toJSON();
    try { writeJson(file(), cfg); } catch (e) { log.error('remote settings could not be saved', e); }
  };

  let ws = null;
  // Bumped on every connect and disconnect. A connect that was still waiting (for cookies) when Stop
  // was pressed sees a newer epoch and gives up, so it can never open a link after Stop.
  let epoch = 0;
  const children = new Set(); // commands running now, so Stop can end them
  let status = 'off'; // off | unpaired | connecting | online | offline | removed | moved
  let retry = null;
  let backoff = 2000;
  let pinger = null;
  let pairing = null;
  let bar = null;
  let busyUntil = 0;
  let activity = '';
  const viewers = new Map(); // sid -> RfbSession
  let capturing = null;
  let controller = null; // { sid, mapper } while someone has taken control
  let injector = null;

  function setStatus(s) {
    status = s;
    onStatus?.(statusText());
    tellPage();
  }
  function statusText() {
    if (status === 'online') return controller ? 'Someone is controlling this PC' : viewers.size ? 'Your screen is being viewed' : 'YBots can use this PC';
    return { off: 'Remote use is off', unpaired: 'Not paired', connecting: 'Connecting…', offline: 'Offline, retrying', removed: 'This PC was removed', moved: 'Pair again for the new address' }[status] ?? status;
  }
  function note(text) {
    cfg.log.unshift({ at: Date.now(), text });
    cfg.log = cfg.log.slice(0, 200);
    save();
    tellPage();
  }
  const clipOn = () => !!(cfg.screen && cfg.control && cfg.clipboard);
  function stateForServer() {
    return { folders: cfg.folders, commands: !!cfg.commands, screen: !!cfg.screen, control: !!(cfg.screen && cfg.control), clipboard: clipOn(), blocked: cfg.blocked, version: app.getVersion() };
  }
  function publicState() {
    return { status, statusText: statusText(), enabled: cfg.enabled, paired: !!cfg.machineId, folders: cfg.folders.map((f) => ({ ...f, missing: !fs.existsSync(f.path) })), commands: !!cfg.commands, screen: !!cfg.screen, control: !!cfg.control, clipboard: !!cfg.clipboard, controlled: !!controller, blocked: cfg.blocked, alwaysBlocked: DEFAULT_BLOCKED, log: cfg.log.slice(0, 50), viewers: viewers.size, device: os.hostname(), keyProtected: safeStorage.isEncryptionAvailable(), pairedWith: cfg.origin };
  }
  function tellPage() {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && w.webContents.getURL().endsWith('/remote.html')) w.webContents.send('cleft:remote-update', publicState());
    }
    updateBar();
  }

  // ---------- the key ----------
  function loadKey() {
    try { return crypto.createPrivateKey({ key: safeStorage.decryptString(fs.readFileSync(keyFile())), format: 'pem' }); } catch { return null; }
  }
  /** A new key pair for one pairing attempt. Nothing is written until that attempt is allowed. */
  function newKey() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows could not protect the key for this PC, so remote use stays off.');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    return { sealed: safeStorage.encryptString(privateKey.export({ format: 'pem', type: 'pkcs8' })), publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  }

  // ---------- pairing ----------
  function stopPairing() { if (pairing?.timer) clearTimeout(pairing.timer); pairing = null; }
  async function startPairing() {
    stopPairing();
    const address = getAddress();
    if (!address) throw new Error('Set the YBots address first.');
    const origin = originOf(address);
    const { sealed, publicKey } = newKey();
    const attempt = {};
    pairing = attempt; // a newer attempt (or Stop) replaces this one before its answers arrive
    const ses = session.fromPartition(partition);
    let res;
    try {
      res = await ses.fetch(`${address}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ device: os.hostname(), kind: 'machine', publicKey }), credentials: 'include', redirect: 'manual' });
    } catch (err) {
      if (isRedirectError(err)) throw new Error('Sign in to YBots in the main window first (it asks for your Cloudflare sign-in), then try again.');
      throw new Error(`Couldn't reach ${address}. Check the address and your internet connection, then try again.`);
    }
    if (pairing !== attempt) throw new Error('A newer pairing started.');
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) throw new Error('Sign in to YBots in the main window first, then try again.');
    const p = await res.json();
    if (pairing !== attempt) throw new Error('A newer pairing started.');
    const qr = qrcode(0, 'M');
    qr.addData(`${address}/pair/${p.id}`);
    qr.make();
    pairing = { id: p.id, secret: p.secret, timer: null, sealed, origin };
    const mine = pairing;
    const poll = async () => {
      if (pairing !== mine) return;
      let body = {};
      let gone = false;
      try {
        const r = await ses.fetch(`${address}/api/auth/pair/${encodeURIComponent(mine.id)}`, { headers: { 'x-pair-secret': mine.secret, accept: 'application/json' }, credentials: 'include', redirect: 'manual' });
        gone = r.status === 404;
        body = await r.json().catch(() => ({}));
      } catch { /* try again */ }
      if (pairing !== mine) return;
      if (body.state === 'allowed' && typeof body.machineId === 'string') {
        stopPairing();
        if (originOf(getAddress()) !== mine.origin) {
          note('Pairing was dropped because the YBots address changed. Pair this PC again.');
          tellPage();
          return;
        }
        // The key and the machine id are saved together, only for the attempt that was allowed.
        disconnect();
        fs.writeFileSync(keyFile(), mine.sealed);
        cfg.machineId = body.machineId;
        cfg.origin = mine.origin;
        cfg.enabled = true;
        save();
        note('Paired with your YBots');
        connect();
        tellPage();
        return;
      }
      if (gone || body.state === 'denied' || body.state === 'allowed') {
        stopPairing();
        for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().endsWith('/remote.html')) w.webContents.send('cleft:remote-pair', { state: body.state === 'denied' ? 'denied' : 'expired' });
        return;
      }
      mine.timer = setTimeout(poll, 2000);
    };
    mine.timer = setTimeout(poll, 2000);
    return { code: p.code, expiresAt: p.expiresAt, svg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }), device: os.hostname() };
  }

  // ---------- running things ----------
  function runCommand(command, cwd, timeoutMs) {
    return new Promise((resolve) => {
      const win = process.platform === 'win32';
      const child = win
        ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, windowsHide: true })
        : spawn('/bin/sh', ['-c', command], { cwd });
      let out = '';
      let timedOut = false;
      const kill = () => {
        if (win) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
      };
      const entry = { stop: () => { entry.stopped = true; kill(); }, stopped: false };
      children.add(entry);
      const take = (d) => { if (out.length < 200_000) out += d.toString(); };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      const done = (r) => { clearTimeout(timer); children.delete(entry); resolve(entry.stopped ? { code: -1, output: `Stopped on this PC.\n${r.output}`, timedOut: false } : r); };
      child.on('error', (e) => done({ code: -1, output: String(e.message), timedOut: false }));
      child.on('close', (code) => done({ code: code ?? -1, output: out, timedOut }));
    });
  }
  const executor = makeExecutor({
    folders: () => cfg.folders,
    commands: () => !!cfg.commands,
    blocked: () => cfg.blocked,
    // Bots refused by name, remembered by id with the name they had, so a renamed bot stays out.
    blockedIds: () => (cfg.blockedBots ?? []).map((b) => b.id),
    rememberBlockedId: (id, name) => {
      cfg.blockedBots = cfg.blockedBots ?? [];
      if (cfg.blockedBots.some((b) => b.id === id)) return;
      cfg.blockedBots.push({ id, name });
      save();
    },
    used,
    saveUsed: save,
    run: runCommand,
    onActivity: (text) => { activity = text; busyUntil = Date.now() + 8000; updateBar(); setTimeout(updateBar, 8100); },
  });

  // ---------- the screen ----------
  function captureSize() {
    const d = screen.getPrimaryDisplay();
    const w = Math.round(d.size.width * d.scaleFactor);
    const h = Math.round(d.size.height * d.scaleFactor);
    const k = Math.min(1, MAX_WIDTH / w);
    return { display: d, width: Math.round(w * k) & ~1, height: Math.round(h * k) & ~1 };
  }
  async function grab() {
    const { display, width, height } = captureSize();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    const src = sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0];
    if (!src) throw new Error('No screen to capture.');
    const img = src.thumbnail;
    const size = img.getSize();
    return { width: size.width, height: size.height, bgra: img.toBitmap(), jpeg: (x, y, w, h) => img.crop({ x, y, width: w, height: h }).toJPEG(60) };
  }
  function startCapture() {
    if (capturing) return;
    let stopped = false;
    const loop = async () => {
      while (!stopped && viewers.size) {
        const t0 = Date.now();
        try {
          const f = await grab();
          for (const v of viewers.values()) v.frame(f);
        } catch (e) { note(`Screen capture failed: ${e.message}`); }
        await new Promise((r) => setTimeout(r, Math.max(50, (controller ? CONTROL_FRAME_MS : FRAME_MS) - (Date.now() - t0))));
      }
      capturing = null;
    };
    capturing = { stop: () => { stopped = true; } };
    loop();
  }
  function physicalSize() {
    const d = screen.getPrimaryDisplay();
    return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  }
  async function openScreen(sid, control, sock) {
    const send = (m) => sendOn(sock, m);
    if (!cfg.screen) return send({ t: 'screen-closed', sid, reason: 'Screen viewing is off on this PC.' });
    if (control && !cfg.control) return send({ t: 'screen-closed', sid, reason: 'Taking control is off on this PC.' });
    if (control && controller) return send({ t: 'screen-closed', sid, reason: 'Someone is already controlling this PC.' });
    const head = Buffer.concat([Buffer.from([sid.length]), Buffer.from(sid)]);
    let onInput = null;
    if (control) {
      const mapper = new InputMapper();
      controller = { sid, mapper };
      injector ??= createInjector({ screenSize: physicalSize, onError: (e) => note(`Input failed: ${e.message}`) });
      onInput = (kind, ...a) => {
        if (controller?.sid !== sid || !cfg.control) return;
        injector.apply(kind === 'key' ? mapper.key(a[0], a[1]) : mapper.pointer(...a));
      };
    }
    const v = new RfbSession((b) => { if (ws === sock && sock.readyState === WebSocket.OPEN) sock.send(Buffer.concat([head, b])); }, os.hostname(), onInput);
    try { v.start(await grab()); } catch (e) { if (controller?.sid === sid) controller = null; return send({ t: 'screen-closed', sid, reason: String(e.message) }); }
    if (ws !== sock) { v.close(); if (controller?.sid === sid) controller = null; return; } // the link went away meanwhile
    viewers.set(sid, v);
    note(control ? 'Someone took control of this screen' : 'Someone started watching this screen');
    setStatus(status);
    startCapture();
  }
  function closeScreen(sid, tellServer = false, reason = 'closed') {
    const v = viewers.get(sid);
    if (!v) return;
    v.close();
    viewers.delete(sid);
    if (controller?.sid === sid) {
      injector?.apply(controller.mapper.releaseAll()); // nothing stays held down
      controller = null;
      note('Control of this screen ended');
    }
    if (tellServer) send({ t: 'screen-closed', sid, reason });
    setStatus(status);
  }
  function closeAllScreens(reason) { for (const sid of [...viewers.keys()]) closeScreen(sid, true, reason); }

  // ---------- the bar at the top of the screen ----------
  function updateBar() {
    const show = cfg.enabled && (viewers.size > 0 || Date.now() < busyUntil);
    if (!show) { if (bar && !bar.isDestroyed()) bar.hide(); return; }
    const text = controller ? `Someone is controlling this PC through YBots${clipOn() ? ' · copy and paste on' : ''}` : viewers.size ? 'Your screen is being viewed through YBots' : activity || 'A bot is working on this PC';
    if (!bar || bar.isDestroyed()) {
      const { workArea } = screen.getPrimaryDisplay();
      bar = new BrowserWindow({
        width: 460, height: 48, x: Math.round(workArea.x + (workArea.width - 460) / 2), y: workArea.y + 8,
        frame: false, resizable: false, movable: true, alwaysOnTop: true, skipTaskbar: true, focusable: true, show: false,
        backgroundColor: '#111111',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      bar.setAlwaysOnTop(true, 'screen-saver');
      bar.loadURL(require('node:url').pathToFileURL(path.join(pagesDir, 'bar.html')).href);
      bar.webContents.once('did-finish-load', () => { bar.webContents.send('cleft:bar', text); bar.showInactive(); });
    } else {
      bar.webContents.send('cleft:bar', text);
      if (!bar.isVisible()) bar.showInactive();
    }
  }

  // ---------- the link ----------
  function send(msg) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
  /** Replies go only on the link the request came in on, and only while it is still the current one. */
  function sendOn(sock, msg) { if (sock && ws === sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg)); }

  async function connect() {
    clearTimeout(retry);
    const mine = ++epoch;
    if (!cfg.enabled || !cfg.machineId) return setStatus(cfg.machineId ? 'off' : 'unpaired');
    const address = getAddress();
    const key = loadKey();
    if (!address || !key) return setStatus('unpaired');
    // The pairing belongs to the address it was made with. A changed address never gets this PC's
    // identity or settings: the person pairs again with the new one.
    if (cfg.origin && originOf(address) !== cfg.origin) {
      dropLink();
      if (status !== 'moved') note('The YBots address changed, so this PC stopped connecting. Pair it again to use the new address.');
      return setStatus('moved');
    }
    dropLink();
    setStatus('connecting');
    // The window's own cookies for this address carry the Cloudflare Access sign-in, if there is one.
    const cookies = await session.fromPartition(partition).cookies.get({ url: address }).catch(() => []);
    if (mine !== epoch || !cfg.enabled) return; // Stop (or a newer connect) happened while waiting
    const url = address.replace(/^http/, 'ws') + '/api/machines/link';
    const sock = new WebSocket(url, { headers: cookies.length ? { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') } : {}, handshakeTimeout: 15000, maxPayload: 16 * 1024 * 1024 });
    ws = sock;
    const reply = (m) => sendOn(sock, m);
    sock.on('message', async (data, isBinary) => {
      if (ws !== sock) return;
      if (isBinary) {
        const n = data[0];
        viewers.get(data.subarray(1, 1 + n).toString())?.receive(Buffer.from(data.subarray(1 + n)));
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.t === 'challenge') {
        const sig = crypto.sign(null, Buffer.from(SIGN_PREFIX + cfg.machineId + ':' + msg.nonce), key).toString('base64');
        reply({ t: 'hello', machineId: cfg.machineId, sig, state: stateForServer() });
      } else if (msg.t === 'ready') {
        backoff = 2000;
        setStatus('online');
      } else if (msg.t === 'call') {
        if (!cfg.enabled) return reply({ t: 'result', id: msg.id, ok: false, output: 'Remote use is off on this PC.' });
        const r = await executor.handle(msg);
        note(`${msg.bot?.name ?? 'A bot'}: ${String(msg.tool).replace(/^pc_/, '').replace(/_/g, ' ')} ${r.ok ? 'done' : `refused or failed (${r.output.slice(0, 120)})`}`);
        reply({ t: 'result', id: msg.id, ok: r.ok, output: r.output });
      } else if (msg.t === 'clip') {
        const r = handleClip(msg, {
          enabled: clipOn,
          controlling: () => !!controller,
          read: () => clipboard.readText(),
          write: (text) => clipboard.writeText(text),
        });
        // Never the text itself: only that it happened.
        note(r.ok ? (msg.op === 'set' ? 'Text was pasted onto this PC\'s clipboard' : 'This PC\'s clipboard was copied to your other device') : `Copy and paste refused (${r.output})`);
        reply({ t: 'result', id: msg.id, ok: r.ok, output: r.output });
      } else if (msg.t === 'screen-open') {
        openScreen(String(msg.sid), msg.control === true, sock);
      } else if (msg.t === 'screen-close') {
        closeScreen(String(msg.sid));
      }
    });
    sock.on('open', () => {
      if (ws !== sock) return;
      clearInterval(pinger);
      pinger = setInterval(() => send({ t: 'ping' }), 25_000);
    });
    sock.on('close', (code) => {
      if (ws !== sock) return;
      clearInterval(pinger);
      for (const sid of [...viewers.keys()]) closeScreen(sid);
      ws = null;
      if (code === 4403) {
        // The server says this PC was removed (or never paired): forget it, and stop trying.
        cfg.machineId = null;
        cfg.origin = null;
        cfg.enabled = false;
        save();
        try { fs.unlinkSync(keyFile()); } catch { /* */ }
        note('This PC was removed from your YBots');
        return setStatus('removed');
      }
      if (!cfg.enabled) return setStatus('off');
      if (status !== 'offline') log.warn('remote link closed', code);
      setStatus('offline');
      retry = setTimeout(connect, backoff);
      backoff = Math.min(60_000, backoff * 2);
    });
    sock.on('error', () => { /* close follows */ });
  }

  function dropLink() {
    if (ws) { const s = ws; ws = null; try { s.terminate(); } catch { /* */ } }
  }

  /** Ends every command that is still running (whole process tree), so Stop really stops. */
  function stopCommands() {
    const n = children.size;
    for (const c of [...children]) c.stop();
    if (n) note(n === 1 ? 'A running command was stopped' : `${n} running commands were stopped`);
  }

  function disconnect() {
    epoch++;
    clearTimeout(retry);
    clearInterval(pinger);
    closeAllScreens('Remote use was turned off on the PC.');
    stopCommands();
    // The input helper (PowerShell on Windows) ends with the link; the next control session starts a new one.
    if (injector) { try { injector.close(); } catch { /* */ } injector = null; }
    if (ws) { const s = ws; ws = null; try { s.close(1000, 'turned off'); } catch { /* */ } }
  }

  /** Stop on the bar or the tray: everything off at once. */
  function stopAll() {
    cfg.enabled = false;
    save();
    disconnect();
    busyUntil = 0;
    note('Stopped on this PC');
    setStatus('off');
  }

  function pushState() { save(); send({ t: 'state', state: stateForServer() }); tellPage(); }

  // ---------- the page (pages/remote.html) ----------
  function registerIpc(fromLocalPage) {
    const guard = (fn) => (event, ...a) => { if (!fromLocalPage(event)) throw new Error('refused'); return fn(...a); };
    ipcMain.handle('cleft:remote-get', guard(() => publicState()));
    ipcMain.handle('cleft:remote-pair', guard(() => startPairing()));
    ipcMain.handle('cleft:remote-pair-stop', guard(() => { stopPairing(); return true; }));
    ipcMain.handle('cleft:remote-enable', guard((on) => {
      if (on && !cfg.machineId) throw new Error('Pair this PC first.');
      cfg.enabled = !!on;
      save();
      if (cfg.enabled) { note('Remote use turned on'); connect(); } else { note('Remote use turned off'); disconnect(); setStatus('off'); }
      return publicState();
    }));
    ipcMain.handle('cleft:remote-add-folder', guard(async () => {
      const r = await dialog.showOpenDialog({ title: 'Share a folder with YBots', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return publicState();
      const p = fs.realpathSync.native(r.filePaths[0]);
      const root = path.parse(p).root;
      if (p === root) throw new Error('Share a folder, not a whole drive.');
      if (!cfg.folders.some((f) => f.path.toLowerCase() === p.toLowerCase())) cfg.folders.push({ name: path.basename(p), path: p });
      note(`Shared ${p}`);
      pushState();
      return publicState();
    }));
    ipcMain.handle('cleft:remote-open-folder', guard((p) => {
      // Only a folder that is on the shared list, never a path the page made up.
      const f = cfg.folders.find((x) => x.path === p);
      if (!f) throw new Error('That folder is not shared.');
      if (!fs.existsSync(f.path)) throw new Error('That folder is no longer there. Stop sharing it, or put it back.');
      shell.openPath(f.path);
      return true;
    }));
    ipcMain.handle('cleft:remote-clear-log', guard(() => { cfg.log = []; save(); return publicState(); }));
    ipcMain.handle('cleft:remote-remove-folder', guard((p) => {
      cfg.folders = cfg.folders.filter((f) => f.path !== p);
      note(`Stopped sharing ${p}`);
      pushState();
      return publicState();
    }));
    ipcMain.handle('cleft:remote-set', guard((key, value) => {
      if (key === 'commands' || key === 'screen' || key === 'control' || key === 'clipboard') cfg[key] = !!value;
      if (key === 'screen' && !value) closeAllScreens('Screen viewing was turned off on the PC.');
      if (key === 'control' && !value && controller) closeScreen(controller.sid, true, 'Taking control was turned off on the PC.');
      if (key === 'blocked' && Array.isArray(value)) {
        const names = value.map((v) => String(v).trim()).filter(Boolean).slice(0, 20);
        cfg.blocked = [...new Set([...DEFAULT_BLOCKED, ...names])];
        // A bot taken off the list is no longer held by the id it was remembered under.
        const still = new Set(cfg.blocked.map((b) => b.toLowerCase()));
        cfg.blockedBots = (cfg.blockedBots ?? []).filter((b) => still.has(String(b.name).toLowerCase()));
      }
      note(key === 'blocked' ? `Blocked bots: ${cfg.blocked.join(', ')}` : `${{ commands: 'Commands', screen: 'Screen viewing', control: 'Taking control', clipboard: 'Copy and paste' }[key]} turned ${value ? 'on' : 'off'}`);
      pushState();
      return publicState();
    }));
    ipcMain.handle('cleft:remote-forget', guard(() => {
      disconnect();
      cfg.machineId = null;
      cfg.origin = null;
      cfg.enabled = false;
      save();
      try { fs.unlinkSync(keyFile()); } catch { /* */ }
      note('Forgot the pairing on this PC. Remove it in the YBots app too.');
      setStatus('unpaired');
      return publicState();
    }));
    ipcMain.on('cleft:bar-stop', (event) => { if (fromLocalPage(event)) stopAll(); });
  }

  return {
    start: () => {
      // A pairing made before pairings were bound to an address is bound to the one in use now.
      if (cfg.machineId && !cfg.origin && originOf(getAddress())) { cfg.origin = originOf(getAddress()); save(); }
      if (cfg.enabled && cfg.machineId) connect(); else setStatus(cfg.machineId ? 'off' : 'unpaired');
    },
    stopAll,
    registerIpc,
    statusText,
    get enabled() { return cfg.enabled; },
    /** Back from sleep: try the link now instead of waiting out the retry timer. */
    wake: () => { if (cfg.enabled && cfg.machineId && status === 'offline') { backoff = 2000; connect(); } },
    addressChanged: () => {
      stopPairing();
      if (cfg.enabled) connect();
      else if (cfg.machineId && cfg.origin && originOf(getAddress()) !== cfg.origin) setStatus('moved');
    },
  };
}

module.exports = { createRemote, originOf };
