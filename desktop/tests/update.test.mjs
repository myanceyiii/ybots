// The rules of in-app updates (src/update-core.js): what is believed, what is unpacked, which copy runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeZip } from './zip-helper.mjs';

const require = createRequire(import.meta.url);
const core = require('../src/update-core.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yb-update-'));
const keyPair = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
};
const manifest = (over = {}) => ({ version: '1.2.3', file: 'yanceybot-windows-1.2.3.zip', size: 1234, sha256: 'a'.repeat(64), sig: 'A'.repeat(88), notes: '', ...over });

test('versions compare by number, not by text', () => {
  assert.ok(core.compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(core.compareVersions('1.0.0', '0.99.99') > 0);
  assert.ok(core.compareVersions('0.9.0', '0.9.1') < 0);
  assert.equal(core.compareVersions('2.3.4', '2.3.4'), 0);
});

test('a manifest is believed only when every field is of the right kind', () => {
  assert.deepEqual(core.cleanManifest(manifest()), manifest());
  for (const bad of [null, 'x', { version: null }, manifest({ version: '1.2' }), manifest({ file: 'yanceybot-windows-9.9.9.zip' }), manifest({ file: '../x.zip' }), manifest({ file: 'setup.exe' }), manifest({ size: -1 }), manifest({ size: 2 ** 40 }), manifest({ sha256: 'A'.repeat(64) }), manifest({ sig: 'short' })]) {
    assert.equal(core.cleanManifest(bad), null, JSON.stringify(bad));
  }
  assert.equal(core.cleanManifest(manifest({ notes: 'n'.repeat(9000) })).notes.length, 4000);
});

test('only the build key\'s signature over version, hash and size is accepted', () => {
  const a = keyPair();
  const b = keyPair();
  const m = manifest();
  m.sig = core.signManifest(m, a.privateKey);
  assert.equal(core.verifyManifest(m, [a.pub]), true);
  assert.equal(core.verifyManifest(m, [b.pub, a.pub]), true, 'any trusted key');
  assert.equal(core.verifyManifest(m, [b.pub]), false, 'another key');
  assert.equal(core.verifyManifest(m, []), false);
  assert.equal(core.verifyManifest(m, ['not a key']), false);
  assert.equal(core.verifyManifest({ ...m, version: '9.9.9' }, [a.pub]), false, 'a newer version number');
  assert.equal(core.verifyManifest({ ...m, sha256: 'b'.repeat(64) }, [a.pub]), false, 'another file');
  assert.equal(core.verifyManifest({ ...m, size: m.size + 1 }, [a.pub]), false, 'another size');
  assert.equal(core.verifyManifest({ ...m, sig: 'A'.repeat(88) }, [a.pub]), false);
  assert.equal(core.verifyManifest(m), false, 'the test key is not one of the shipped keys');
});

test('the shipped keys are real Ed25519 public keys', () => {
  assert.ok(core.TRUSTED_KEYS.length >= 1);
  for (const k of core.TRUSTED_KEYS) assert.equal(crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType, 'ed25519');
});

test('zip names that leave the folder are refused', () => {
  const dest = path.resolve('/tmp/dest');
  assert.equal(core.safeEntryPath(dest, 'YanceyBot.exe'), path.join(dest, 'YanceyBot.exe'));
  assert.equal(core.safeEntryPath(dest, 'resources/app.asar'), path.join(dest, 'resources', 'app.asar'));
  assert.equal(core.safeEntryPath(dest, 'resources\\app.asar'), path.join(dest, 'resources', 'app.asar'));
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/Windows/x', 'c:\\x', '..', '', 'a\0b', 'a/b:stream', 'trailing./x', 'x'.repeat(500)]) assert.equal(core.safeEntryPath(dest, bad), null, bad);
});

test('a zip unpacks into its folder, and a bad one is refused', async () => {
  const dir = tmp();
  const good = path.join(dir, 'good.zip');
  fs.writeFileSync(good, makeZip([{ name: 'YanceyBot.exe', data: 'MZ app' }, { name: 'resources/' }, { name: 'resources/app.asar', data: 'asar' }, { name: 'locales/en-US.pak', data: Buffer.alloc(70000, 1) }]));
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  assert.equal(await core.extractZip(good, out), 3);
  assert.equal(fs.readFileSync(path.join(out, 'YanceyBot.exe'), 'utf8'), 'MZ app');
  assert.equal(fs.statSync(path.join(out, 'locales', 'en-US.pak')).size, 70000);
  assert.equal(await core.hashFile(good), crypto.createHash('sha256').update(fs.readFileSync(good)).digest('hex'));

  for (const [name, entries] of [
    ['slip', [{ name: 'ok.txt', data: 'x' }, { name: '../evil.txt', data: 'x' }]],
    ['link', [{ name: 'link', data: '/etc/passwd', mode: 0o120777 }]],
    ['twice', [{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }]],
  ]) {
    const z = path.join(dir, `${name}.zip`);
    fs.writeFileSync(z, makeZip(entries));
    const o = path.join(dir, name);
    fs.mkdirSync(o);
    await assert.rejects(core.extractZip(z, o), undefined, name);
    assert.equal(fs.existsSync(path.join(dir, 'evil.txt')), false);
  }
  fs.writeFileSync(path.join(dir, 'junk.zip'), 'this is not a zip at all');
  await assert.rejects(core.extractZip(path.join(dir, 'junk.zip'), out));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a copy hands over to the newest complete version, and gives up on one that never starts', () => {
  const installed = [{ version: '0.10.0', complete: true }, { version: '0.11.0', complete: true }, { version: '0.12.0', complete: false }, { version: '0.8.0', complete: true }, { version: 'junk', complete: true }];
  assert.equal(core.pickHandoff(installed, '0.9.0'), '0.11.0');
  assert.equal(core.pickHandoff(installed, '0.11.0'), null, 'already the newest complete one');
  assert.equal(core.pickHandoff(installed, '0.9.0', { attempts: { '0.11.0': core.MAX_ATTEMPTS - 1 } }), '0.11.0');
  assert.equal(core.pickHandoff(installed, '0.9.0', { attempts: { '0.11.0': core.MAX_ATTEMPTS } }), '0.10.0', 'falls back to the next one');
  assert.equal(core.pickHandoff(installed, '0.9.0', { attempts: { '0.11.0': 9 }, ok: { '0.11.0': true } }), '0.11.0', 'one that has come up before is trusted');
  assert.equal(core.pickHandoff([], '0.9.0'), null);
  assert.equal(core.pickHandoff(null, '0.9.0', null), null);
  assert.deepEqual(core.removable(installed, '0.11.0'), ['0.10.0', '0.8.0']);
});

test('the status line says what is happening in plain words', () => {
  assert.equal(core.statusLine({ phase: 'downloading', version: '1.0.0', progress: 0.416 }, '0.9.0'), 'Downloading YBots 1.0.0… 42%');
  assert.match(core.statusLine({ phase: 'ready', version: '1.0.0', canApply: true }, '0.9.0'), /is ready\. It starts the next time you open the app/);
  assert.equal(core.statusLine({ phase: 'ready', version: '1.0.0', canApply: false }, '0.9.0'), 'YBots 1.0.0 is available.');
  assert.equal(core.statusLine({ phase: 'current' }, '0.9.0'), 'YBots 0.9.0 is the newest version.');
  assert.match(core.statusLine({ phase: 'bad', version: '1.0.0' }, '0.9.0'), /stays on 0\.9\.0/);
  assert.equal(core.statusLine({ phase: 'idle' }, '0.9.0'), '');
});
