// The bot Skills screen's "Save its own skills without asking" switch: PUT /bots/:id/hermes-skills/auto-save
// must reach the switch, not the "save a skill named auto-save" route (bug seen 2026-11-23: "no skill called auto-save").
// Needs a built server: `npm run build -w server`, then `node tests/skills-auto-save.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-auto-save-'));
Object.assign(process.env, { DB_PATH: path.join(dir, 't.db'), ENGINES_DIR: path.join(dir, 'engines'), SESSION_SECRET: 'x'.repeat(64), BOTHQ_NO_SCHEDULER: '1', OWNER_EMAIL: 'o@test.invalid' });
const { db } = await import('../server/dist/db.js');
await import('../server/dist/db-config.js');
const { configApi } = await import('../server/dist/routes-config.js');
const { createSessionToken } = await import('../server/dist/lib/auth.js');

db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'o@test.invalid', 'Owner', Date.now());
db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('bot_p', 'u1', 'Robin', Date.now(), Date.now());
const token = createSessionToken('u1', { owner: true });
const put = (on, session = token) => configApi.request('/bots/bot_p/hermes-skills/auto-save', {
  method: 'PUT', headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' }, body: JSON.stringify({ on }),
});

const script = createSessionToken('u1', { owner: true, agent: 'test runner' });
assert.equal((await put(true, script)).status, 403);
assert.equal(db.prepare('SELECT auto_save_skills FROM bots WHERE id=?').get('bot_p').auto_save_skills, 0);
let r = await put(true);
assert.equal(r.status, 200, await r.clone().text());
assert.deepEqual(await r.json(), { ok: true, autoSave: true });
assert.equal(db.prepare('SELECT auto_save_skills FROM bots WHERE id=?').get('bot_p').auto_save_skills, 1);
r = await put(false);
assert.deepEqual(await r.json(), { ok: true, autoSave: false });
assert.equal(db.prepare('SELECT auto_save_skills FROM bots WHERE id=?').get('bot_p').auto_save_skills, 0);
console.log('ok   auto-save switch reaches its own route');
process.exit(0);
