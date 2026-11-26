import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { env } from './env.js';
import { libraryRoot } from './paths.js';
import type { ChatFile, FileKind, FilePreview } from './types.js';

/**
 * The bot's workspace (its Library folder on the computer) as the apps' file pane sees it:
 * which kind of file something is, previews made on this machine, safe paths, and the files a turn made.
 *
 * Everything is converted here with LibreOffice (headless) and poppler's pdftoppm/pdfinfo; no document
 * is sent anywhere. Office files become a PDF once (cached by path, size and time), and each page is
 * drawn as a PNG on request, so the web, Windows and Android apps all show the same pictures.
 */

export const workspaceRoot = (botId: string) => `${libraryRoot()}/${botId}`;

const EXT: Record<string, FileKind> = {
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  txt: 'text', log: 'text', text: 'text', rtf: 'office',
  csv: 'table', tsv: 'table',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  pdf: 'pdf',
  doc: 'office', docx: 'office', odt: 'office', ppt: 'office', pptx: 'office', odp: 'office',
  xls: 'sheet', xlsx: 'sheet', ods: 'sheet', xlsm: 'sheet',
};
const CODE = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'json', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'htm', 'css', 'scss', 'sql', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'rb', 'php', 'swift', 'ps1', 'svg', 'env', 'conf', 'cfg']);

export function fileKind(name: string): FileKind {
  if (name.toLowerCase().endsWith('.page.json')) return 'page';
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (!name.includes('.')) return 'text';
  return EXT[ext] ?? (CODE.has(ext) ? 'code' : 'other');
}
export const editable = (k: FileKind) => k === 'markdown' || k === 'text' || k === 'code' || k === 'table';
const extOf = (name: string) => (name.includes('.') ? name.toLowerCase().split('.').pop()! : '');

/** A workspace-relative path with no tricks in it, or null. '' is the workspace itself. */
export function safeRel(p: string | undefined): string | null {
  const rel = (p ?? '').replace(/^\/+|\/+$/g, '');
  if (!rel) return '';
  if (rel.length > 1024 || rel.split('/').some((s) => !s || s === '.' || s === '..') || /[\0\n\r]/.test(rel)) return null;
  return rel;
}

/** The real path of an existing file inside the bot's workspace; links are followed before the check. */
export function insideFile(botId: string, rel: string): string | null {
  try {
    const root = fs.realpathSync(workspaceRoot(botId));
    const file = fs.realpathSync(path.join(root, rel));
    if (!file.startsWith(root + '/') || !fs.statSync(file).isFile()) return null;
    return file;
  } catch { return null; }
}

/** Where a new or changed file may be written: its folder must already resolve inside the workspace. */
export function insideTarget(botId: string, rel: string): string | null {
  try {
    const rootPath = workspaceRoot(botId);
    fs.mkdirSync(rootPath, { recursive: true });
    const root = fs.realpathSync(rootPath);
    const dir = path.dirname(path.join(root, rel));
    fs.mkdirSync(dir, { recursive: true });
    const realDir = fs.realpathSync(dir);
    if (realDir !== root && !realDir.startsWith(root + '/')) return null;
    const target = path.join(realDir, path.basename(rel));
    if (fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isFile())) return null;
    return target;
  } catch { return null; }
}

export const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  pdf: 'application/pdf',
};
export const mimeFor = (name: string) => MIME[extOf(name)] ?? 'application/octet-stream';

// ---------- running the converters ----------

const cacheDir = () => path.join(path.dirname(env.dbPath), 'previews');

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: cacheDir() } }); }
    catch (e) { resolve({ code: -1, out: String(e) }); return; }
    const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 20000) out += d; });
    child.stderr.on('data', (d) => { if (out.length < 20000) out += d; });
    child.on('error', (e) => { clearTimeout(kill); resolve({ code: -1, out: String(e) }); });
    child.on('close', (code) => { clearTimeout(kill); resolve({ code: code ?? -1, out }); });
  });
}

// LibreOffice runs one conversion at a time with its own profile, apart from the bots' desktops.
let officeChain: Promise<unknown> = Promise.resolve();
function office<T>(job: () => Promise<T>): Promise<T> {
  const next = officeChain.then(job, job);
  officeChain = next.catch(() => undefined);
  return next;
}

