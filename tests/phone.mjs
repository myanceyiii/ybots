// Tests for phone timers and alarms (server/src/phone.ts) against the built server code and a
// throwaway database. A phone link is stood in for by a function that answers like the Android app would.
//   npm run build -w server && node tests/phone.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleftbot-phone-'));
Object.assign(process.env, {
  HOME: dir, NODE_ENV: 'test', SESSION_SECRET: crypto.randomBytes(32).toString('hex'), DB_PATH: path.join(dir, 'hq.db'),
  APPS_CONFIG: path.join(dir, 'apps.json'), HERMES_URL: 'http://127.0.0.1:9', HERMES_HOME_PRIMARY: path.join(dir, 'hermes'),
  HERMES_BIN: path.join(dir, 'no-hermes'), ENGINES_DIR: path.join(dir, 'engines'), CLEFTBOT_NO_SCHEDULER: '1',
  PLUGINS_DIR: path.join(dir, 'plugins'), APP_URL: 'http://localhost:5173', OWNER_EMAIL: 'owner@example.test',
});
fs.writeFileSync(process.env.APPS_CONFIG, JSON.stringify({ apps: [] }));

const { db } = await import('../server/dist/db.js');
const phone = await import('../server/dist/phone.js');
const tools = await import('../server/dist/agent/tools.js');
const prompt = await import('../server/dist/agent/prompt.js');

const t0 = Date.now();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'owner@example.test', 'Alex', t0);
const addBot = (id, name, i) => db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, 'u1', name, t0 + i, t0 + i);
addBot('b_leo', 'Leonard', 1);
addBot('b_how', 'Howard', 2);
addBot('b_pen', 'Robin', 3);
const rows = (id) => db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='notice' ORDER BY seq").all(id).map((r) => JSON.parse(r.body).text);

// Who gets the tool: Leonard by default, others only when switched on.
assert.equal(phone.phoneActionsOn('b_leo'), true);
assert.equal(phone.phoneActionsOn('b_how'), false);
const tool = tools.toolMap.get('phone_action');
assert.equal(tools.toolFor(tool, 'b_leo'), true);
assert.equal(tools.toolFor(tool, 'b_how'), false);
db.prepare('UPDATE bots SET phone_actions=1 WHERE id=?').run('b_how');
assert.equal(phone.phoneActionsOn('b_how'), true);
db.prepare('UPDATE bots SET phone_actions=0 WHERE id=?').run('b_leo');
assert.match((await phone.runPhoneAction({ userId: 'u1', botId: 'b_leo' }, { action: 'set_timer', minutes: 5 })).output, /off for you/);
db.prepare('UPDATE bots SET phone_actions=NULL WHERE id=?').run('b_leo');

// Checking what the bot asked for.
assert.deepEqual(phone.cleanCommand({ action: 'set_timer', minutes: 10, label: ' pasta ' }), { action: 'set_timer', seconds: 600, label: 'pasta' });
assert.match(phone.cleanCommand({ action: 'set_timer', hours: 25 }), /24 hours/);
assert.deepEqual(phone.cleanCommand({ action: 'set_alarm', hour: 6, minute: 30, days: ['Mon', 'wed', 'mon'] }), { action: 'set_alarm', hour: 6, minute: 30, days: [2, 4], label: 'YBots' });
assert.match(phone.cleanCommand({ action: 'set_alarm', hour: 24 }), /hour/);
assert.match(phone.cleanCommand({ action: 'reboot' }), /action must be/);
assert.equal(phone.describe({ action: 'set_alarm', hour: 6, minute: 5, days: [2, 4], label: 'Gym' }), 'an alarm for 6:05 AM on Mon, Wed (Gym)');
assert.equal(phone.describe({ action: 'set_timer', seconds: 3725 }), 'a 1 h 2 min 5 s timer');

// No phone connected: nothing is sent and the bot is told to offer a reminder.
let r = await phone.runPhoneAction({ userId: 'u1', botId: 'b_leo' }, { action: 'set_timer', minutes: 10 });
assert.equal(r.summary, 'failed');
assert.match(r.output, /not connected/);

// A phone that answers "done".
const sent = [];
let reply = 'done';
const goodbye = phone.addPhoneLink('u1', 'main', (data) => {
  const ev = JSON.parse(data);
  sent.push(ev);
  setTimeout(() => phone.phoneResult('u1', ev.a.id, { state: reply, detail: reply === 'failed' ? 'No clock app' : undefined }), 5);
});
r = await phone.runPhoneAction({ userId: 'u1', botId: 'b_leo' }, { action: 'set_timer', minutes: 10, label: 'pasta' });
assert.equal(r.summary, 'done');
assert.equal(sent.length, 1);
assert.equal(sent[0].type, 'phone-action');
assert.equal(sent[0].a.seconds, 600);
assert.equal(sent[0].a.by, 'Leonard');
assert.match(rows('b_leo').at(-1), /Set a 10 min timer \(pasta\) on your phone/);
assert.equal(db.prepare('SELECT state FROM phone_actions WHERE id=?').get(sent[0].a.id).state, 'done');
// Answered once only.
assert.equal(phone.phoneResult('u1', sent[0].a.id, { state: 'failed' }), false);

reply = 'needs_tap';
r = await phone.runPhoneAction({ userId: 'u1', botId: 'b_leo' }, { action: 'set_alarm', hour: 7, minute: 0, label: 'Gym' });
assert.equal(r.summary, 'needs tap');
assert.match(rows('b_leo').at(-1), /needs a tap/);
reply = 'failed';
r = await phone.runPhoneAction({ userId: 'u1', botId: 'b_leo' }, { action: 'show_alarms' });
assert.equal(r.summary, 'failed');
assert.match(rows('b_leo').at(-1), /No clock app/);

// A phone that never answers: the bot hears it was sent but not confirmed.
goodbye();
const silent = phone.addPhoneLink('u1', 'main', () => {});
r = await phone.runPhoneAction({ userId: 'u1', botId: 'b_leo' }, { action: 'show_timers' }, 50);
assert.equal(r.summary, 'failed');
assert.match(r.output, /did not answer/);
silent();

// Every bot's commands go to the YBots app.
assert.equal(phone.profileFor('u1', 'b_pen'), 'main');

// Prompt: phone lines only for a bot with phone actions on.
assert.match(prompt.phoneGuidance('b_leo', 'Alex'), /phone_action/);
db.prepare('UPDATE bots SET phone_actions=0 WHERE id=?').run('b_how');
assert.equal(prompt.phoneGuidance('b_how', 'Alex'), '');

console.log('phone: all passed');
process.exit(0);
