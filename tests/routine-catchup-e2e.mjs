// A routine run that fell due while the server was down is caught up after start, once, and only when it
// really was missed. Hermetic: a throwaway server restarted on the same folder, a fake Hermes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { root, runner, sleep, startServer } from './lib/server.mjs';

const require = createRequire(path.join(root, 'server/package.json'));
const Database = require('better-sqlite3');
const { test, done } = runner();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-'));
const secret = 'c'.repeat(64);
const HOUR = 3600_000;

// First run: make the account, its bot and the routines.
let s = await startServer({ dir, keepDir: true, secret, name: 'catchup' });
let botId;
try {
  const me = await s.signIn('owner@example.com');
  botId = (await me.api('GET', '/bots')).json.bots[0].id;
} finally { await s.stop(); }

const db = new Database(path.join(dir, 'test.db'));
const t = Date.now();
const add = (id, name, schedule, fields = {}) => {
  db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)').run(id, botId, name, `do ${name}`, schedule, 'UTC', t - 48 * HOUR);
  for (const [k, v] of Object.entries(fields)) db.prepare(`UPDATE routines SET ${k}=? WHERE id=?`).run(v, id);
};
// Hourly: the top of this hour has passed (unless the test runs in its very first second).
add('rtn_missed', 'missed hourly', '0 * * * *', { last_run_at: t - 3 * HOUR });
add('rtn_ran', 'ran on time', '0 * * * *', { last_run_at: t });
add('rtn_often', 'every five minutes', '*/5 * * * *', { last_run_at: t - 3 * HOUR });
add('rtn_off', 'switched off', '0 * * * *', { last_run_at: t - 3 * HOUR, enabled: 0 });
// Switched on again a moment ago: the hour that passed while it was off is not a missed run.
add('rtn_rearmed', 'switched on again', '0 * * * *', { last_run_at: t - 3 * HOUR, armed_at: t });
// Yearly, due eleven days ago: far too late to arrive now.
const old = new Date(t - 11 * 24 * HOUR);
add('rtn_stale', 'long ago', `0 0 ${old.getUTCDate()} ${old.getUTCMonth() + 1} *`, {});
db.close();

s = await startServer({ dir, keepDir: true, secret, name: 'catchup', env: { BOTHQ_NO_SCHEDULER: '0', ROUTINE_CATCHUP_DELAY_MS: '300' } });
try {
  const me = await s.signIn('owner@example.com');
  const runs = async () => (await me.api('GET', `/bots/${botId}/rows`)).json.rows.filter((r) => r.body.type === 'event' && r.body.event === 'routine-run').map((r) => r.body.text);

  await test('the missed run is caught up once, and says why; the others are left alone', async () => {
    let got = [];
    for (let i = 0; i < 40 && !got.length; i++) { await sleep(150); got = await runs(); }
    await sleep(1200);
    got = await runs();
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.match(got[0], /^Running routine: missed hourly \(was due at .* while the server was restarting\)$/);
    assert.match(s.state.log, /\[routines\] catching up rtn_missed/);
  });

  await test('a caught-up run counts as run: the next start does not repeat it', async () => {
    const check = new Database(path.join(dir, 'test.db'), { readonly: true });
    const row = check.prepare("SELECT last_run_at FROM routines WHERE id='rtn_missed'").get();
    check.close();
    assert.ok(Date.now() - row.last_run_at < 60_000);
  });
} finally { await s.stop(); }

s = await startServer({ dir, secret, name: 'catchup', env: { BOTHQ_NO_SCHEDULER: '0', ROUTINE_CATCHUP_DELAY_MS: '300' } });
try {
  await test('after a second restart nothing is caught up again', async () => {
    await sleep(1500);
    assert.doesNotMatch(s.state.log, /catching up/);
  });
} finally { await s.stop(); }
done();
