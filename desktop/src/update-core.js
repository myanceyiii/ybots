'use strict';
// The rules of in-app updates, kept free of Electron so they can be tested on their own.
//
// An update is the same portable zip a person would download by hand. The app fetches it from the
// YBots server it is signed in to, and uses it only when all three hold:
//   1. the manifest carries an Ed25519 signature made by the build server's key (public half below),
//   2. the downloaded file has exactly the size the signed manifest names,
//   3. and exactly its SHA-256.
// The signature covers version, hash and size, so a server (or anyone who got into it) cannot swap in
// another program, an older version dressed as a newer one, or a file of a different length.
//
// The new version is unpacked next to the others (…\YBots\versions\<version>\) and never over the
// running copy. Whichever copy is started hands over to the newest complete one. A version that fails
// to start a few times in a row is left alone, so a bad update cannot lock anyone out.

const crypto = require('node:crypto');
// Electron's own fs treats every *.asar as a folder, which breaks unpacking and removing a copy of the app
// (it contains resources\app.asar). original-fs is the plain one; outside Electron (tests) it is node:fs.
const fs = (() => { try { return require('original-fs'); } catch { return require('node:fs'); } })();
const path = require('node:path');

/** Public keys allowed to sign an update (base64 of the DER "SubjectPublicKeyInfo"). The private half never leaves the build server. */
const TRUSTED_KEYS = Object.freeze([
  'MCowBQYDK2VwAyEAqOqFK7zA2N1k466/arzTzdt4vEHnu/Wc9LOTn2PazOE=',
]);

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
// Installed copies before 0.12 accept only the old "yanceybot-" name, so releases keep it for the in-app update file.
const FILE = /^(?:yanceybot|ybots)-windows-(\d{1,4}\.\d{1,4}\.\d{1,4})\.zip$/;
const MAX_ZIP = 1024 ** 3;
const MAX_UNPACKED = 3 * 1024 ** 3;
const MAX_ENTRIES = 20000;
const MAX_ATTEMPTS = 2;

const parts = (v) => String(v).split('.').map(Number);
/** Negative when a is older than b, positive when newer, 0 when the same. */
function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/** The manifest when every field is of the right kind, else null. */
function cleanManifest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { version, file, size, sha256, sig } = raw;
  if (typeof version !== 'string' || !VERSION.test(version)) return null;
  const m = typeof file === 'string' ? FILE.exec(file) : null;
  if (!m || m[1] !== version) return null;
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ZIP) return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof sig !== 'string' || !/^[A-Za-z0-9+/=]{80,120}$/.test(sig)) return null;
  return { version, file, size, sha256, sig, notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 4000) : '' };
}

/** Exactly what the build server signs. */
const signedText = (m) => `yanceybot-update:v1:${m.version}:${m.sha256}:${m.size}`;

/** True when one of the trusted keys made the manifest's signature. */
function verifyManifest(m, keys = TRUSTED_KEYS) {
  let sig;
  try { sig = Buffer.from(m.sig, 'base64'); } catch { return false; }
  if (sig.length !== 64) return false;
  for (const k of keys) {
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType === 'ed25519' && crypto.verify(null, Buffer.from(signedText(m)), key, sig)) return true;
    } catch { /* not a key: try the next */ }
  }
  return false;
}

