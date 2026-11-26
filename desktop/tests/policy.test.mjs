import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { normalizeAddress, signInUrl, navigationDecision, permissionAllowed } = createRequire(import.meta.url)('../src/policy.js');

const O = 'https://cleft.example.ts.net';

test('address: https names are kept as an origin', () => {
  assert.equal(normalizeAddress('cleft.example.ts.net'), O);
  assert.equal(normalizeAddress(' https://cleft.example.ts.net/some/path?x=1 '), O);
  assert.equal(normalizeAddress('https://bots.example.com'), 'https://bots.example.com');
  assert.equal(normalizeAddress('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
});

test('address: plain http elsewhere, credentials, junk and bare names are refused', () => {
  for (const bad of ['', 'http://cleft.example.ts.net', 'https://user:pw@cleft.example.ts.net', 'ftp://x.ts.net', 'cleft', 'https://', 'file:///c:/x', 'javascript:alert(1)']) {
    assert.throws(() => normalizeAddress(bad), undefined, bad);
  }
});

test('sign-in links are opened on our own address, whatever host they name', () => {
  const tok = 'a'.repeat(32);
  assert.equal(signInUrl(`${O}/api/auth/link/${tok}`, O), `${O}/api/auth/link/${tok}`);
  assert.equal(signInUrl(`https://host2.tail.ts.net/api/auth/link/${tok}`, O), `${O}/api/auth/link/${tok}`);
  assert.equal(signInUrl(`${O}/api/auth/owner`, O), null);
  assert.equal(signInUrl(`${O}/api/auth/link/${tok}/../../x`, O), null);
  assert.equal(signInUrl(`${O}/api/auth/link/short`, O), null);
  assert.equal(signInUrl(`${O}/api/auth/link/${tok}?next=https://evil.example`, O), null);
  assert.equal(signInUrl(`https://u:p@x.example/api/auth/link/${tok}`, O), null);
  assert.equal(signInUrl(`javascript:/api/auth/link/${tok}`, O), null);
  assert.equal(signInUrl('not a url', O), null);
  assert.equal(signInUrl(`${O}/api/auth/link/${tok}`, undefined), null);
});

test('navigation: our origin and the Access sign-in stay, web links go out, other schemes are dropped', () => {
  assert.equal(navigationDecision(`${O}/chat/1`, O), 'allow');
  assert.equal(navigationDecision('https://team.cloudflareaccess.com/cdn-cgi/access/login', O), 'allow');
  assert.equal(navigationDecision('https://example.com/', O), 'external');
  assert.equal(navigationDecision('https://cleft.example.ts.net.evil.com/', O), 'external');
  assert.equal(navigationDecision('http://cloudflareaccess.com.evil.com/', O), 'external');
  assert.equal(navigationDecision('file:///C:/Windows/system32', O), 'deny');
  assert.equal(navigationDecision('ms-settings:privacy', O), 'deny');
  assert.equal(navigationDecision('javascript:alert(1)', O), 'deny');
  assert.equal(navigationDecision('https://anything.example/', undefined), 'external');
});

test('permissions: mic, notifications and the clipboard for our origin only', () => {
  assert.ok(permissionAllowed('media', `${O}/`, O, { mediaTypes: ['audio'] }));
  assert.ok(permissionAllowed('notifications', `${O}/x`, O));
  assert.ok(!permissionAllowed('media', `${O}/`, O, { mediaTypes: ['video'] }));
  assert.ok(!permissionAllowed('media', `${O}/`, O, { mediaTypes: ['audio', 'video'] }));
  assert.ok(!permissionAllowed('media', `${O}/`, O, {}));
  assert.ok(!permissionAllowed('media', 'https://evil.example/', O, { mediaTypes: ['audio'] }));
  assert.ok(!permissionAllowed('notifications', 'https://evil.example/', O));
  assert.ok(permissionAllowed('clipboard-read', `${O}/`, O));
  assert.ok(!permissionAllowed('clipboard-read', 'https://evil.example/', O));
  for (const p of ['geolocation', 'display-capture', 'midi', 'hid', 'serial', 'usb', 'openExternal', 'pointerLock']) {
    assert.ok(!permissionAllowed(p, `${O}/`, O), p);
  }
  assert.ok(!permissionAllowed('notifications', `${O}/`, undefined));
});

test('a redirected request reads as a Cloudflare Access sign-in, not as unreachable', async () => {
  const { isRedirectError } = await import('../src/policy.js').then((m) => m.default ?? m);
  assert.equal(isRedirectError(new Error('Redirect was cancelled')), true);
  assert.equal(isRedirectError(new Error("Attempted to redirect, but redirect policy was 'error'")), true);
  assert.equal(isRedirectError(new Error('net::ERR_NAME_NOT_RESOLVED')), false);
  assert.equal(isRedirectError(undefined), false);
});
