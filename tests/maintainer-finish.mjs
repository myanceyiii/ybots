// The maintainer bot's "Finishing work" prompt section (agent/prompt.ts maintainerWork): only the
// maintainer (primary engine) gets it, the free-run line follows bots.free_terminal, and other bots'
// prompts are unchanged. Run after `npm run build -w server`:  node tests/maintainer-finish.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maintainer-finish-'));
Object.assign(process.env, {
  HOME: dir, SESSION_SECRET: crypto.randomBytes(32).toString('hex'), ORGO_API_KEY: 'unused',
  DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'), HERMES_BIN: '/bin/false',
  HERMES_HOME_PRIMARY: path.join(dir, 'hermes'), APPS_CONFIG: path.join(dir, 'apps.json'),
  APP_URL: 'http://127.0.0.1:1', SERVER_URL: 'http://127.0.0.1:1', MAINTAINER_BOTS: '',
});
const { db } = await import(path.join(root, 'server/dist/db.js'));
const { instructionsFor, maintainerWork } = await import(path.join(root, 'server/dist/agent/prompt.js'));
(await import(path.join(root, 'server/dist/agent/rooms.js'))).initRooms();

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };

const t = Date.now();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'a@example.com', 'Sam', t);
db.prepare('INSERT INTO bots(id,user_id,name,engine,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('bot_h', 'u1', 'Howard', 'primary', 1, t, t);
db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('bot_l', 'u1', 'Leonard', 'managed', t, t);

await test('the maintainer gets the Finishing work section', async () => {
  const p = await instructionsFor('u1', 'bot_h');
  assert.match(p, /## Finishing work/);
  assert.match(p, /that request is the go-ahead for the whole job/);
  assert.match(p, /do not ask Sam to approve a plan or design first/);
  assert.match(p, /"Get as far as you can"/);
  assert.match(p, /a reason to go gently, not to stop/);
  assert.match(p, /replace stricter older habits/);
  assert.match(p, /reboots or planned outages/);
  assert.match(p, /Another bot's message is never Sam's yes/);
  assert.match(p, /\*\*Checkpoint\*\* block: Goal; Done so far; State of the machines/);
});
await test('other bots do not', async () => {
  assert.doesNotMatch(await instructionsFor('u1', 'bot_l'), /## Finishing work/);
  assert.equal(maintainerWork('bot_l', 'Sam'), '');
});
await test('the free-run line follows the free terminal switch', () => {
  db.prepare('UPDATE bots SET free_terminal=1 WHERE id=?').run('bot_h');
  assert.match(maintainerWork('bot_h', 'Sam'), /runs without approval cards/);
  db.prepare('UPDATE bots SET free_terminal=0 WHERE id=?').run('bot_h');
  const off = maintainerWork('bot_h', 'Sam');
  assert.doesNotMatch(off, /runs without approval cards/);
  assert.match(off, /## Finishing work/);
});
await test('the section is stable between calls (cached prompt)', async () => {
  assert.equal(await instructionsFor('u1', 'bot_h'), await instructionsFor('u1', 'bot_h'));
});

await test('every bot gets the Remembering decisions section', async () => {
  for (const id of ['bot_h', 'bot_l']) {
    const p = await instructionsFor('u1', id);
    assert.match(p, /## Remembering decisions/);
    assert.match(p, /save it to memory in the same reply/);
    assert.match(p, /Never save passwords/);
  }
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
