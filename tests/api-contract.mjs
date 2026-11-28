// The API contract (server/src/api-contract.ts, docs/api-contract.md): api/openapi.json is what the contract
// makes, the breaking-change check finds what it should, and nothing on this branch breaks an installed app
// compared with origin/main. Needs a built server for the address test: `npm run build -w server`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { build, OUT } from '../scripts/api/generate.mjs';
import { breaks } from '../scripts/api/breaking.mjs';

const { apiPath } = await import('../server/dist/api-path.js');
const support = await import('../server/dist/app-support.js');
let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };

const made = build();
test('api/openapi.json is what the contract makes (npm run api:generate)', () => {
  assert.equal(fs.readFileSync(OUT, 'utf8'), `${JSON.stringify(made, null, 2)}\n`);
});

test('the check finds a removed call, a removed answer field, a newly required field and a removed event', () => {
  const head = structuredClone(made);
  delete head.paths['/api/tasks'];
  delete head.components.schemas.Row.properties.seq;
  head.paths['/api/bots/{id}/messages'].post.requestBody.content['application/json'].schema.required.push('clientId');
  head.components.schemas.ServerEvent.anyOf = head.components.schemas.ServerEvent.anyOf.filter((v) => v.properties?.type?.const !== 'ping');
  const found = breaks(made, head);
  for (const want of ['GET /api/tasks: removed', 'answer.rows[].seq: removed', 'body.clientId: apps must now send it', 'event: the kind "ping" was removed']) {
    assert.ok(found.some((f) => f.includes(want)), `missed: ${want}\n${found.join('\n')}`);
  }
});

test('adding a call, a field or an event kind passes', () => {
  const head = structuredClone(made);
  head.paths['/api/new'] = { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } } } };
  head.components.schemas.Row.properties.extra = { type: 'string' };
  head.components.schemas.ServerEvent.anyOf.push({ type: 'object', properties: { type: { type: 'string', const: 'new-kind' } }, required: ['type'] });
  assert.deepEqual(breaks(made, head), []);
});

test('nothing here breaks an app compared with origin/main', () => {
  let base;
  try { base = execFileSync('git', ['show', 'origin/main:api/openapi.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return; }
  const accepted = fs.existsSync(new URL('../api/accepted-breaking.md', import.meta.url)) ? fs.readFileSync(new URL('../api/accepted-breaking.md', import.meta.url), 'utf8') : '';
  assert.deepEqual(breaks(JSON.parse(base), made).filter((b) => !accepted.includes(b)), []);
});

test('a call name becomes its address, with parts and query encoded', () => {
  assert.deepEqual(apiPath('GET /api/bots/{id}/rows', { id: 'b 1' }, { beforeSeq: 5, limit: 200, none: undefined }), { method: 'GET', path: '/api/bots/b%201/rows?beforeSeq=5&limit=200' });
  assert.deepEqual(apiPath('POST /api/approvals/{id}', { id: 'a1' }), { method: 'POST', path: '/api/approvals/a1' });
  assert.throws(() => apiPath('GET /api/bots/{id}/rows', {}), /no value for \{id\}/);
});

test('app versions: older than the minimum, and the Windows version read from its browser', () => {
  assert.equal(support.versionBelow('0.1.52', '0.1.53'), true);
  assert.equal(support.versionBelow('0.1.53', '0.1.53'), false);
  assert.equal(support.versionBelow('0.2.0', '0.1.53'), false);
  assert.equal(support.versionBelow('0.1.100', '0.1.53'), false);
  assert.equal(support.versionBelow('not a version', '0.1.53'), false);
  assert.equal(support.versionBelow(null, '0.1.53'), false);
  assert.equal(support.desktopVersion('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) YBots/0.13.1 Chrome/142.0.7444.59 Electron/39.2.3 Safari/537.36'), '0.13.1');
  assert.equal(support.desktopVersion('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'), null);
});

process.exit(failures ? 1 : 0);
