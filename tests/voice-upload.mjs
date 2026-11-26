// Android voice uploads (mobile/src/voice/upload.ts): the recording is read from disk and sent as a
// hand-built multipart body, because expo/fetch (the app's global fetch since Expo SDK 52) refuses
// React Native's { uri } FormData parts before sending anything. Checks that the body parses as the
// server parses it (Request.formData(), as Hono's c.req.formData() does), with the fields and the exact
// WAV bytes, that a missing file and a failed connection are told apart, and the problem line's
// connection check (web/src/lib/problem.ts and mobile/src/problem.ts are the same file).
//   node tests/voice-upload.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-upload-'));

// Stand-ins for the two Expo modules upload.ts uses: a File that reads from disk, and fetch.
const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^expo-file-system$|^expo\/fetch$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
      loader: 'js',
      contents: a.path === 'expo/fetch'
        ? 'export const fetch = (...a) => globalThis.__fetch(...a);'
        : "import fs from 'node:fs'; export class File { constructor(uri) { this.p = uri.replace(/^file:\\/\\//, ''); } async bytes() { return new Uint8Array(fs.readFileSync(this.p)); } }",
    }));
  },
};
const out = path.join(dir, 'upload.mjs');
await build({ entryPoints: [path.join(root, 'mobile/src/voice/upload.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, plugins: [stubs], logLevel: 'error' });
const { multipartBody, postRecording, UploadError } = await import(out);

// 1. The body parses as the server parses it.
const wavBytes = new Uint8Array(fs.readFileSync(path.join(root, 'tests/ask-weather.wav')));
const { body, contentType } = multipartBody({ botId: 'bot_1', callId: 'c1', approvalId: undefined, language: '' }, { field: 'file', filename: 'turn.wav', type: 'audio/wav', bytes: wavBytes });
const form = await new Request('http://x/api/voice/turn', { method: 'POST', headers: { 'content-type': contentType }, body }).formData();
assert.equal(form.get('botId'), 'bot_1');
assert.equal(form.get('callId'), 'c1');
assert.equal(form.has('approvalId'), false, 'empty fields are left out');
assert.equal(form.has('language'), false);
const file = form.get('file');
assert.equal(file.name, 'turn.wav');
assert.equal(file.type, 'audio/wav');
assert.deepEqual(new Uint8Array(await file.arrayBuffer()), wavBytes, 'the WAV arrives byte for byte');

// 2. postRecording sends it with the sign-in headers.
const wavPath = path.join(dir, 'dictation.wav');
fs.writeFileSync(wavPath, wavBytes);
let seen;
globalThis.__fetch = async (url, init) => {
  seen = { url, headers: init.headers };
  const f = await new Request(url, init).formData();
  return new Response(JSON.stringify({ text: 'ok', got: f.get('file').size, language: f.get('language') }), { status: 200 });
};
const res = await postRecording({ server: 'https://cleft.example', authHeader: { authorization: 'Bearer t', 'CF-Access-Client-Id': 'id' } }, '/api/voice/stt', wavPath, 'dictation.wav', { language: 'en' });
assert.equal(res.ok, true);
const j = await res.json();
assert.equal(j.got, wavBytes.length);
assert.equal(j.language, 'en');
assert.equal(seen.url, 'https://cleft.example/api/voice/stt');
assert.equal(seen.headers.authorization, 'Bearer t');
assert.equal(seen.headers['CF-Access-Client-Id'], 'id');
assert.match(seen.headers['content-type'], /^multipart\/form-data; boundary=/);
// file:// paths work too.
assert.equal((await postRecording({ server: 'https://cleft.example', authHeader: {} }, '/api/voice/stt', `file://${wavPath}`, 'd.wav')).ok, true);

// 3. A missing recording and no connection are different failures.
await assert.rejects(postRecording({ server: 'https://cleft.example', authHeader: {} }, '/api/voice/stt', path.join(dir, 'gone.wav'), 'd.wav'), (e) => e instanceof UploadError && e.kind === 'file');
globalThis.__fetch = async () => { throw new TypeError('Network request failed'); };
await assert.rejects(postRecording({ server: 'https://cleft.example', authHeader: {} }, '/api/voice/stt', wavPath, 'd.wav'), (e) => e instanceof UploadError && e.kind === 'network' && /reach the server/.test(e.message));

// 4. The problem line: the two copies match, and connection failures are recognised.
const webProblem = fs.readFileSync(path.join(root, 'web/src/lib/problem.ts'), 'utf8');
assert.equal(fs.readFileSync(path.join(root, 'mobile/src/problem.ts'), 'utf8'), webProblem, 'web and mobile problem.ts must stay identical');
const pOut = path.join(root, 'web', `.problem-test-${process.pid}.mjs`);
await build({ entryPoints: [path.join(root, 'web/src/lib/problem.ts')], bundle: true, format: 'esm', platform: 'node', outfile: pOut, external: ['react'], logLevel: 'error' });
const { isNetworkFailure } = await import(pOut).finally(() => fs.rmSync(pOut, { force: true }));
assert.equal(isNetworkFailure(Object.assign(new Error('x'), { status: 0 })), true);
assert.equal(isNetworkFailure(Object.assign(new Error('Bad request'), { status: 400 })), false);
assert.equal(isNetworkFailure("Couldn't reach the server, so nothing was written down."), true);
assert.equal(isNetworkFailure(new TypeError('Failed to fetch')), true);
assert.equal(isNetworkFailure('The speech server answered with an error (500).'), false);

fs.rmSync(dir, { recursive: true, force: true });
console.log('voice-upload: ok');
