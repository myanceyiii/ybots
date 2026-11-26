'use strict';
// In-app updates: check the YBots server, download the new version in the background, check it
// (signature, size, SHA-256: see update-core.js), unpack it next to the others and use it from the next
// start. The app never restarts on its own; "Restart to update" is the person's choice.
//
// Where things live (Windows): %LOCALAPPDATA%\YanceyBot\versions\
//   <version>\              one unpacked copy of the app, complete once <version>\.complete exists
//   state.json              which versions came up fine, and how often one was tried without coming up
//   download\               the zip while it is fetched (removed after unpacking)

// Electron's own fs treats every *.asar as a folder, which breaks unpacking and removing a copy of the app
// (it contains resources\app.asar). original-fs is the plain one; outside Electron (tests) it is node:fs.
const fs = (() => { try { return require('original-fs'); } catch { return require('node:fs'); } })();
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./update-core');
const { readJson, writeJson } = require('./store');

const MARK = '.complete';
const HANDED = '--yb-handed-off';
const FROM = '--yb-from=';
const SIX_HOURS = 6 * 3600 * 1000;

function versionsDir(app) {
  if (process.env.CLEFT_UPDATES_DIR && !app.isPackaged) return process.env.CLEFT_UPDATES_DIR;
  const local = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'YanceyBot') : app.getPath('userData');
  return path.join(local, 'versions');
}

function listInstalled(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(n)).map((version) => ({ version, complete: fs.existsSync(path.join(dir, version, MARK)) }));
}

const readState = (dir) => {
  const v = readJson(path.join(dir, 'state.json')).value;
  return { attempts: v && typeof v.attempts === 'object' && v.attempts ? { ...v.attempts } : {}, ok: v && typeof v.ok === 'object' && v.ok ? { ...v.ok } : {} };
};
const writeState = (dir, s) => { try { fs.mkdirSync(dir, { recursive: true }); writeJson(path.join(dir, 'state.json'), s); } catch { /* next time */ } };

// The exe keeps the name YanceyBot.exe (desktop/package.json build.win.executableName) whatever the app is
// called: every installed copy looks for its own exe name inside a new version.
const exeName = () => path.basename(process.execPath);
const exeOf = (dir, version) => path.join(dir, version, exeName());
/** Only a packaged Windows copy can hand over to another copy. */
const canApply = (app) => (process.platform === 'win32' && app.isPackaged) || (process.env.CLEFT_TEST_APPLY === '1' && !app.isPackaged);

/**
 * At the very start, before anything else: if a newer complete version is unpacked, the exe to start
 * instead of this one (and the try is counted). Null to carry on.
 */
function handoffTarget(app, argv = process.argv) {
  try {
    if (!canApply(app) || argv.includes(HANDED) || argv.includes('--no-update')) return null;
    const dir = versionsDir(app);
    const state = readState(dir);
    const version = core.pickHandoff(listInstalled(dir), app.getVersion(), state);
    if (!version) return null;
    const exe = exeOf(dir, version);
    if (!fs.existsSync(exe)) return null;
    if (state.ok[version] !== true) { state.attempts[version] = (state.attempts[version] || 0) + 1; writeState(dir, state); }
    return { version, exe, args: [...argv.slice(1).filter((a) => a !== HANDED && !String(a).startsWith(FROM)), `${FROM}${process.execPath}`, HANDED] };
  } catch { return null; }
}

/** Rename a folder, trying a few times: on Windows a virus scanner can hold a freshly written file for a moment. */
async function moveFolder(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}

/** Windows would not start that copy at all (a policy that blocks programs in this folder, say): stop trying it. */
function giveUp(app, version) {
  try {
    const dir = versionsDir(app);
    const state = readState(dir);
    state.attempts[version] = core.MAX_ATTEMPTS;
    writeState(dir, state);
  } catch { /* the try counter gets there anyway */ }
}