async function soffice(args: string[], outDir: string): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  const profile = `file://${path.join(cacheDir(), 'lo-profile')}`;
  const r = await office(() => run('soffice', [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--nolockcheck', ...args, '--outdir', outDir], 120_000));
  if (r.code !== 0) throw new Error(`LibreOffice could not convert it (${r.out.trim().slice(-200) || `exit ${r.code}`})`);
  return r.out;
}

export async function hasImpress(): Promise<boolean> {
  return ['/usr/lib/libreoffice/program/libsdlo.so', '/opt/libreoffice/program/libsdlo.so'].some((f) => fs.existsSync(f));
}

function cacheKey(file: string): string {
  const st = fs.statSync(file);
  return crypto.createHash('sha256').update(`${file}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 32);
}

/** Conversions running now, by cache key: a second preview of the same file waits for the first. */
const converting = new Map<string, Promise<string>>();

/** The file as a PDF: itself, or a cached LibreOffice conversion. */
async function asPdf(file: string): Promise<string> {
  if (extOf(file) === 'pdf') return file;
  const key = cacheKey(file);
  const running = converting.get(key);
  if (running) return running;
  const job = asPdfOnce(file, key).finally(() => converting.delete(key));
  converting.set(key, job);
  return job;
}

async function asPdfOnce(file: string, key: string): Promise<string> {
  if (['ppt', 'pptx', 'odp'].includes(extOf(file)) && !(await hasImpress())) throw new Error('Slides can’t be previewed on this server yet (LibreOffice Impress is not installed). Download it to open it.');
  const out = path.join(cacheDir(), key);
  const pdf = path.join(out, 'doc.pdf');
  if (fs.existsSync(pdf)) return pdf;
  const work = path.join(out, 'work');
  fs.mkdirSync(work, { recursive: true });
  // Copy it under a plain name first, so odd file names never reach the command line.
  const src = path.join(work, `in.${extOf(file) || 'bin'}`);
  fs.copyFileSync(file, src);
  await soffice(['--convert-to', 'pdf', src], work);
  const made = path.join(work, 'in.pdf');
  if (!fs.existsSync(made)) throw new Error('LibreOffice made no PDF');
  fs.renameSync(made, pdf);
  fs.rmSync(work, { recursive: true, force: true });
  return pdf;
}

async function pageCount(pdf: string): Promise<number> {
  const r = await run('pdfinfo', [pdf], 30_000);
  const m = r.out.match(/^Pages:\s+(\d+)/m);
  if (!m) throw new Error('Could not read the PDF');
  return Number(m[1]);
}

/** One page of a PDF or office file as a PNG (cached). `n` counts from 1. */
export async function pagePng(file: string, n: number): Promise<string> {
  const pdf = await asPdf(file);
  const dir = path.join(cacheDir(), cacheKey(file));
  fs.mkdirSync(dir, { recursive: true });
  const png = path.join(dir, `p${n}.png`);
  if (fs.existsSync(png)) return png;
  const base = path.join(dir, `p${n}`);
  const r = await run('pdftoppm', ['-png', '-r', '110', '-scale-to', '1600', '-f', String(n), '-l', String(n), '-singlefile', pdf, base], 60_000);
  if (r.code !== 0 || !fs.existsSync(png)) throw new Error('Could not draw that page');
  return png;
}

// ---------- tables ----------

export function parseCsv(text: string, sep = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
      if (rows.length >= 2000) return rows;
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const MAX_ROWS = 500;
const MAX_COLS = 40;
const clip = (rows: string[][]) => ({
  rows: rows.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS).map((c) => c.slice(0, 500))),
  truncated: rows.length > MAX_ROWS || rows.some((r) => r.length > MAX_COLS),
});

async function sheetsOf(file: string): Promise<{ name: string; rows: string[][]; truncated: boolean }[]> {
  const dir = path.join(cacheDir(), cacheKey(file), 'sheets');
  if (!fs.existsSync(dir) || !fs.readdirSync(dir).some((f) => f.endsWith('.csv'))) {
    const work = path.join(cacheDir(), cacheKey(file), 'sheet-work');
    fs.mkdirSync(work, { recursive: true });
    const src = path.join(work, `book.${extOf(file)}`);
    fs.copyFileSync(file, src);
    // Token 12 = -1 writes every sheet to its own file, "book-<sheet name>.csv" (LibreOffice 7.2+).
    await soffice(['--convert-to', 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1', src], dir);
    fs.rmSync(work, { recursive: true, force: true });
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.csv'));
  // The sheet order is not in the file names; the converter writes them in order, so sort by time.
  files.sort((a, b) => fs.statSync(path.join(dir, a)).mtimeMs - fs.statSync(path.join(dir, b)).mtimeMs);
  return files.slice(0, 20).map((f) => ({ name: f.replace(/^book-/, '').replace(/\.csv$/, ''), ...clip(parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'))) }));
}

// ---------- the preview ----------

const TEXT_LIMIT = 1_000_000;

export async function previewOf(botId: string, rel: string): Promise<FilePreview> {
  const file = insideFile(botId, rel);
  if (!file) throw Object.assign(new Error('not found'), { status: 404 });
  const st = fs.statSync(file);
  const name = path.basename(rel);
  const kind = fileKind(name);
  const base = { path: rel, name, size: st.size, modifiedAt: st.mtimeMs, kind, editable: editable(kind) && st.size <= TEXT_LIMIT };
  const readText = () => {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(st.size, TEXT_LIMIT));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.toString('utf8');
  };
  const looksBinary = () => { const t = readText().slice(0, 4000); return t.includes('\0'); };
  switch (kind) {
    case 'markdown': case 'text': case 'code':
      if (looksBinary()) return { ...base, kind: 'other', editable: false };
      return { ...base, text: readText(), truncated: st.size > TEXT_LIMIT, lang: extOf(name) || undefined };
    case 'table': {
      const text = readText();
      return { ...base, text, sheets: [{ name, ...clip(parseCsv(text, extOf(name) === 'tsv' ? '\t' : ',')) }], truncated: st.size > TEXT_LIMIT };
    }
    case 'image':
      return base;
    case 'pdf': case 'office':
      try { return { ...base, pages: await pageCount(await asPdf(file)) }; }
      catch (e) { return { ...base, error: (e as Error).message }; }
    case 'sheet':
      try { return { ...base, sheets: await sheetsOf(file) }; }
      catch (e) { return { ...base, error: (e as Error).message }; }
    default:
      return base;
  }
}

export function saveText(botId: string, rel: string, text: string, baseModifiedAt?: number): ChatFile {
  if (!editable(fileKind(rel))) throw Object.assign(new Error('Only text files can be edited here'), { status: 400 });
  if (Buffer.byteLength(text) > TEXT_LIMIT) throw Object.assign(new Error('Too big to save here'), { status: 413 });
  const target = insideTarget(botId, rel);
  if (!target) throw Object.assign(new Error('bad path'), { status: 400 });
  if (baseModifiedAt && fs.existsSync(target) && Math.abs(fs.statSync(target).mtimeMs - baseModifiedAt) > 1) {
    throw Object.assign(new Error('The file changed since you opened it. Reload it and try again.'), { status: 409 });
  }
  const tmp = `${target}.cleft-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
  return describe(botId, rel)!;
}

export function describe(botId: string, rel: string): ChatFile | null {
  const file = insideFile(botId, rel);
  if (!file) return null;
  const st = fs.statSync(file);
  const name = path.basename(rel);
  return { path: rel, name, size: st.size, modifiedAt: st.mtimeMs, kind: fileKind(name) };
}

// ---------- files a turn made ----------

const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', '.venv', '.git', '.cache', 'site-packages', 'dist', 'build']);

/** Files in the workspace written at or after `since` (newest first), skipping hidden and tool folders. */
export function changedSince(botId: string, since: number, limit = 12): ChatFile[] {
  const root = workspaceRoot(botId);
  if (!fs.existsSync(root)) return [];
  const found: ChatFile[] = [];
  let seen = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 4 || seen > 5000) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      // The budget is shared by the whole walk, so one huge flat folder can't stall the server either.
      if (++seen > 5000) return;
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r, depth + 1); continue; }
      if (!e.isFile() || e.name.endsWith('.tmp')) continue;
      try {
        const st = fs.statSync(path.join(dir, e.name));
        if (st.mtimeMs >= since) found.push({ path: r, name: e.name, size: st.size, modifiedAt: st.mtimeMs, kind: fileKind(e.name) });
      } catch { /* gone meanwhile */ }
    }
  };
  walk(root, '', 0);
  return found.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limit);
}

