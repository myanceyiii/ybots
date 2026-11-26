// The live screen's quiet retries and failure wording (web/src/lib/screenRetry.ts and its phone copy).
// Plain node with type stripping: `node tests/screen-retry.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const web = new URL('../web/src/lib/screenRetry.ts', import.meta.url);
const mobile = new URL('../mobile/src/screenRetry.ts', import.meta.url);
// Strip the TypeScript into a temporary .mjs (esbuild is a dependency of the repo).
const { transformSync } = await import('esbuild');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-retry-'));
const out = path.join(dir, 'screenRetry.mjs');
fs.writeFileSync(out, transformSync(fs.readFileSync(web, 'utf8'), { loader: 'ts', format: 'esm' }).code);
const r = await import(out);

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };

test('the phone copy is the same file', () => {
  assert.equal(fs.readFileSync(mobile, 'utf8'), fs.readFileSync(web, 'utf8'));
});
test('a few quiet retries, growing, about 11 s in all, then the error', () => {
  const waits = [];
  for (let n = 0; ; n++) { const w = r.screenRetryDelay(n); if (w === null) break; waits.push(w); }
  assert.ok(waits.length >= 4 && waits.length <= 6, `${waits.length} retries`);
  for (let i = 1; i < waits.length; i++) assert.ok(waits[i] > waits[i - 1]);
  const total = waits.reduce((a, b) => a + b, 0);
  assert.ok(total >= 8000 && total <= 15000, `${total} ms`);
});
test('the server’s close reason wins, as a sentence', () => {
  assert.equal(r.screenFailureText({ opened: true, code: 1011, reason: 'the screen took too long to answer' }), 'The screen took too long to answer.');
});
test('a browser learns the close from noVNC’s line', () => {
  assert.equal(r.screenFailureText({ why: 'Failed when connecting: Connection closed (code: 1011, reason: The screen did not answer (vnc closed).)' }), 'The screen did not answer (vnc closed).');
  assert.match(r.screenFailureText({ why: 'Failed when connecting: Connection closed (code: 1006)' }), /network or a proxy/);
});
test('a refused link says to sign in again; one that never opened says so', () => {
  assert.match(r.screenFailureText({ opened: false, code: 1006, error: "Expected HTTP 101 response but was '403'" }), /Signing in again/);
  assert.match(r.screenFailureText({ opened: false, code: 1006, error: 'timeout' }), /didn’t open \(timeout\)/);
});
test('a viewer failure names noVNC’s reason', () => {
  assert.equal(r.screenFailureText({ opened: true, code: 1000, why: 'Failed when connecting: Unsupported encoding (encoding: 7)' }), 'The viewer stopped: Unsupported encoding (encoding: 7)');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