function createUpdater({ app, fetch, address, getSettings, update, log, notify, onChange, keys }) {
  const dir = versionsDir(app);
  const current = app.getVersion();
  let s = { phase: 'idle' };
  let busy = false;
  let timer = null;
  let told = '';

  const set = (next) => { s = { ...next, canApply: canApply(app) }; onChange?.(); };
  const state = () => ({ ...s, current, auto: getSettings().updates.auto, lastCheck: getSettings().updates.lastCheck, text: core.statusLine(s, current) });

  /** This copy came up: remember it (so it is never counted as failing) and clear out older copies. */
  function markStarted() {
    try {
      const st = readState(dir);
      if (fs.existsSync(path.join(dir, current, MARK)) && st.ok[current] !== true) { st.ok[current] = true; delete st.attempts[current]; writeState(dir, st); }
      for (const v of core.removable(listInstalled(dir), current)) {
        fs.rm(path.join(dir, v), { recursive: true, force: true }, () => {});
        if (st.ok[v] || st.attempts[v]) { delete st.ok[v]; delete st.attempts[v]; writeState(dir, st); }
      }
      // Half-unpacked folders and half-fetched zips from a run that was interrupted.
      for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (/\.tmp$/.test(n) || (n === 'download' && !busy)) fs.rm(path.join(dir, n), { recursive: true, force: true }, () => {});
    } catch (e) { log.warn('update cleanup', e); }
  }

  /** A newer complete version already unpacked (from an earlier run), if any. */
  function waiting() {
    const st = readState(dir);
    const all = listInstalled(dir).filter((i) => i.complete && core.compareVersions(i.version, current) > 0).sort((a, b) => core.compareVersions(b.version, a.version));
    if (!all.length) return null;
    const good = core.pickHandoff(all, current, st);
    return good ? { version: good, bad: false } : { version: all[0].version, bad: true };
  }

  async function download(m) {
    const folder = path.join(dir, 'download');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, m.file);
    const r = await fetch(`${address()}/api/desktop/download/${m.file}`, { credentials: 'include', redirect: 'manual' });
    if (!r.ok || !r.body) throw new Error(`the server answered ${r.status}`);
    const out = fs.createWriteStream(file);
    const hash = crypto.createHash('sha256');
    let got = 0;
    let last = 0;
    try {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > m.size) { await reader.cancel().catch(() => {}); throw new Error('the file is larger than it should be'); }
        hash.update(value);
        if (!out.write(value)) await new Promise((res) => out.once('drain', res));
        if (Date.now() - last > 500) { last = Date.now(); set({ phase: 'downloading', version: m.version, progress: got / m.size }); }
      }
    } finally {
      await new Promise((res) => out.end(res));
    }
    if (got !== m.size) throw new Error('the download stopped early');
    if (hash.digest('hex') !== m.sha256) throw new Error('the file does not match its signature');
    return file;
  }

  async function unpack(m, zip) {
    const tmp = path.join(dir, `${m.version}.tmp`);
    const final = path.join(dir, m.version);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(final, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    await core.extractZip(zip, tmp);
    // The zip has the app at its top level; some zip tools wrap it in one folder.
    let root = tmp;
    if (!fs.existsSync(path.join(root, exeName()))) {
      const only = fs.readdirSync(tmp);
      if (only.length === 1 && fs.existsSync(path.join(tmp, only[0], exeName()))) root = path.join(tmp, only[0]);
      else if (canApply(app)) throw new Error('the update does not contain the app');
    }
    await moveFolder(root, final);
    if (root !== tmp) fs.rmSync(tmp, { recursive: true, force: true });
    fs.writeFileSync(path.join(final, MARK), JSON.stringify({ version: m.version, sha256: m.sha256, at: Date.now() }));
    try { fs.rmSync(path.dirname(zip), { recursive: true, force: true }); } catch { /* cleared at the next start */ }
  }

  /** Look for a newer version and, when there is one, fetch and unpack it. `manual` is the person asking. */
  async function check({ manual = false } = {}) {
    if (busy) return state();
    if (!address()) { if (manual) set({ phase: 'failed', error: 'set the YBots address first.' }); return state(); }
    busy = true;
    try {
      set({ phase: 'checking' });
      const w = waiting();
      let r;
      try {
        r = await fetch(`${address()}/api/desktop/latest`, { credentials: 'include', redirect: 'manual', headers: { accept: 'application/json' } });
      } catch { throw new Error("couldn't reach YBots."); }
      update({ updates: { lastCheck: Date.now() } }, { quiet: true });
      if (r.status === 404) { set(w && !w.bad ? { phase: 'ready', version: w.version } : { phase: 'unavailable' }); return state(); }
      if (r.status === 401 || r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) throw new Error('sign in to YBots in the main window first.');
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('application/json')) throw new Error(`the server answered ${r.status}.`);
      const raw = await r.json().catch(() => null);
      if (raw && raw.version === null) { set(w && !w.bad ? { phase: 'ready', version: w.version } : { phase: 'unavailable' }); return state(); }
      const m = core.cleanManifest(raw);
      if (!m) throw new Error('the server sent something that is not an update.');
      if (core.compareVersions(m.version, current) <= 0) { set({ phase: 'current' }); return state(); }
      if (!core.verifyManifest(m, keys ?? core.TRUSTED_KEYS)) { log.warn(`update ${m.version} refused: signature`); throw new Error('it is not signed by the YBots build server, so it was not used.'); }
      if (w && w.version === m.version) { set(w.bad ? { phase: 'bad', version: w.version } : { phase: 'ready', version: w.version, notes: m.notes }); return state(); }
      set({ phase: 'downloading', version: m.version, progress: 0 });
      const zip = await download(m);
      set({ phase: 'unpacking', version: m.version });
      await unpack(m, zip);
      log.info(`update ${m.version} is ready`);
      set({ phase: 'ready', version: m.version, notes: m.notes });
      if (told !== m.version && canApply(app)) { told = m.version; notify?.(m.version); }
    } catch (e) {
      const error = String(e?.message ?? e).slice(0, 200);
      log.warn('update check', error);
      const w = waiting();
      // A quiet background check that fails says nothing; the next one may work.
      if (w && !w.bad) set({ phase: 'ready', version: w.version });
      else set(manual ? { phase: 'failed', error } : { phase: 'idle' });
    } finally { busy = false; }
    return state();
  }

  /** Start the unpacked version now. Electron waits for this copy to end before the new one starts. */
  function restart() {
    const w = waiting();
    if (!w || w.bad || !canApply(app)) return false;
    const exe = exeOf(dir, w.version);
    if (!fs.existsSync(exe)) return false;
    const st = readState(dir);
    if (st.ok[w.version] !== true) { st.attempts[w.version] = (st.attempts[w.version] || 0) + 1; writeState(dir, st); }
    app.relaunch({ execPath: exe, args: [HANDED] });
    app.quit();
    return true;
  }

  function start() {
    // Counted as "came up" once it has run for a little while without falling over.
    setTimeout(markStarted, 8000).unref?.();
    const w = waiting();
    if (w) set(w.bad ? { phase: 'bad', version: w.version } : { phase: 'ready', version: w.version });
    const tick = () => { if (getSettings().updates.auto && Date.now() - getSettings().updates.lastCheck > SIX_HOURS - 60_000) check(); };
    setTimeout(tick, 30_000).unref?.();
    timer = setInterval(tick, 30 * 60_000);
    timer.unref?.();
  }

  return { start, check, restart, state, markStarted, get dir() { return dir; } };
}

module.exports = { createUpdater, handoffTarget, giveUp, versionsDir, HANDED, FROM };
