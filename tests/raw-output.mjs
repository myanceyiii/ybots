// Collapsing raw tool output in bot messages (server/src/raw-output.ts). Needs a built server:
// `npm run build -w server`, then `node tests/raw-output.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const t = await import('../server/dist/raw-output.js');

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };
const kinds = (md) => t.splitRawOutput(md).map((s) => s.kind).join(',');

test('the Android copy is identical to the shared file', () => {
  assert.equal(fs.readFileSync(new URL('../mobile/src/rawOutput.ts', import.meta.url), 'utf8'), fs.readFileSync(new URL('../server/src/raw-output.ts', import.meta.url), 'utf8'));
});
test('ordinary markdown is untouched', () => {
  const md = '## Bills\n\n- **Power** due Dec 3\n- Water\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```bash\nnpm run build\n```\n\nSee [docs](https://x.io).';
  assert.deepEqual(t.splitRawOutput(md), [{ kind: 'md', text: md }]);
});
test('error JSON inside a sentence becomes a short error line', () => {
  const s = t.splitRawOutput('I tried the bank sync. Result: {"error":"ITEM_LOGIN_REQUIRED: the login details changed","code":400}\nI will retry later.');
  assert.equal(s.length, 3);
  assert.equal(s[0].text, 'I tried the bank sync. Result');
  assert.equal(s[1].kind, 'raw');
  assert.equal(s[1].summary, 'Error: ITEM_LOGIN_REQUIRED: the login details changed');
  assert.match(s[1].text, /\n  "code": 400/);
  assert.equal(s[2].text, 'I will retry later.');
});
test('nested error messages are found', () => {
  const s = t.splitRawOutput('{"error":{"message":"Rate limited","type":"rate_limit_error"}}');
  assert.equal(s[0].summary, 'Error: Rate limited');
});
test('a bare multi-line JSON block is collapsed', () => {
  assert.equal(kinds('Here are the accounts:\n{\n  "accounts": [\n    {"name": "Checking", "balance": 10}\n  ]\n}\nThat is all.'), 'md,raw,md');
});
test('json and log fences are collapsed, with a line count', () => {
  const s = t.splitRawOutput('Done.\n```log\nline1\nline2\n```');
  assert.equal(s[1].summary, 'Log · 2 lines');
  assert.equal(s[1].text, 'line1\nline2');
  assert.equal(kinds('```json\n{"a":1}\n```'), 'raw');
});
test('long code blocks are collapsed, short ones stay', () => {
  const long = '```\n' + Array.from({ length: 20 }, (_, i) => `row ${i}`).join('\n') + '\n```';
  assert.equal(t.splitRawOutput(long)[0].summary, 'Raw output · 20 lines');
  assert.equal(kinds('```python\nprint(1)\n```'), 'md');
});
test('small inline JSON and markdown links stay in the text', () => {
  assert.equal(kinds('Set it to {"a":1} please'), 'md');
  assert.equal(kinds('[Docs](https://x.io) and [more](https://y.io)'), 'md');
});
test('an unfinished (streaming) fence or JSON is left alone', () => {
  assert.equal(kinds('Working…\n```json\n{"a":'), 'md');
  assert.equal(kinds('Result: {"error":"still stream'), 'md');
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
