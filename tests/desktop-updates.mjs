// Windows app updates served by this server (server/src/desktop-updates.ts): the manifest is only believed
// when it is well formed and names a zip that is really there, the routes need a sign-in, and only the one
// file the manifest names can be downloaded.
// Run after `npm run build -w server`:   node tests/desktop-updates.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-updates-'));
const updates = path.join(dir, 'updates');
fs.mkdirSync(updates);
Object.assign(process.env, { DB_PATH: path.join(dir, 'test.db'), DESKTOP_UPDATES_DIR: updates, SESSION_SECRET: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), BOTHQ_NO_SCHEDULER: '1', HQ_LOCAL: '1', ORGO_API_KEY: 'unused' });
const { readManifest, desktopUpdatesApi } = await import(path.join(root, 'server/dist/desktop-updates.js'));

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
};

const zip = Buffer.from('PK not really a zip, just some bytes');
const good = () => ({ version: '1.2.3', file: 'yanceybot-windows-1.2.3.zip', size: zip.length, sha256: crypto.createHash('sha256').update(zip).digest('hex'), sig: Buffer.alloc(64, 7).toString('base64'), notes: 'What is new', publishedAt: 1 });
const put = (m, file = 'yanceybot-windows-1.2.3.zip') => {
  for (const f of fs.readdirSync(updates)) fs.rmSync(path.join(updates, f));
  if (file) fs.writeFileSync(path.join(updates, file), zip);
  fs.writeFileSync(path.join(updates, 'latest.json'), typeof m === 'string' ? m : JSON.stringify(m));
};

await test('no manifest, or one that is not JSON, means no update', () => {
  assert.equal(readManifest(), null);
  put('{ not json');
  assert.equal(readManifest(), null);
});
await test('a well formed manifest with its zip is read', () => {
  put(good());
  assert.deepEqual(readManifest(), good());
});
await test('a manifest is refused when a field is wrong or the zip is missing or another size', () => {
  for (const bad of [{ version: '1.2' }, { version: '../1.2.3' }, { file: '../../etc/passwd' }, { file: 'yanceybot-windows-9.9.9.zip' }, { file: 'evil.exe' }, { size: 0 }, { size: zip.length + 1 }, { sha256: 'abc' }, { sig: '' }, { sig: 5 }]) {
    put({ ...good(), ...bad });
    assert.equal(readManifest(), null, JSON.stringify(bad));
  }
  put(good(), null);
  assert.equal(readManifest(), null, 'zip missing');
});
await test('long notes are cut and odd ones dropped', () => {
  put({ ...good(), notes: 'x'.repeat(9000) });
  assert.equal(readManifest().notes.length, 4000);
  put({ ...good(), notes: { a: 1 }, publishedAt: 'soon' });
  assert.equal(readManifest().notes, '');
  assert.equal(readManifest().publishedAt, 0);
});
await test('both routes need a sign-in', async () => {
  put(good());
  for (const p of ['/desktop/latest', '/desktop/download/yanceybot-windows-1.2.3.zip']) {
    const r = await desktopUpdatesApi.request(p);
    assert.equal(r.status, 401, p);
  }
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
