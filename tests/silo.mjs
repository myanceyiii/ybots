// Checks for siloed bots (server/src/silo.ts): what a siloed bot may send to another bot.
// Usage: npm run build -w server && node tests/silo.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cleft-silo-'));
process.env.DB_PATH = path.join(TMP, 'db.sqlite');
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
fs.writeFileSync(path.join(TMP, 'key'), 'k123\n');
process.env.SILO_BOTS = JSON.stringify({
  bot_sheldon: { url: 'http://127.0.0.1:8653/', keyFile: path.join(TMP, 'key'), vnc: '127.0.0.1:5953', allow: { Leonard: ['CAL', 'ITINERARY', 'RECEIPT', 'Q', 'A'], robin: ['CAL', 'BOGUS'] } },
  'name:Sheldon Two': { url: 'http://127.0.0.1:8654', allow: {} },
});

const silo = await import('../server/dist/silo.js');
const { db } = await import('../server/dist/db.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`PASS ${name}`); };

t('config: by id, trailing slash trimmed, key read from file, unknown types dropped', () => {
  assert.equal(silo.isSilo('bot_sheldon'), true);
  assert.equal(silo.siloFor('bot_sheldon').url, 'http://127.0.0.1:8653');
  assert.equal(silo.siloKey('bot_sheldon'), 'k123');
  assert.deepEqual(silo.siloFor('bot_sheldon').allow.robin, ['CAL']);
  assert.deepEqual(silo.siloVnc('bot_sheldon'), { host: '127.0.0.1', port: 5953, password: '' });
  assert.equal(silo.isSilo('bot_other'), false);
});

t('config: name: keys match a bot by name, case-insensitively', () => {
  db.prepare('INSERT OR IGNORE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'owner@test.invalid', 'Owner', Date.now());
  db.prepare('INSERT OR REPLACE INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run('bot_x', 'u1', 'sheldon two', Date.now(), Date.now());
  assert.equal(silo.isSilo('bot_x'), true);
  assert.equal(silo.siloFor('bot_x').url, 'http://127.0.0.1:8654');
});

const out = (to, type, data, msg = '') => silo.checkSiloOutgoing('bot_sheldon', `id_${to}`, to, type, data, msg);

t('CAL to Leonard and Robin: rebuilt from fields only', () => {
  const r = out('Leonard', 'CAL', { start: '2026-11-23T09:00', end: '2026-11-23T11:00', status: 'busy' });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'CAL busy 2026-11-23T09:00 to 2026-11-23T11:00');
  assert.equal(out('ROBIN', 'CAL', { start: '2026-11-23', end: '2026-11-24', status: 'away' }).ok, true);
});

t('CAL refuses a reason, a title, bad times or a bad status', () => {
  assert.equal(out('Robin', 'CAL', { start: '2026-11-23T09:00', end: '2026-11-23T11:00', status: 'busy', title: 'Deposition, Smith v. Jones' }).ok, false);
  assert.equal(out('Robin', 'CAL', { start: 'tomorrow', end: '2026-11-23T11:00', status: 'busy' }).ok, false);
  assert.equal(out('Robin', 'CAL', { start: '2026-11-23T11:00', end: '2026-11-23T09:00', status: 'busy' }).ok, false);
  assert.equal(out('Robin', 'CAL', { start: '2026-11-23T09:00', end: '2026-11-23T11:00', status: 'in court' }).ok, false);
});

t('Robin gets CAL only; Howard and unknown bots get nothing', () => {
  assert.equal(out('Robin', 'Q', undefined, 'Are you free?').ok, false);
  assert.equal(out('Robin', 'RECEIPT', { date: '2026-11-20', amount: 12, currency: 'USD', category: 'meals' }).ok, false);
  assert.match(out('Howard', 'CAL', { start: '2026-11-23', end: '2026-11-23', status: 'busy' }).why, /may not send/);
  assert.match(out('Leonard', '', {}, 'hi').why, /Give a type/);
});

t('ITINERARY and RECEIPT: short labels only, no extra fields', () => {
  const i = out('Leonard', 'ITINERARY', { kind: 'flight', start: '2026-12-01T07:10', end: '2026-12-01T09:40', from: 'MSY', to: 'DFW', carrier: 'American', number: 'AA 1234' });
  assert.equal(i.ok, true);
  assert.equal(i.text, 'ITINERARY flight | 2026-12-01T07:10 to 2026-12-01T09:40 | MSY -> DFW | American AA 1234');
  assert.equal(out('Leonard', 'ITINERARY', { kind: 'flight', start: '2026-12-01', purpose: 'hearing' }).ok, false);
  assert.equal(out('Leonard', 'ITINERARY', { kind: 'flight', start: '2026-12-01', to: 'Dallas\nfor the Jones hearing' }).ok, false);
  assert.equal(out('Leonard', 'ITINERARY', { kind: 'flight', start: '2026-12-01', to: 'x'.repeat(61) }).ok, false);
  const r = out('Leonard', 'RECEIPT', { date: '2026-11-20', amount: '41.5', currency: 'USD', category: 'meals', vendor: 'Cafe Du Monde' });
  assert.equal(r.text, 'RECEIPT 2026-11-20 41.50 USD meals Cafe Du Monde (reimbursable)');
  assert.equal(out('Leonard', 'RECEIPT', { date: '2026-11-20', amount: 5, currency: 'usd', category: 'meals' }).ok, false);
  assert.equal(out('Leonard', 'RECEIPT', { date: '2026-11-20', amount: 5, currency: 'USD', category: 'meals', client: 'Acme' }).ok, false);
});

t('Q and A to Leonard: text only, capped', () => {
  assert.equal(out('Leonard', 'Q', undefined, 'Is Alex free Friday afternoon?').text, 'Q (work calendar): Is Alex free Friday afternoon?');
  assert.equal(out('Leonard', 'A', {}, 'Yes').ok, true);
  assert.equal(out('Leonard', 'Q', { matter: 'x' }, 'hi').ok, false);
  assert.equal(out('Leonard', 'A', undefined, 'x'.repeat(501)).ok, false);
  assert.equal(out('Leonard', 'A', undefined, '   ').ok, false);
});

t('delivery: only a checked text, once, to the checked recipient', () => {
  const r = out('Leonard', 'A', undefined, 'Booked.');
  assert.equal(silo.takeCleared('bot_sheldon', 'id_Robin', r.text), false);
  assert.equal(silo.takeCleared('bot_sheldon', 'id_Leonard', 'something else'), false);
  assert.equal(silo.takeCleared('bot_sheldon', 'id_Leonard', r.text), true);
  assert.equal(silo.takeCleared('bot_sheldon', 'id_Leonard', r.text), false);
});

console.log(`\n${n} passed`);
fs.rmSync(TMP, { recursive: true, force: true });
