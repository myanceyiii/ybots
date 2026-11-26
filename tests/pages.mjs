// Checks Pages (server/src/pages.ts): making one from markdown, changes from a bot and a person, clashes on the
// same block, history, restore and undo, edits made straight to the file, and every export format.
// Needs LibreOffice (writer, calc) for docx/odt/pdf/xlsx. Usage: npm run build -w server && node tests/pages.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cleft-pages-'));
process.env.DB_PATH = path.join(TMP, 'db.sqlite');
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.HQ_LOCAL = '1';

const F = await import('../server/dist/files.js');
const P = await import('../server/dist/pages.js');
const { hub } = await import('../server/dist/lib/hub.js');
const { db } = await import('../server/dist/db.js');

const userId = 'usr_pagestest';
const botId = `bot_test${crypto.randomBytes(4).toString('hex')}`;
db.prepare("INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)").run(userId, 'p@example.invalid', 'Alex', Date.now());
try { db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(botId, userId, 'Leonard', Date.now(), Date.now()); }
catch (e) { console.log(`(bots row: ${e.message})`); }
const events = [];
hub.subscribe(userId, (ev) => events.push(ev));

fs.mkdirSync(F.workspaceRoot(botId), { recursive: true });
const bot = { kind: 'bot', id: botId, name: 'Leonard' };
const me = { kind: 'person', id: userId, name: 'Alex' };
let failures = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${e?.stack ?? e}`); }
};

await t('creating a Page never overwrites an occupied name when suffixes run out', () => {
  const root = F.workspaceRoot(botId);
  for (let i = 1; i <= 99; i++) {
    const suffix = i === 1 ? '' : ` (${i})`;
    fs.writeFileSync(path.join(root, `Occupied${suffix}.page.json`), `original ${i}`);
  }
  assert.throws(() => P.createPage(botId, { title: 'Occupied' }, me), (e) => e.status === 409);
  assert.equal(fs.readFileSync(path.join(root, 'Occupied (99).page.json'), 'utf8'), 'original 99');
});

let rel;
let ids = {};
await t('a bot makes a Page from markdown and blocks', () => {
  const out = P.createPage(botId, {
    title: 'Trip plan',
    markdown: '## Packing\n\n- [ ] Passports\n- [x] Chargers\n\n| Item | Cost | Tax |\n|---|---|---|\n| Hotel | 300 | 30 |\n| Car | 120 | 12 |\n\n> Book by Friday\n\nSome **notes** here.',
    blocks: [{ type: 'chart', chart: 'bar', title: 'Costs' }, { type: 'button', label: 'Re-check', message: 'Re-check prices' }, { type: 'form', fields: [{ id: 'who', label: 'Who goes', kind: 'text' }] }, { type: 'choice', question: 'Where?', options: ['Beach', 'Mountains'] }],
  }, bot);
  rel = out.path;
  assert.equal(rel, 'Trip plan.page.json');
  assert.equal(F.fileKind(rel), 'page');
  const types = out.page.blocks.map((b) => b.type);
  assert.deepEqual(types, ['heading', 'checklist', 'table', 'callout', 'text', 'chart', 'button', 'form', 'choice']);
  for (const b of out.page.blocks) ids[b.type] = b.id;
  assert.equal(out.page.blocks[1].items[1].done, true);
  assert.deepEqual(out.page.blocks[2].rows, [['Hotel', '300', '30'], ['Car', '120', '12']]);
  assert.ok(events.some((e) => e.type === 'page' && e.path === rel && e.byKind === 'bot'));
  // A second Page with the same title gets its own file.
  assert.equal(P.createPage(botId, { title: 'Trip plan' }, bot).path, 'Trip plan (2).page.json');
});

await t('a failed move preserves the block and independent edits in the same request', () => {
  const created = P.createPage(botId, { title: 'Move regression', blocks: [{ type: 'text', md: 'first' }, { type: 'text', md: 'second' }] }, me);
  const [a, b] = created.page.blocks.map((block) => block.id);
  const out = P.applyOps(botId, created.path, [{ op: 'move', id: a, after: 'missing' }, { op: 'title', title: 'Renamed' }], me);
  assert.equal(out.results[0].ok, false);
  assert.equal(out.results[1].ok, true);
  assert.deepEqual(P.loadPage(botId, created.path).blocks.map((block) => block.id), [a, b]);
  const moved = P.applyOps(botId, created.path, [{ op: 'move', id: a, after: b }], me);
  assert.deepEqual(moved.page.blocks.map((block) => block.id), [b, a]);
});

await t('unknown block types and bad paths are refused', () => {
  assert.throws(() => P.createPage(botId, { title: 'x', blocks: [{ type: 'script', code: 'alert(1)' }] }, bot), /Unknown block type/);
  assert.throws(() => P.createPage(botId, { title: 'x', folder: '../out' }, bot));
  assert.throws(() => P.loadPage(botId, 'notes.md'), /Not a Page/);
});

await t('the person ticks a box and edits a cell; the bot is told on its next read', () => {
  const page = P.loadPage(botId, rel);
  const item = page.blocks.find((b) => b.id === ids.checklist).items[0].id;
  const r = P.applyOps(botId, rel, [{ op: 'check', id: ids.checklist, item, done: true }, { op: 'cell', id: ids.table, row: 1, col: 1, value: '150' }], me);
  assert.ok(r.results.every((x) => x.ok));
  const read = JSON.parse(P.readForBot(botId, rel, 'Leonard'));
  assert.equal(read.changesByPeopleSinceYouLastRead.length, 1);
  assert.match(read.changesByPeopleSinceYouLastRead[0].what, /ticked "Passports"/);
  assert.equal(read.blocks.find((b) => b.id === ids.table).rows[1][1], '150');
  // Read again: nothing new.
  assert.equal(JSON.parse(P.readForBot(botId, rel, 'Leonard')).changesByPeopleSinceYouLastRead.length, 0);
});

await t('a bot edit to a block the person changed after the bot read it is refused, with the current block', () => {
  const page = P.loadPage(botId, rel);
  const text = page.blocks.find((b) => b.id === ids.text);
  P.applyOps(botId, rel, [{ op: 'update', id: ids.text, base: text.rev, set: { md: 'Alex wrote this.' } }], me);
  const r = P.applyOps(botId, rel, [{ op: 'update', id: ids.text, set: { md: 'Bot overwrite' } }, { op: 'insert', block: { type: 'text', md: 'New bot paragraph' } }], bot);
  assert.equal(r.results[0].ok, false);
  assert.equal(r.results[0].conflict, true);
  assert.equal(r.results[0].current.md, 'Alex wrote this.');
  assert.equal(r.results[1].ok, true, 'the other change still goes in');
  assert.equal(P.loadPage(botId, rel).blocks.find((b) => b.id === ids.text).md, 'Alex wrote this.');
  // After reading, the bot can build on it.
  P.readForBot(botId, rel, 'Leonard');
  const r2 = P.applyOps(botId, rel, [{ op: 'update', id: ids.text, set: { md: 'Alex wrote this. Bot added this.' } }], bot);
  assert.equal(r2.results[0].ok, true);
});

await t("a person's late edit is kept beside the bot's text until they pick", () => {
  const page = P.loadPage(botId, rel);
  const seen = page.blocks.find((b) => b.id === ids.callout).rev;
  P.applyOps(botId, rel, [{ op: 'update', id: ids.callout, set: { md: 'Bot: book by Thursday' } }], bot);
  const r = P.applyOps(botId, rel, [{ op: 'update', id: ids.callout, base: seen, set: { md: 'Me: book by Friday noon' } }], me);
  assert.equal(r.results[0].conflict, true);
  let b = P.loadPage(botId, rel).blocks.find((x) => x.id === ids.callout);
  assert.equal(b.md, 'Bot: book by Thursday');
  assert.equal(b.alt.fields.md, 'Me: book by Friday noon');
  P.applyOps(botId, rel, [{ op: 'resolve', id: ids.callout, keep: 'mine' }], me);
  b = P.loadPage(botId, rel).blocks.find((x) => x.id === ids.callout);
  assert.equal(b.md, 'Me: book by Friday noon');
  assert.equal(b.alt, undefined);
});

await t('forms, choices, rows, moves and deletes', () => {
  const r = P.applyOps(botId, rel, [
    { op: 'field', id: ids.form, field: 'who', value: 'Alex and Sam' },
    { op: 'submitted', id: ids.form },
    { op: 'pick', id: ids.choice, picked: [1, 0] },
    { op: 'add_row', id: ids.table, values: ['Food', '200', '0'] },
    { op: 'move', id: ids.button, after: 'start' },
    { op: 'delete', id: 'nope' },
  ], me);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true, true, true, false]);
  const page = P.loadPage(botId, rel);
  assert.deepEqual(page.blocks.find((b) => b.id === ids.choice).picked, [1], 'single choice keeps one pick');
  assert.equal(page.blocks[0].id, ids.button);
  assert.equal(page.blocks.find((b) => b.id === ids.table).rows.length, 3);
});

await t('typing in one block for a while is one history entry; restore and undo', () => {
  const before = P.history(botId, rel).length;
  for (const md of ['a', 'ab', 'abc']) {
    const b = P.loadPage(botId, rel).blocks.find((x) => x.id === ids.text);
    P.applyOps(botId, rel, [{ op: 'update', id: ids.text, base: b.rev, set: { md } }], me);
  }
  const h = P.history(botId, rel);
  assert.equal(h.length, before + 1);
  assert.equal(h[0].by, 'Alex');
  const v = P.versionOf(botId, rel, h[1].version);
  assert.notEqual(v.blocks.find((b) => b.id === ids.text).md, 'abc');
  const undone = P.undoLast(botId, rel, me);
  assert.equal(undone.blocks.find((b) => b.id === ids.text).md, v.blocks.find((b) => b.id === ids.text).md);
  const back = P.restore(botId, rel, h[0].version, me);
  assert.equal(back.blocks.find((b) => b.id === ids.text).md, 'abc');
  assert.throws(() => { P.applyOps(botId, rel, [{ op: 'title', title: 'Bot title' }], bot); P.undoLast(botId, rel, me); }, /isn’t the latest/);
});

await t('an edit made straight to the file is recorded and cleaned', () => {
  const file = path.join(F.workspaceRoot(botId), rel);
  const page = JSON.parse(fs.readFileSync(file, 'utf8'));
  page.blocks.push({ id: 'zz', type: 'text', md: 'hand edit', evil: '<script>' });
  page.blocks.push({ id: 'yy', type: 'html', html: '<script>alert(1)</script>' });
  fs.writeFileSync(file, JSON.stringify(page));
  const loaded = P.loadPage(botId, rel, 'Leonard');
  assert.ok(loaded.blocks.some((b) => b.id === 'zz' && b.md === 'hand edit' && !('evil' in b)));
  assert.ok(!loaded.blocks.some((b) => b.type === 'html'));
  assert.equal(P.history(botId, rel)[0].summary, 'edited the file directly');
});

await t('a Page shows up as a file a turn made', () => {
  assert.ok(F.changedSince(botId, Date.now() - 60_000).some((f) => f.path === rel && f.kind === 'page'));
});

await t('exports: markdown, text and html', async () => {
  const md = await P.exportPage(botId, rel, 'md');
  const mdText = fs.readFileSync(path.join(F.workspaceRoot(botId), md.path), 'utf8');
  assert.equal(md.path, 'Trip plan.md');
  assert.match(mdText, /^# Bot title/);
  assert.match(mdText, /- \[x\] Passports/);
  assert.match(mdText, /\| Hotel \| 300 \| 30 \|/);
  assert.match(mdText, /\*\*Who goes:\*\* Alex and Sam/);
  assert.match(mdText, /- \[x\] Mountains/);
  assert.match(mdText, /\*\*Costs\*\* \(bar chart\)/);
  assert.doesNotMatch(mdText, /Re-check/, 'buttons are left out');
  const txt = fs.readFileSync(path.join(F.workspaceRoot(botId), (await P.exportPage(botId, rel, 'txt')).path), 'utf8');
  assert.match(txt, /\[x\] Passports/);
  assert.doesNotMatch(txt, /\*\*/);
  const html = fs.readFileSync(path.join(F.workspaceRoot(botId), (await P.exportPage(botId, rel, 'html')).path), 'utf8');
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /<svg/);
  assert.match(html, /☑ Passports/);
  // Exporting again never writes over the document already there (it may have been edited since).
  const again = await P.exportPage(botId, rel, 'md');
  assert.equal(again.path, 'Trip plan (2).md');
  assert.equal(fs.readFileSync(path.join(F.workspaceRoot(botId), 'Trip plan.md'), 'utf8'), mdText);
});

await t('a damaged Page file still shows its history and can be restored', () => {
  const p = P.createPage(botId, { title: 'Fragile', blocks: [{ type: 'text', md: 'one' }] }, me);
  const file = path.join(F.workspaceRoot(botId), p.path);
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, good.slice(0, 40));
  assert.throws(() => P.loadPage(botId, p.path), (e) => e.status === 422);
  const h = P.history(botId, p.path);
  assert.ok(h.length >= 1);
  const back = P.restore(botId, p.path, h[0].version, me);
  assert.equal(back.blocks[0].md, 'one');
  assert.equal(P.loadPage(botId, p.path).blocks[0].md, 'one');
});

await t('a chart drawn from a table uses its number columns', () => {
  const page = P.loadPage(botId, rel);
  P.applyOps(botId, rel, [{ op: 'update', id: ids.chart, set: { from: ids.table } }], bot);
  const d = P.chartData(P.loadPage(botId, rel).blocks.find((b) => b.id === ids.chart), P.loadPage(botId, rel));
  assert.deepEqual(d.labels, ['Hotel', 'Car', 'Food']);
  assert.deepEqual(d.series.map((s) => s.name), ['Cost', 'Tax']);
  assert.deepEqual(d.series[0].values, [300, 150, 200]);
  assert.ok(page);
});

await t('the bot tools: page_create, page_read (list and one), page_update, page_export', async () => {
  const { TOOLS } = await import('../server/dist/agent/tools.js');
  const tool = (n) => TOOLS.find((x) => x.name === n);
  const ctx = { userId, botId, depth: 0, enqueueBotMessage: () => {} };
  const made = JSON.parse((await tool('page_create').impl({ title: 'Groceries', markdown: '- [ ] Milk' }, ctx)).output);
  assert.equal(made.path, 'Groceries.page.json');
  const list = JSON.parse((await tool('page_read').impl({}, ctx)).output);
  assert.ok(list.pages.some((p) => p.path === 'Groceries.page.json'));
  const full = `${F.workspaceRoot(botId)}/Groceries.page.json`;
  const read = JSON.parse((await tool('page_read').impl({ path: full }, ctx)).output);
  assert.equal(read.blocks[0].type, 'checklist');
  const up = JSON.parse((await tool('page_update').impl({ path: 'Groceries.page.json', ops: [{ op: 'add_item', id: read.blocks[0].id, text: 'Eggs' }] }, ctx)).output);
  assert.equal(up.results[0].ok, true);
  assert.match((await tool('page_update').impl({ path: '../x.page.json', ops: [] }, ctx)).output, /inside your workspace/);
  const ex = JSON.parse((await tool('page_export').impl({ path: 'Groceries.page.json', format: 'md' }, ctx)).output);
  assert.equal(ex.name, 'Groceries.md');
});

const hasOffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (hasOffice) {
  await t('exports: Word, OpenDocument and PDF (with the chart picture), CSV and Excel', async () => {
    for (const f of ['docx', 'odt', 'pdf', 'csv', 'xlsx']) {
      const out = await P.exportPage(botId, rel, f);
      const file = path.join(F.workspaceRoot(botId), out.path);
      assert.ok(fs.statSync(file).size > 20, `${f} is not empty`);
      if (f === 'pdf') assert.equal(fs.readFileSync(file).subarray(0, 4).toString(), '%PDF');
      if (f === 'csv') assert.equal(fs.readFileSync(file, 'utf8').split('\n')[0], 'Item,Cost,Tax');
      if (f === 'docx') {
        const list = execFileSync('unzip', ['-l', file]).toString();
        assert.match(list, /word\/media\//, 'the chart picture is inside the Word file');
        const doc = execFileSync('unzip', ['-p', file, 'word/document.xml']).toString();
        assert.match(doc, /Passports/);
        assert.match(doc, /Hotel/);
      }
    }
  });
} else console.log('skip office exports (no LibreOffice here)');

const S = await import('../server/dist/page-shelf.js');
const V = await import('../server/dist/views.js');

await t('a calculator opened as a Page stays a working calculator', () => {
  const { card, problems } = V.makeView('Car loan', [{ type: 'calc', title: 'Loan', inputs: [{ id: 'amount', label: 'Amount', kind: 'slider', min: 0, max: 50000, value: 20000, prefix: '$' }, { id: 'months', label: 'Months', value: 48 }], outputs: [{ id: 'monthly', label: 'Monthly', formula: 'amount / months', format: 'money' }] }]);
  assert.deepEqual(problems, []);
  card.blocks[0].values = { amount: 24000, months: 48 };
  const out = P.createPage(botId, { title: 'Car loan', blocks: V.viewToPageBlocks(card) }, me);
  const c = out.page.blocks[0];
  assert.equal(c.type, 'calc');
  assert.equal(c.values.amount, 24000, 'your numbers are kept');
  const r = P.applyOps(botId, out.path, [{ op: 'calc', id: c.id, values: { amount: 99999999, months: 12 } }], me);
  assert.equal(r.results[0].ok, true);
  assert.equal(r.page.blocks[0].values.amount, 50000, 'kept inside the slider range');
  assert.match(P.toMarkdown(r.page), /Monthly \| \$4,166\.67/);
  assert.throws(() => P.createPage(botId, { title: 'Bad', blocks: [{ type: 'calc', inputs: [] }] }, bot), /needs inputs/);
  S.notePageOrigin(botId, out.page.id, { kind: 'view', seq: 7 });
  const item = S.listShelf(botId).find((p) => p.path === out.path);
  assert.equal(item.kind, 'calculator');
  assert.deepEqual(item.origin, { chatId: botId, chatTitle: 'Main chat', kind: 'view', seq: 7 });
  assert.equal(item.sendTo, botId);
});

await t('Pages tab: pinned first, delete with Undo, a deleted Page is out of every list', () => {
  const list0 = S.listShelf(botId);
  const last = list0[list0.length - 1];
  S.setPinned(botId, last.path, true);
  assert.equal(S.listShelf(botId)[0].path, last.path);
  const { id } = S.trashPage(botId, last.path);
  assert.ok(!S.listShelf(botId).some((p) => p.path === last.path));
  assert.ok(!F.changedSince(botId, 0, 500).some((f) => f.path.includes('.cleft-trash')), 'the bot does not see the trash');
  fs.writeFileSync(path.join(F.workspaceRoot(botId), last.path), 'someone took the name');
  const back = S.restoreFromTrash(botId, id);
  assert.notEqual(back.path, last.path, 'a file that took the name is not replaced');
  const again = S.listShelf(botId).find((p) => p.path === back.path);
  assert.equal(again.pinned, true);
  assert.ok(events.some((e) => e.type === 'pages' && e.botId === botId));
  assert.throws(() => S.restoreFromTrash(botId, id), /no longer in the trash/);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