// ---------- making documents (the create_document tool) ----------

export const DOC_FORMATS = ['md', 'txt', 'csv', 'html', 'docx', 'odt', 'pdf', 'xlsx', 'ods', 'pptx', 'odp'] as const;
export type DocFormat = (typeof DOC_FORMATS)[number];

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** **bold** and *italic* inside one line of slide text. */
function spans(s: string): string {
  return xml(s.replace(/`([^`]+)`/g, '$1'))
    .replace(/\*\*([^*]+)\*\*/g, '<text:span text:style-name="B">$1</text:span>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<text:span text:style-name="I">$2</text:span>');
}

/**
 * Slides from markdown: a line of `---` or a `#`/`##` heading starts a slide; the heading is its title;
 * `-`/`*`/`1.` lines are bullets (indent for a second level); other lines are plain paragraphs.
 * Written as a flat OpenDocument presentation for LibreOffice Impress to turn into .pptx.
 */
export function slidesFodp(markdown: string): string {
  type Slide = { title: string; lines: { text: string; level: number; bullet: boolean }[] };
  const slides: Slide[] = [];
  let cur: Slide | null = null;
  const start = (title = '') => { cur = { title, lines: [] }; slides.push(cur); };
  for (const raw of markdown.replace(/\r/g, '').split('\n')) {
    if (/^\s*---+\s*$/.test(raw)) { start(); continue; }
    const h = raw.match(/^#{1,2}\s+(.*)$/);
    if (h) { if (!cur || (cur as Slide).title || (cur as Slide).lines.length) start(h[1].trim()); else (cur as Slide).title = h[1].trim(); continue; }
    if (!raw.trim()) continue;
    if (!cur) start();
    const b = raw.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
    const h3 = raw.match(/^#{3,6}\s+(.*)$/);
    (cur as unknown as Slide).lines.push(b ? { text: b[2], level: Math.min(2, Math.floor(b[1].replace(/\t/g, '  ').length / 2)), bullet: true } : { text: h3 ? h3[1] : raw.trim(), level: 0, bullet: false });
  }
  const real = slides.filter((s) => s.title || s.lines.length);
  if (!real.length) real.push({ title: '', lines: [] });
  const page = (s: Slide, i: number) => {
    const body = s.lines.map((l) => l.bullet
      ? `<text:list text:style-name="L1">${'<text:list-item><text:list>'.repeat(l.level)}<text:list-item><text:p text:style-name="P${l.level ? 2 : 1}">${spans(l.text)}</text:p></text:list-item>${'</text:list></text:list-item>'.repeat(l.level)}</text:list>`
      : `<text:p text:style-name="P0">${spans(l.text)}</text:p>`).join('');
    const titleOnly = !s.lines.length;
    return `<draw:page draw:name="Slide ${i + 1}" draw:master-page-name="M" draw:style-name="dp1">`
      + (s.title ? `<draw:frame draw:style-name="gr1" svg:x="1.5cm" svg:y="${titleOnly ? '5.5cm' : '0.9cm'}" svg:width="25cm" svg:height="${titleOnly ? '4cm' : '2.6cm'}"><draw:text-box><text:p text:style-name="${titleOnly ? 'TC' : 'T'}">${spans(s.title)}</text:p></draw:text-box></draw:frame>` : '')
      + (body ? `<draw:frame draw:style-name="gr1" svg:x="1.5cm" svg:y="${s.title ? '3.8cm' : '1.2cm'}" svg:width="25cm" svg:height="${s.title ? '11cm' : '13.5cm'}"><draw:text-box>${body}</draw:text-box></draw:frame>` : '')
      + '</draw:page>';
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation">
<office:styles>
<style:style style:name="standard" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none"/><style:text-properties fo:font-family="Liberation Sans" fo:color="#1f2328"/></style:style>
</office:styles>
<office:automatic-styles>
<style:page-layout style:name="PL"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm" fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm" style:print-orientation="landscape"/></style:page-layout>
<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="#ffffff"/></style:style>
<style:style style:name="gr1" style:family="graphic" style:parent-style-name="standard"><style:graphic-properties draw:stroke="none" draw:fill="none" draw:textarea-vertical-align="top" draw:auto-grow-height="false" fo:padding="0.1cm"/></style:style>
<style:style style:name="T" style:family="paragraph"><style:text-properties fo:font-size="32pt" fo:font-weight="bold" fo:color="#1f2328"/></style:style>
<style:style style:name="TC" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="40pt" fo:font-weight="bold" fo:color="#1f2328"/></style:style>
<style:style style:name="P0" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.25cm"/><style:text-properties fo:font-size="20pt"/></style:style>
<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.25cm"/><style:text-properties fo:font-size="20pt"/></style:style>
<style:style style:name="P2" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.15cm"/><style:text-properties fo:font-size="17pt"/></style:style>
<style:style style:name="B" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="I" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
<text:list-style style:name="L1">
<text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:space-before="0.2cm" text:min-label-width="0.8cm"/></text:list-level-style-bullet>
<text:list-level-style-bullet text:level="2" text:bullet-char="–"><style:list-level-properties text:space-before="1.2cm" text:min-label-width="0.8cm"/></text:list-level-style-bullet>
<text:list-level-style-bullet text:level="3" text:bullet-char="·"><style:list-level-properties text:space-before="2.2cm" text:min-label-width="0.8cm"/></text:list-level-style-bullet>
</text:list-style>
</office:automatic-styles>
<office:master-styles><style:master-page style:name="M" style:page-layout-name="PL" draw:style-name="dp1"/></office:master-styles>
<office:body><office:presentation>${real.map(page).join('')}</office:presentation></office:body>
</office:document>`;
}

/**
 * `rel`, or the first of "name (2).ext", "name (3).ext"… that is not taken yet: an export never writes
 * over a document that is already there (it may have been edited on its own since).
 */
export function freeName(botId: string, rel: string): string {
  const root = workspaceRoot(botId);
  if (!fs.existsSync(path.join(root, rel))) return rel;
  const dot = rel.lastIndexOf('.');
  const [stem, ext] = dot > rel.lastIndexOf('/') ? [rel.slice(0, dot), rel.slice(dot)] : [rel, ''];
  for (let i = 2; i < 1000; i++) {
    const next = `${stem} (${i})${ext}`;
    if (!fs.existsSync(path.join(root, next))) return next;
  }
  throw new Error('Too many copies with that name already; rename or delete some first.');
}

/** Write a document into the bot's workspace. Returns the workspace-relative path. */
export async function createDocument(botId: string, a: { filename: string; format: DocFormat; content: string; folder?: string; keepExisting?: boolean }): Promise<ChatFile> {
  const format = a.format;
  if (!DOC_FORMATS.includes(format)) throw new Error(`format must be one of ${DOC_FORMATS.join(', ')}`);
  const stem = String(a.filename ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^\p{L}\p{N} ._()-]/gu, '_').trim().slice(0, 100) || 'document';
  const folder = a.folder ? safeRel(String(a.folder)) : '';
  if (folder === null) throw new Error('folder must be a plain path inside your workspace');
  const wanted = `${folder ? `${folder}/` : ''}${stem}.${format}`;
  const rel = a.keepExisting ? freeName(botId, wanted) : wanted;
  const target = insideTarget(botId, rel);
  if (!target) throw new Error('That path is outside your workspace');
  const content = String(a.content ?? '');
  if (['md', 'txt', 'csv', 'html'].includes(format)) {
    fs.writeFileSync(target, content);
    return describe(botId, rel)!;
  }
  if (['pptx', 'odp'].includes(format) && !(await hasImpress())) throw new Error('Making slides needs LibreOffice Impress, which is not installed on this server yet. Make a .pdf or .docx instead, or ask the owner to install it.');
  const work = path.join(cacheDir(), 'make', crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(work, { recursive: true });
  try {
    let src: string;
    let args: string[];
    if (format === 'xlsx' || format === 'ods') {
      src = path.join(work, 'doc.csv');
      fs.writeFileSync(src, content);
      args = ['--infilter=CSV:44,34,76,1', '--convert-to', format, src];
    } else if (format === 'pptx' || format === 'odp') {
      src = path.join(work, 'doc.fodp');
      fs.writeFileSync(src, slidesFodp(content));
      args = ['--convert-to', format === 'pptx' ? 'pptx:Impress Office Open XML' : 'odp', src];
    } else {
      // LibreOffice 26.2 reads markdown itself (checked on Host2): headings, bold, lists and tables carry over.
      src = path.join(work, 'doc.md');
      fs.writeFileSync(src, content);
      args = ['--convert-to', format, src];
    }
    await soffice(args, work);
    const made = path.join(work, `doc.${format}`);
    if (!fs.existsSync(made)) throw new Error('LibreOffice made no file');
    fs.copyFileSync(made, target);
    return describe(botId, rel)!;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * An HTML copy turned into Word, OpenDocument or PDF by LibreOffice on this machine (Page exports).
 * `assets` are files the HTML points at by plain name (chart pictures); they sit beside it while converting.
 */
export async function htmlToOffice(botId: string, rel: string, html: string, format: 'docx' | 'odt' | 'pdf', assets: { name: string; data: string }[] = []): Promise<ChatFile> {
  const target = insideTarget(botId, rel);
  if (!target) throw new Error('That path is outside your workspace');
  const work = path.join(cacheDir(), 'make', crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(work, { recursive: true });
  try {
    for (const a of assets) if (/^[\w.-]{1,60}$/.test(a.name)) fs.writeFileSync(path.join(work, a.name), a.data);
    const src = path.join(work, 'doc.html');
    fs.writeFileSync(src, html);
    const filter = format === 'docx' ? 'docx:MS Word 2007 XML' : format === 'odt' ? 'odt:writer8' : 'pdf:writer_pdf_Export';
    await soffice(['--infilter=HTML (StarWriter)', '--convert-to', filter, src], work);
    const made = path.join(work, `doc.${format}`);
    if (!fs.existsSync(made)) throw new Error('LibreOffice made no file');
    fs.copyFileSync(made, target);
    return describe(botId, rel)!;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------- reading a file's words (attachments, the read_file tool) ----------

/** The words of one file, as plain text, for a bot to read. */
export interface FileText {
  /** The words, from `offset`, at most `max` characters. Empty for a picture or a file with no words. */
  text: string;
  /** Characters in the whole text (to read the rest with a larger offset). */
  total: number;
  /** Why there are no words, when there are none: a picture, an unknown kind, or a failed conversion. */
  note?: string;
}

const fullTexts = new Map<string, Promise<string>>();

/** The whole text of a file (cached by path, size and time): poppler for PDFs, LibreOffice for office files. */
async function wholeText(file: string, kind: FileKind): Promise<string> {
  const key = cacheKey(file);
  const cached = path.join(cacheDir(), key, 'words.txt');
  if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
  const running = fullTexts.get(key);
  if (running) return running;
  const job = (async () => {
    let text: string;
    if (kind === 'sheet') {
      text = (await sheetsOf(file)).map((s) => `## Sheet: ${s.name}${s.truncated ? ' (first 500 rows)' : ''}\n${s.rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n')}`).join('\n\n');
    } else {
      const pdf = await asPdf(file);
      const out = path.join(cacheDir(), key, 'words-work.txt');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const r = await run('pdftotext', ['-layout', '-enc', 'UTF-8', pdf, out], 90_000);
      if (r.code !== 0 || !fs.existsSync(out)) throw new Error('Could not read the words in it');
      text = fs.readFileSync(out, 'utf8').replace(/\f/g, '\n\n--- next page ---\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n');
      fs.rmSync(out, { force: true });
    }
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, text);
    return text;
  })().finally(() => fullTexts.delete(key));
  fullTexts.set(key, job);
  return job;
}

