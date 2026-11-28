// Fixes from the 2026-11-27 debug audit that can be checked without a running server: file paths that
// climb out of a bot's workspace through links, page ids, the plugin package folder as a link, cookie
// decoding, owner keys, Hermes file reads of secrets, wildcard matching, connector sign-in endpoints,
// the scoped sign-in's owner-only routes and the midnight check-in slot.
// Usage: npm run build -w server && node tests/audit-2026-11-27.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cleft-audit-'));
process.env.DB_PATH = path.join(TMP, 'db.sqlite');
process.env.SESSION_SECRET ||= crypto.randomBytes(32).toString('hex');
process.env.HQ_LOCAL = '1';
process.env.BOTHQ_NO_SCHEDULER = '1';

let failures = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${e?.stack ?? e}`); }
};

const F = await import('../server/dist/files.js');
const botId = `bot_audit${crypto.randomBytes(4).toString('hex')}`;
const root = F.workspaceRoot(botId);
fs.mkdirSync(root, { recursive: true });
const outsideDir = path.join(TMP, 'outside');
fs.mkdirSync(outsideDir);

try {
  await t('a new folder is never made through a link that leaves the workspace', () => {
    fs.symlinkSync(outsideDir, path.join(root, 'out'));
    assert.equal(F.insideTarget(botId, 'out/deep/er/new.md'), null);
    assert.deepEqual(fs.readdirSync(outsideDir), [], 'no folder was made outside');
    fs.unlinkSync(path.join(root, 'out'));
  });

  await t('a dangling link is not written through', () => {
    const dest = path.join(outsideDir, 'planted.txt');
    fs.symlinkSync(dest, path.join(root, 'dangling.txt'));
    assert.equal(F.insideTarget(botId, 'dangling.txt'), null);
    assert.equal(fs.existsSync(dest), false);
    fs.unlinkSync(path.join(root, 'dangling.txt'));
  });

  await t('climbing and odd characters are refused; a plain nested path is made', () => {
    for (const bad of ['../x.md', 'a/../../x.md', 'a\0b.md', 'a\nb.md']) assert.equal(F.insideTarget(botId, bad), null, bad);
    const ok = F.insideTarget(botId, 'notes/2026/a.md');
    assert.ok(ok && ok.startsWith(fs.realpathSync(root) + '/'));
    assert.ok(fs.statSync(path.dirname(ok)).isDirectory());
  });

  await t('the plugin package folder may not be a link', async () => {
    const { walk } = await import('../server/dist/plugins/install.js');
    const real = path.join(TMP, 'pkg-real');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'index.mjs'), '');
    assert.deepEqual(walk(real), ['index.mjs']);
    const link = path.join(TMP, 'pkg-link');
    fs.symlinkSync(real, link);
    assert.throws(() => walk(link), /link/);
  });

  await t('a malformed cookie is ignored, not thrown', async () => {
    const A = await import('../server/dist/lib/auth.js');
    assert.equal(A.safeDecode('%E0%A4%A'), undefined);
    assert.equal(A.safeDecode('a%20b'), 'a b');
    assert.doesNotThrow(() => A.userFromCookieHeader('cleftbot_session=%E0%A4%A'));
    assert.equal(A.userFromCookieHeader('cleftbot_session=%E0%A4%A'), null);
  });

  await t('an owner key must be exactly 64 hex characters', async () => {
    const A = await import('../server/dist/lib/auth.js');
    const key = 'a'.repeat(64);
    // Whatever the configured key is, a longer string or one with junk after it never passes.
    assert.equal(A.isOwnerKey(`${key}zz`), false);
    assert.equal(A.isOwnerKey(`${key} `), false);
    assert.equal(A.isOwnerKey(''), false);
  });

  await t("Hermes' file readers ask every time for secrets and firm data", async () => {
    const { readsGuarded } = await import('../server/dist/plugins/hermes-gate.js');
    assert.equal(readsGuarded({ path: '/opt/hq/.env' }), true);
    assert.equal(readsGuarded({ path: '/home/howard/.ssh/id_ed25519' }), true);
    assert.equal(readsGuarded({ pattern: 'x', path: '/srv/silo/notes' }), true);
    assert.equal(readsGuarded({ path: '/tmp/readme.md' }), false);
    assert.equal(readsGuarded(null), false);
  });

  await t('wildcards match in linear time', async () => {
    const { wildMatch } = await import('../server/dist/local-apps.js');
    assert.equal(wildMatch('*.example.com', 'api.example.com'), true);
    assert.equal(wildMatch('a*b*c', 'axxbyyc'), true);
    assert.equal(wildMatch('a*b*c', 'axxbyy'), false);
    const t0 = Date.now();
    assert.equal(wildMatch('*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000)), false);
    assert.ok(Date.now() - t0 < 500, 'no catastrophic backtracking');
  });

  await t('connector sign-in endpoints: https only, no internal addresses on other hosts', async () => {
    const { checkEndpoint } = await import('../server/dist/connectors-custom.js');
    const lookup = async (host) => (host === 'evil.example.com' ? ['10.0.0.5'] : host === 'mcp.example.com' ? ['93.184.216.34'] : ['93.184.216.34']);
    const server = new URL('https://mcp.example.com/mcp');
    await assert.doesNotReject(checkEndpoint('https://auth.example.com/token', server, lookup));
    await assert.rejects(checkEndpoint('javascript:alert(1)', server, lookup));
    await assert.rejects(checkEndpoint('http://auth.example.com/token', server, lookup));
    await assert.rejects(checkEndpoint('https://user:pw@auth.example.com/token', server, lookup));
    await assert.rejects(checkEndpoint('https://169.254.169.254/latest', server, lookup));
    await assert.rejects(checkEndpoint('https://evil.example.com/token', server, lookup));
  });

  await t('message links open only as web links; other sites\' pictures wait for a tap', async () => {
    const { safeLink, loadsOnItsOwn } = await import('../server/dist/safe-url.js');
    assert.equal(safeLink('javascript:alert(1)'), null);
    assert.equal(safeLink(' JaVaScRiPt:alert(1)'), null);
    assert.equal(safeLink('data:text/html,x'), null);
    assert.equal(safeLink('https://example.slack.com/archives/C1/p1'), 'https://example.slack.com/archives/C1/p1');
    assert.equal(loadsOnItsOwn('/api/bots/b/files/raw?path=a.png'), true);
    assert.equal(loadsOnItsOwn('data:image/png;base64,AAAA'), true);
    assert.equal(loadsOnItsOwn('https://elsewhere.example/x.png?d=secret'), false);
    assert.equal(loadsOnItsOwn('//elsewhere.example/x.png'), false);
    assert.equal(loadsOnItsOwn(''), false);
  });

  await t('a check-in slot just before midnight still fires just after it', async () => {
    // The slot window is "0 to 4 minutes after the slot"; across midnight that must wrap.
    const src = fs.readFileSync(new URL('../server/dist/proactive.js', import.meta.url), 'utf8');
    assert.match(src, /% 1440\) \+ 1440\) % 1440/);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
