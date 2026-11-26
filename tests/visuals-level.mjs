// Per-bot "Visuals in replies" level (server/src/visuals-level.ts): its prompt guidance, the default,
// and that the bot's own prompt (agent/prompt.ts) and API shape follow the setting. Imports the built
// server with a throwaway database. Run after `npm run build -w server`:  node tests/visuals-level.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visuals-level-'));
Object.assign(process.env, {
  HOME: dir, SESSION_SECRET: crypto.randomBytes(32).toString('hex'), ORGO_API_KEY: 'unused',
  DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'), HERMES_BIN: '/bin/false',
  HERMES_HOME_PRIMARY: path.join(dir, 'hermes'), APPS_CONFIG: path.join(dir, 'apps.json'),
  APP_URL: 'http://127.0.0.1:1', SERVER_URL: 'http://127.0.0.1:1',
});
const v = await import(path.join(root, 'server/dist/visuals-level.js'));
const { db } = await import(path.join(root, 'server/dist/db.js'));
const { instructionsFor } = await import(path.join(root, 'server/dist/agent/prompt.js'));
const { getBot } = await import(path.join(root, 'server/dist/store.js'));
(await import(path.join(root, 'server/dist/agent/rooms.js'))).initRooms();

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };

const t = Date.now();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'a@example.com', 'Sam', t);
db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('bot_a', 'u1', 'Alpha', 'managed', t, t);

await test('unknown or empty values fall back to Rich', () => {
  assert.equal(v.visualsOf(null), 'rich');
  assert.equal(v.visualsOf('loud'), 'rich');
  assert.equal(v.visualsOf('minimal'), 'minimal');
});
await test('each level names itself and keeps the never-an-approval line', () => {
  for (const l of v.VISUALS_LEVELS) {
    const g = v.visualsGuidance(l, 'Sam');
    assert.match(g, new RegExp(`set to ${l[0].toUpperCase()}${l.slice(1)} by Sam`));
    assert.match(g, /never an approval/);
  }
});
await test('Rich lists concrete triggers; Minimal keeps tap choices but holds back views', () => {
  const rich = v.visualsGuidance('rich', 'Sam');
  for (const w of ['calc block', 'update_view', 'offer_choices', 'a Page', 'chart', 'key stats', 'checklist']) assert.ok(rich.includes(w), w);
  const min = v.visualsGuidance('minimal', 'Sam');
  assert.match(min, /only when Sam asks/);
  assert.match(min, /offer_choices/);
});
await test('guidance stays short (prompt cost)', () => {
  for (const l of v.VISUALS_LEVELS) assert.ok(v.visualsGuidance(l, 'Sam').length < 1400, `${l}: ${v.visualsGuidance(l, 'Sam').length}`);
});
await test('group lines differ by level and always offer choices', () => {
  const lines = v.VISUALS_LEVELS.map((l) => v.groupVisualsLine(l));
  assert.equal(new Set(lines).size, 3);
  for (const s of lines) assert.match(s, /post_to_group's choices/);
});
await test('a new bot is Rich, in its API shape and its prompt', async () => {
  assert.equal(getBot('bot_a').visuals, 'rich');
  assert.match(await instructionsFor('u1', 'bot_a'), /## Visuals \(set to Rich by Sam\)/);
});
await test('changing the level changes the prompt without touching updated_at', async () => {
  const before = db.prepare('SELECT updated_at FROM bots WHERE id=?').get('bot_a').updated_at;
  db.prepare('UPDATE bots SET visuals=? WHERE id=?').run('minimal', 'bot_a');
  const p = await instructionsFor('u1', 'bot_a');
  assert.match(p, /## Visuals \(set to Minimal by Sam\)/);
  assert.doesNotMatch(p, /set to Rich/);
  assert.equal(getBot('bot_a').visuals, 'minimal');
  assert.equal(db.prepare('SELECT updated_at FROM bots WHERE id=?').get('bot_a').updated_at, before);
});
await test('the PATCH route accepts the three levels only', () => {
  const src = fs.readFileSync(path.join(root, 'server/src/routes.ts'), 'utf8');
  assert.match(src, /oneOf\('visuals', VISUALS_LEVELS\)/);
});

fs.rmSync(dir, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