/** For the build server and the tests: sign a manifest's fields with a private key. */
function signManifest(m, privateKey) {
  return crypto.sign(null, Buffer.from(signedText(m)), privateKey).toString('base64');
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Where a zip entry may be written inside dest, or null when its name tries to leave it. */
function safeEntryPath(dest, name) {
  if (typeof name !== 'string' || !name || name.length > 400 || name.includes('\0')) return null;
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return null;
  const segs = n.split('/').filter((s) => s !== '' && s !== '.');
  if (!segs.length || segs.some((s) => s === '..' || /[<>:"|?*]/.test(s) || /[. ]$/.test(s))) return null;
  const out = path.join(dest, ...segs);
  return out.startsWith(path.resolve(dest) + path.sep) ? out : null;
}

/**
 * Unpack a zip into an empty folder. Refuses names that point outside the folder, links, and archives
 * that are absurdly large or have absurdly many files. Resolves with the number of files written.
 */
function extractZip(zipFile, dest, { onProgress } = {}) {
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (err, zip) => {
      if (err) return reject(err);
      let files = 0;
      let bytes = 0;
      let done = false;
      const fail = (e) => { if (done) return; done = true; try { zip.close(); } catch { /* closed */ } reject(e); };
      if (zip.entryCount > MAX_ENTRIES) return fail(new Error('too many files in the update'));
      zip.on('error', fail);
      zip.on('end', () => { if (!done) { done = true; resolve(files); } });
      zip.on('entry', (entry) => {
        const isDir = /\/$/.test(entry.fileName);
        const target = safeEntryPath(dest, isDir ? entry.fileName.slice(0, -1) : entry.fileName);
        if (!target) return fail(new Error(`unsafe name in the update: ${String(entry.fileName).slice(0, 80)}`));
        // A link (Unix mode S_IFLNK in the upper bits) has no place in a Windows app.
        if ((((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000)) return fail(new Error('a link in the update'));
        bytes += entry.uncompressedSize;
        if (bytes > MAX_UNPACKED) return fail(new Error('the update is too large'));
        if (isDir) { fs.mkdirSync(target, { recursive: true }); return zip.readEntry(); }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        zip.openReadStream(entry, (e2, stream) => {
          if (e2) return fail(e2);
          const out = fs.createWriteStream(target, { flags: 'wx' });
          stream.on('error', fail);
          out.on('error', fail);
          out.on('close', () => { files++; onProgress?.(zip.entriesRead, zip.entryCount); zip.readEntry(); });
          stream.pipe(out);
        });
      });
      zip.readEntry();
    });
  });
}

/**
 * Which unpacked version a copy of the app should hand over to, or null to carry on itself.
 * `installed` is [{ version, complete }] (a folder is complete once its marker file is written, which
 * happens last), `state` is what versions/state.json remembers: how often each version was started
 * without ever coming up ({ attempts }), and which ones did come up ({ ok }).
 */
function pickHandoff(installed, current, state) {
  state = state && typeof state === 'object' ? state : {};
  const attempts = state.attempts && typeof state.attempts === 'object' ? state.attempts : {};
  const ok = state.ok && typeof state.ok === 'object' ? state.ok : {};
  const usable = (Array.isArray(installed) ? installed : [])
    .filter((i) => i && i.complete && typeof i.version === 'string' && VERSION.test(i.version) && compareVersions(i.version, current) > 0)
    .filter((i) => ok[i.version] === true || !(attempts[i.version] >= MAX_ATTEMPTS))
    .sort((a, b) => compareVersions(b.version, a.version));
  return usable[0]?.version ?? null;
}

/** Unpacked versions that can be removed: anything older than the running one. */
function removable(installed, current) {
  return (Array.isArray(installed) ? installed : []).filter((i) => i && typeof i.version === 'string' && VERSION.test(i.version) && compareVersions(i.version, current) < 0).map((i) => i.version);
}

/** One line for the Settings window and the tray. */
function statusLine(s, current) {
  switch (s?.phase) {
    case 'checking': return 'Checking for updates…';
    case 'downloading': return `Downloading YBots ${s.version}… ${Math.max(0, Math.min(100, Math.round((s.progress ?? 0) * 100)))}%`;
    case 'unpacking': return `Getting YBots ${s.version} ready…`;
    case 'ready': return s.canApply === false ? `YBots ${s.version} is available.` : `YBots ${s.version} is ready. It starts the next time you open the app, or restart now.`;
    case 'current': return `YBots ${current} is the newest version.`;
    case 'unavailable': return 'This YBots server has no Windows updates on it yet.';
    case 'failed': return `The update could not be fetched: ${s.error}`;
    case 'bad': return `YBots ${s.version} did not start properly on this PC, so the app stays on ${current}.`;
    default: return '';
  }
}

module.exports = { TRUSTED_KEYS, MAX_ATTEMPTS, compareVersions, cleanManifest, signedText, verifyManifest, signManifest, hashFile, safeEntryPath, extractZip, pickHandoff, removable, statusLine };
