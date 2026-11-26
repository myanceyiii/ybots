// Checks the file pane's server side (server/src/files.ts): safe paths, previews made on this machine,
// the files a turn wrote, and create_document. Needs LibreOffice (writer, calc, impress) and poppler-utils.
// Usage: npm run build -w server && node tests/files.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cleft-files-'));
process.env.DB_PATH = path.join(TMP, 'db.sqlite');
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.HQ_LOCAL = '1';

const F = await import('../server/dist/files.js');
const botId = `bot_test${crypto.randomBytes(4).toString('hex')}`;
const root = F.workspaceRoot(botId);
fs.mkdirSync(root, { recursive: true });
const outside = path.join(TMP, 'secret.txt');
fs.writeFileSync(outside, 'firm material');
let failures = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${e?.stack ?? e}`); }
};

try {
  await t('safeRel refuses climbing and odd paths', () => {
    assert.equal(F.safeRel('a/b.md'), 'a/b.md');
    assert.equal(F.safeRel('/a/'), 'a');
    for (const bad of ['../x', 'a/../../x', 'a//b', './a', 'a\nb', 'a\0b']) assert.equal(F.safeRel(bad), null, bad);
  });

  await t('a link out of the workspace is not readable or writable', () => {
    fs.symlinkSync(outside, path.join(root, 'link.txt'));
    fs.symlinkSync(TMP, path.join(root, 'linkdir'));
    assert.equal(F.insideFile(botId, 'link.txt'), null);
    assert.equal(F.insideFile(botId, 'linkdir/secret.txt'), null);
    assert.equal(F.insideTarget(botId, 'linkdir/new.md'), null);
    assert.equal(F.insideTarget(botId, 'link.txt'), null);
    assert.throws(() => F.saveText(botId, 'linkdir/secret.txt', 'x'));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'firm material');
    fs.unlinkSync(path.join(root, 'link.txt')); fs.unlinkSync(path.join(root, 'linkdir'));
  });

  await t('kinds', () => {
    assert.equal(F.fileKind('a.md'), 'markdown');
    assert.equal(F.fileKind('a.PPTX'), 'office');
    assert.equal(F.fileKind('a.xlsx'), 'sheet');
    assert.equal(F.fileKind('a.py'), 'code');
    assert.equal(F.fileKind('a.zip'), 'other');
  });

  await t('csv parsing keeps quotes, commas and new lines in cells', () => {
    assert.deepEqual(F.parseCsv('a,"b,c","d ""e"""\n1,"x\ny",3\n'), [['a', 'b,c', 'd "e"'], ['1', 'x\ny', '3']]);
  });

  const since = Date.now() - 1000;
  await t('markdown: made, previewed, edited with a conflict check', async () => {
    const f = await F.createDocument(botId, { filename: 'notes', format: 'md', content: '# Hi\n\nText' });
    assert.equal(f.path, 'notes.md');
    const p = await F.previewOf(botId, 'notes.md');
    assert.equal(p.kind, 'markdown'); assert.equal(p.editable, true); assert.match(p.text, /# Hi/);
    const saved = F.saveText(botId, 'notes.md', '# Changed', p.modifiedAt);
    assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), '# Changed');
    assert.throws(() => F.saveText(botId, 'notes.md', 'late', p.modifiedAt - 5000), /changed since/);
    assert.ok(saved.size > 0);
  });

  await t('docx from markdown, previewed as pages', async () => {
    const f = await F.createDocument(botId, { filename: 'Report.docx', format: 'docx', content: '# Report\n\nSome **bold** text.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n', folder: 'reports' });
    assert.equal(f.path, 'reports/Report.docx');
    const p = await F.previewOf(botId, f.path);
    assert.equal(p.kind, 'office'); assert.equal(p.error, undefined); assert.ok(p.pages >= 1);
    const png = await F.pagePng(path.join(root, f.path), 1);
    assert.deepEqual([...fs.readFileSync(png).subarray(1, 4)], [...Buffer.from('PNG')]);
  });

  await t('pdf from markdown', async () => {
    const f = await F.createDocument(botId, { filename: 'memo', format: 'pdf', content: '# Memo\n\nBody' });
    const p = await F.previewOf(botId, f.path);
    assert.equal(p.kind, 'pdf'); assert.equal(p.pages, 1);
  });

  await t('xlsx from csv, previewed as a table', async () => {
    const f = await F.createDocument(botId, { filename: 'budget', format: 'xlsx', content: 'Item,Cost\nRent,1200\n"Food, misc",400\n' });
    const p = await F.previewOf(botId, f.path);
    assert.equal(p.kind, 'sheet'); assert.equal(p.error, undefined, p.error);
    assert.equal(p.sheets.length, 1);
    assert.deepEqual(p.sheets[0].rows.slice(0, 3), [['Item', 'Cost'], ['Rent', '1200'], ['Food, misc', '400']]);
  });

  await t('pptx from markdown slides, previewed as pages', async () => {
    if (!(await F.hasImpress())) { console.log('     (skipped: no Impress here)'); return; }
    const f = await F.createDocument(botId, { filename: 'deck', format: 'pptx', content: '# Plan for <Q3> & more\n\n## Goals\n- Ship **files**\n  - previews\n- Phone parity\n\n---\nPlain *closing* line\n' });
    const p = await F.previewOf(botId, f.path);
    assert.equal(p.error, undefined, p.error);
    assert.equal(p.pages, 3);
  });

  await t('the turn scan finds new files, skips hidden and tool folders', () => {
    fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(root, '.hidden', 'x.md'), 'x');
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'y.js'), 'y');
    const names = F.changedSince(botId, since).map((f) => f.path).sort();
    assert.ok(names.includes('notes.md') && names.includes('reports/Report.docx'), names.join());
    assert.ok(!names.some((n) => n.includes('hidden') || n.includes('node_modules')), names.join());
    assert.deepEqual(F.changedSince(botId, Date.now() + 60_000), []);
  });

  await t('binary text is not shown as text', async () => {
    fs.writeFileSync(path.join(root, 'blob.txt'), Buffer.from([0, 1, 2, 3]));
    const p = await F.previewOf(botId, 'blob.txt');
    assert.equal(p.kind, 'other');
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
