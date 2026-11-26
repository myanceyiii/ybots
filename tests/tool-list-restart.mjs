// A managed bot's Hermes whose app tool list is out of date gets its gateway restarted, but only when the
// bot is idle (2026-11-23: Leonard kept an old list after a deploy, so update_view and offer_choices
// stayed unknown to him). Imports the built server with a throwaway database and a fake restart.
// Run after `npm run build -w server`:  node tests/tool-list-restart.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-list-restart-'));
Object.assign(process.env, {
  HOME: dir, SESSION_SECRET: crypto.randomBytes(32).toString('hex'), ORGO_API_KEY: 'unused',
  DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'), HERMES_BIN: '/bin/false',
  HERMES_HOME_PRIMARY: path.join(dir, 'hermes'), APPS_CONFIG: path.join(dir, 'apps.json'),
  APP_URL: 'http://127.0.0.1:1', SERVER_URL: 'http://127.0.0.1:1',
});
const { db } = await import(path.join(root, 'server/dist/db.js'));
const mcp = await import(path.join(root, 'server/dist/mcp.js'));

const t = Date.now();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'a@example.com', 'A', t);
const mk = (id, name, engine) => db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, 'u1', name, engine, t, t);
mk('bot_a', 'Alpha', 'managed');
mk('bot_b', 'Beta', 'managed');
for (const id of ['bot_a', 'bot_b']) fs.mkdirSync(path.join(dir, 'engines', id), { recursive: true });

const restarted = [];
const fake = async (id) => { restarted.push(id); };

// 1. No record yet (a gateway from before this check existed): both are restarted once.
let r = await mcp.refreshStaleToolLists(fake);
assert.deepEqual(r.sort(), ['bot_a', 'bot_b'], 'unknown list -> restart');

// 2. Cooldown: a second pass right away restarts nobody.
r = await mcp.refreshStaleToolLists(fake);
assert.deepEqual(r, [], 'cooldown holds');

// 3. A bot whose Hermes fetched the current list is left alone (fingerprint file written).
const fp = await mcp.toolListFingerprint('bot_a');
fs.writeFileSync(path.join(dir, 'engines', 'bot_a', '.hq-tools-fp'), fp);
assert.equal(mcp.listedFingerprint('bot_a'), fp);
assert.equal(mcp.refreshBlocker('bot_a', Date.now() + 11 * 60_000), null, 'idle after cooldown');

// 4. A waiting approval card blocks a restart.
db.prepare("INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,tools,digest,status,created_at) VALUES ('ap1','bot_b',1,'c','x','[]','d','pending',?)").run(t);
assert.equal(mcp.refreshBlocker('bot_b', Date.now() + 11 * 60_000), 'an approval card is waiting');

// 5. The primary agent is never restarted from here.
mk('bot_p', 'Prime', 'primary');
assert.equal(mcp.refreshBlocker('bot_p'), 'not a managed engine');

console.log('tool-list-restart: all checks passed');
process.exit(0);
