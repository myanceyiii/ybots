// Approval card icons (server/src/card-icon.ts, and its Android copy): every card gets a logo or a glyph, not a letter.
// Needs a built server: `npm run build -w server`, then `node tests/card-icon.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const c = await import('../server/dist/card-icon.js');

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };

test('the Android copy is the same file, word for word (scripts/shared-copies.mjs)', () => {
  const mobile = fs.readFileSync(new URL('../mobile/src/cardIcon.ts', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../server/src/card-icon.ts', import.meta.url), 'utf8');
  assert.equal(mobile, server);
});
test('known apps show their own logo', () => {
  assert.equal(c.cardIconId({ toolkit: 'actual', toolkitName: 'Actual Budget', tool: 'actual__actual_budgets_setCarryover' }), 'actual');
  assert.equal(c.cardIcon({ toolkit: 'actual' }).kind, 'brand');
  assert.equal(c.cardIconId({ toolkit: 'actual-read', toolkitName: 'Actual (read only)', tool: 'actual-read__x' }), 'actual');
  assert.equal(c.cardIconId({ toolkit: 'gbrain', toolkitName: 'GBrain', tool: 'gbrain__remember' }), 'memory');
});
test('one Google connector shows Gmail, Calendar, Drive or Tasks by the tool', () => {
  assert.equal(c.cardIconId({ toolkit: 'google', toolkitName: 'Google', tool: 'google__create_gmail_draft' }), 'gmail');
  assert.equal(c.cardIconId({ toolkit: 'google', toolkitName: 'Google', tool: 'google__create_event' }), 'gcal');
  assert.equal(c.cardIconId({ toolkit: 'google', toolkitName: 'Google', tool: 'google__upload_file' }), 'gdrive');
  assert.equal(c.cardIconId({ toolkit: 'google', toolkitName: 'Google', tool: 'google__insert_task' }), 'gtasks');
  assert.equal(c.cardIconId({ toolkit: 'google', toolkitName: 'Google', tool: 'google__whoami' }), 'google');
});
test('actions without an app get a glyph for what they do', () => {
  assert.equal(c.cardIconId({ tool: 'hermes__terminal', tools: ['hermes__terminal'], risk: 'shell' }), 'terminal');
  assert.equal(c.cardIconId({ tool: 'hermes__execute_code' }), 'code');
  assert.equal(c.cardIconId({ tool: 'hermes__write_file' }), 'files');
  assert.equal(c.cardIconId({ tool: 'hermes__browser_click' }), 'browser');
  assert.equal(c.cardIconId({ tool: 'pc__run_powershell__abc' }), 'pc');
  assert.equal(c.cardIconId({ tool: 'place_call' }), 'phone');
  assert.equal(c.cardIconId({ tool: 'systemctl' }), 'terminal');
  assert.equal(c.cardIconId({ tool: 'create_plugin' }), 'plugin');
  assert.equal(c.cardIconId({ tool: 'mystery_thing' }), 'tool');
  assert.equal(c.cardIconId({ tool: 'x__mystery', toolkit: 'x-app', toolkitName: 'Something' }), 'connector');
});
test('browser, posting and mail cards get their own icon', () => {
  assert.equal(c.cardIconId({ tool: 'secure_input', secret: {} }), 'secret');
  assert.equal(c.cardIconId({ tool: 'purchase', purchase: {} }), 'purchase');
  assert.equal(c.cardIconId({ tool: 'screen_help', screenHelp: {} }), 'hand');
  assert.equal(c.cardIconId({ tool: 'x', postingPlan: {} }), 'posting');
  assert.equal(c.cardIconId({ toolkit: 'google', toolkitName: 'Google', tool: 'google__send_gmail_message', mail: {} }), 'gmail');
  assert.equal(c.cardIconId({ toolkit: 'mailbox', toolkitName: 'Mailbox', tool: 'mailbox__send', mail: {} }), 'mail');
});
test('every icon has a colour and drawable paths; any card resolves to one', () => {
  for (const [id, i] of Object.entries(c.CARD_ICONS)) {
    assert.match(i.color, /^#[0-9A-Fa-f]{6}$/, id);
    assert.ok(i.d.length && i.d.every((d) => /^[Mm]/.test(d)), id);
    assert.ok(i.label, id);
  }
  for (const card of [{}, { tool: '' }, { risk: 'money' }, { toolkitName: 'Plaid' }]) assert.ok(c.cardIcon(card), JSON.stringify(card));
  assert.equal(c.appIcon('nothing-known', 'Nothing'), null);
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
