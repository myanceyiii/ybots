// Tests for server/src/app-oauth.ts: refresh before expiry, rotation saved, 401 retry. No network.
//   npm run build -w server && node tests/app-oauth.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { accessToken, headersFileFetch, oauthFetch, oauthProblem, tokenPath } = await import('../server/dist/app-oauth.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleftbot-oauth-'));
const o = { tokenUrl: 'http://127.0.0.1:1/token', clientId: 'c1', tokenFile: path.join(dir, 'tok.json') };
const save = (t) => fs.writeFileSync(o.tokenFile, JSON.stringify(t));
let n = 0;
const calls = [];
const fake = async (url, init) => {
  calls.push({ url: String(url), init });
  if (String(url).endsWith('/token')) {
    const b = new URLSearchParams(init.body);
    assert.equal(b.get('grant_type'), 'refresh_token');
    assert.equal(b.get('client_id'), 'c1');
    if (b.get('refresh_token') === 'dead') return new Response('{}', { status: 400 });
    n++;
    return new Response(JSON.stringify({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 3600 }), { status: 200 });
  }
  const auth = new Headers(init.headers).get('authorization');
  return new Response('x', { status: auth === 'Bearer stale' ? 401 : 200 });
};
let failures = 0;
const test = async (name, f) => { try { await f(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack}`); } };

await test('a fresh token is used as is', async () => {
  save({ access_token: 'fresh', refresh_token: 'r0', expires_at: Date.now() + 3600e3 });
  assert.equal(await accessToken(o, fake), 'fresh');
  assert.equal(calls.length, 0);
});
await test('a token near expiry is refreshed and the rotated pair saved (mode 600)', async () => {
  save({ access_token: 'old', refresh_token: 'r0', expires_at: Date.now() + 60e3 });
  assert.equal(await accessToken(o, fake), 'a1');
  const t = JSON.parse(fs.readFileSync(tokenPath(o), 'utf8'));
  assert.equal(t.refresh_token, 'r1');
  assert.equal(fs.statSync(tokenPath(o)).mode & 0o777, 0o600);
});
await test('two refreshes at once make one token call', async () => {
  save({ access_token: 'old', refresh_token: 'r1', expires_at: 0 });
  const before = calls.length;
  const [a, b] = await Promise.all([accessToken(o, fake), accessToken(o, fake)]);
  assert.equal(a, b);
  assert.equal(calls.length - before, 1);
});
await test('a 401 refreshes once and retries', async () => {
  save({ access_token: 'stale', refresh_token: 'r2', expires_at: Date.now() + 3600e3 });
  const f = oauthFetch(o, fake);
  const res = await f('http://127.0.0.1:1/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 200);
  const last = calls[calls.length - 1];
  assert.match(new Headers(last.init.headers).get('authorization'), /^Bearer a\d$/);
  assert.equal(new Headers(last.init.headers).get('content-type'), 'application/json');
});
await test('a dead refresh token says to sign in again', async () => {
  save({ access_token: 'old', refresh_token: 'dead', expires_at: 0 });
  await assert.rejects(accessToken(o, fake), /signing in again/);
});
await test('config problems are named', async () => {
  assert.match(oauthProblem({ tokenUrl: 'x', clientId: 'c', tokenFile: 'f' }), /not a URL/);
  assert.match(oauthProblem({ tokenUrl: 'http://127.0.0.1/token', tokenFile: 'f' }), /clientId/);
  assert.equal(oauthProblem(o), null);
});
await test('a headers file is added to every request and re-read when it changes', async () => {
  const f = path.join(dir, 'h.json');
  fs.writeFileSync(f, JSON.stringify({ Authorization: 'Bearer one' }));
  let got = null;
  const ff = headersFileFetch(f, async (_u, init) => { got = new Headers(init.headers).get('authorization'); return new Response('x'); });
  await ff('http://127.0.0.1:1/mcp', { headers: { Accept: 'x' } });
  assert.equal(got, 'Bearer one');
  fs.writeFileSync(f, JSON.stringify({ Authorization: 'Bearer two' }));
  const later = new Date(Date.now() + 5000); fs.utimesSync(f, later, later);
  await ff('http://127.0.0.1:1/mcp', {});
  assert.equal(got, 'Bearer two');
});
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
