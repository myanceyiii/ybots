// "Remind me" reminders (server/src/reminders.ts and create_routine once: true in agent/tools.ts):
// a one-time reminder is stored as run_once and always speaks up, a passed time is refused, an ordinary
// routine is unchanged, and the Google Tasks guidance names the real tool and the account.
// Hermetic: a throwaway server and database.  Run after `npm run build -w server`:
//   node tests/reminders-e2e.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { root, runner, startServer } from './lib/server.mjs';

const require = createRequire(path.join(root, 'server/package.json'));
const Database = require('better-sqlite3');
const { test, done } = runner();
const s = await startServer({ name: 'reminders', keepDir: true });

try {
  const me = await s.signIn('owner@example.com');
  const bot = (await me.api('GET', '/bots')).json.bots.find((b) => b.isPrimary);
  const token = crypto.createHmac('sha256', s.SECRET).update(`mcp:${bot.id}`).digest('hex');
  let rpc = 0;
  const tool = async (name, args) => {
    const r = await fetch(`${s.BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }) });
    return (await r.json()).result?.content?.[0]?.text ?? '';
  };
  const row = (name) => new Database(s.dbPath, { readonly: true }).prepare('SELECT * FROM routines WHERE name=?').get(name);

  // Tomorrow at 15:30 UTC, written as a once-a-year schedule like the guidance asks for.
  const t = new Date(Date.now() + 86_400_000);
  const schedule = `30 15 ${t.getUTCDate()} ${t.getUTCMonth() + 1} *`;

  await test('create_routine once: true makes a one-time reminder that always posts', async () => {
    const out = await tool('create_routine', { name: 'Call the dentist', prompt: 'Remind them now: Call the dentist.', schedule, timezone: 'UTC', once: true });
    assert.match(out, /"ok":true/, out);
    const r = row('Call the dentist');
    assert.equal(r.run_once, 1);
    assert.equal(r.quiet, 0);
    assert.equal(r.enabled, 1);
  });

  await test('a once reminder for a time that has passed is refused', async () => {
    const y = new Date(Date.now() - 2 * 86_400_000);
    const out = await tool('create_routine', { name: 'Too late', prompt: 'x', schedule: `0 9 ${y.getUTCDate()} ${y.getUTCMonth() + 1} *`, timezone: 'UTC', once: true });
    assert.match(out, /already passed/, out);
    assert.equal(row('Too late'), undefined);
  });

  await test('an ordinary routine is unchanged (repeats, quiet by default)', async () => {
    const out = await tool('create_routine', { name: 'Morning check', prompt: 'check', schedule: '0 8 * * *', timezone: 'UTC' });
    assert.match(out, /"ok":true/, out);
    const r = row('Morning check');
    assert.equal(r.run_once, 0);
    assert.equal(r.quiet, 1);
  });
} finally { await s.stop(); }

await test('the Google Tasks guidance names the tool, the account and the date-only limit', async () => {
  const { remindersText } = await import('../server/dist/reminders-text.js');
  const txt = remindersText('google-me-example-com__manage_task', 'Alex', 'me@example.com');
  assert.match(txt, /google-me-example-com__manage_task with action "create"/);
  assert.match(txt, /task_list_id "@default", user_google_email "me@example.com"/);
  assert.match(txt, /keeps only the date/);
  assert.match(txt, /create_routine with once: true/);
  assert.match(txt, /not Google Tasks/);
  assert.doesNotMatch(remindersText('x__manage_task', 'Alex', null), /user_google_email/);
});

done();