/**
 * The words of a file in a workspace (`ownerId` is a bot or a group), from `offset`, at most `max`
 * characters. Text files are read as they are; PDFs, Word, PowerPoint and Excel files are converted on
 * this machine. Never throws for a file that exists: a failure comes back as `note`.
 */
export async function fileText(ownerId: string, rel: string, offset = 0, max = 40_000): Promise<FileText> {
  const file = insideFile(ownerId, rel);
  if (!file) throw Object.assign(new Error('That file is not there.'), { status: 404 });
  const kind = fileKind(path.basename(rel));
  const st = fs.statSync(file);
  const slice = (t: string) => ({ text: t.slice(offset, offset + max), total: t.length });
  if (kind === 'image') return { text: '', total: 0, note: 'It is a picture, so it has no words. Pictures attached to a message are shown to you in that message.' };
  if (kind === 'markdown' || kind === 'text' || kind === 'code' || kind === 'table' || kind === 'page') {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(st.size, TEXT_LIMIT));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (buf.subarray(0, 4000).includes(0)) return { text: '', total: 0, note: 'It is not a text file, so it has no words to read.' };
    return slice(buf.toString('utf8'));
  }
  if (kind === 'pdf' || kind === 'office' || kind === 'sheet') {
    try { return slice(await wholeText(file, kind)); }
    catch (e) { return { text: '', total: 0, note: `Its words could not be read here (${(e as Error).message}).` }; }
  }
  return { text: '', total: 0, note: 'This kind of file has no words the server can read. Use your own tools on its full path if you need it.' };
}
