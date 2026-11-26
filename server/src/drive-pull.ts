import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { workspaceRoot } from './files.js';
import { getBotRow } from './store.js';
import { takeHandedSecret, dropSecret } from './browser-cards.js';

/**
 * Google Drive files into a bot's own files on this server (docs/posting.md), so its browser can upload
 * them. Read only: a Google service account the folder is shared with, its key given once on a secure card
 * (the bot never sees it) and kept in data/drive/<bot>.json, mode 600. Downloads run in the background and
 * skip files already here with the same size and MD5.
 */

const root = () => new URL('../../', import.meta.url).pathname;
const keyFile = (botId: string) => path.join(process.env.DRIVE_KEYS_DIR || path.join(root(), 'data', 'drive'), `${botId.replace(/[^\w-]/g, '')}.json`);
const API = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FOLDER = 'application/vnd.google-apps.folder';

interface SaKey { type: string; client_email: string; private_key: string; token_uri?: string }
type Out = { output: string; summary?: string };
export interface Ctx { userId: string; botId: string; chatId?: string }

function readKey(botId: string): SaKey | null {
  try { const k = JSON.parse(fs.readFileSync(keyFile(botId), 'utf8')); return k?.type === 'service_account' ? k : null; } catch { return null; }
}

const tokens = new Map<string, { token: string; until: number }>();
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

async function accessToken(botId: string, key = readKey(botId)): Promise<string> {
  if (!key) throw new Error('No Drive key is set up for you yet. Call ask_drive_key so the person can paste it on a card.');
  const have = tokens.get(botId);
  if (have && have.until > Date.now() + 60_000) return have.token;
  const t = Math.floor(Date.now() / 1000);
  const aud = key.token_uri || 'https://oauth2.googleapis.com/token';
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud, iat: t, exp: t + 3600 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), key.private_key).toString('base64url');
  const r = await fetch(aud, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }), signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!r.ok || !j.access_token) throw new Error(`Google refused the Drive key (${j.error_description || j.error || r.status}).`);
  tokens.set(botId, { token: j.access_token, until: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

// ------------------------------------------------------------------ the key, on a secure card

export async function askDriveKey(a: any, ctx: Ctx): Promise<Out> {
  const bot = getBotRow(ctx.botId);
  const { requestApproval } = await import('./agent/loop.js');
  const meta: { approvalId?: string } = {};
  const why = String(a?.why ?? '').trim().slice(0, 200);
  const answer = await requestApproval(
    { userId: ctx.userId, botId: ctx.chatId ?? ctx.botId },
    {
      decision: 'ask', key: 'secure_input', title: 'secure_input: Google Drive key', asks: [], detail: '',
      browser: {
        title: `${bot?.name ?? 'The bot'} needs a Google Drive key to read your video files`,
        secret: { kind: 'service_key', kindLabel: 'Service account key (JSON)', origin: '', site: 'Google Drive (read only)', fieldLabel: 'Paste the whole JSON key file', why, masked: true, numeric: false },
      },
    },
    { field: 'service_key', for: 'google-drive-readonly' }, null, meta,
  );
  if (answer !== 'allow' || !meta.approvalId) {
    if (meta.approvalId) dropSecret(meta.approvalId);
    return { output: answer === 'deny' ? 'The person chose not to give the key.' : 'Nobody answered the card in time.', summary: 'Not given' };
  }
  let value = takeHandedSecret(meta.approvalId) ?? '';
  let key: SaKey | null = null;
  try { const k = JSON.parse(value); if (k?.type === 'service_account' && k.client_email && k.private_key) key = { type: k.type, client_email: k.client_email, private_key: k.private_key, token_uri: k.token_uri }; } catch { /* not JSON */ }
  value = '';
  if (!key) return { output: 'What was pasted is not a Google service account key (a JSON file with "type": "service_account"). Nothing was saved. Ask again if the person wants to.', summary: 'failed' };
  try { tokens.delete(ctx.botId); await accessToken(ctx.botId, key); } catch (e) { return { output: `${(e as Error).message} Nothing was saved.`, summary: 'failed' }; }
  const f = keyFile(ctx.botId);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(key), { mode: 0o600 });
  fs.renameSync(tmp, f);
  key = null;
  return { output: `Saved. The key works (read only). Its account is ${readKey(ctx.botId)?.client_email}: Drive folders must be shared with that address. You never see the key itself. Use drive_pull to copy files.`, summary: 'Key saved' };
}

// ------------------------------------------------------------------ pulling files

interface Job { id: string; botId: string; into: string; started: number; done: number; skipped: number; failed: string[]; bytes: number; total: number; files: number; state: 'listing' | 'downloading' | 'finished' | 'failed'; error?: string; current?: string; finished?: number }
const jobs = new Map<string, Job>();

const idOf = (s: string) => (/\/folders\/([\w-]{10,})/.exec(s)?.[1] ?? /[?&]id=([\w-]{10,})/.exec(s)?.[1] ?? /\/d\/([\w-]{10,})/.exec(s)?.[1] ?? (/^[\w-]{10,}$/.test(s) ? s : ''));

async function api(botId: string, url: string): Promise<any> {
  const r = await fetch(url, { headers: { authorization: `Bearer ${await accessToken(botId)}` }, signal: AbortSignal.timeout(30_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 404 ? 'Not found, or not shared with the Drive key\'s account.' : `Drive said ${r.status}: ${(j as any)?.error?.message ?? ''}`);
  return j;
}

interface Entry { id: string; name: string; mimeType: string; size?: string; md5Checksum?: string; rel: string }

async function list(botId: string, folder: string, rel: string, out: Entry[], match: RegExp | null, depth = 0): Promise<void> {
  if (depth > 8 || out.length > 5000) return;
  let page = '';
  do {
    const q = encodeURIComponent(`'${folder}' in parents and trashed=false`);
    const j = await api(botId, `${API}/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,size,md5Checksum)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${page ? `&pageToken=${page}` : ''}`);
    for (const f of j.files ?? []) {
      const name = String(f.name).replace(/[\/\\\0]/g, '_').slice(0, 200);
      if (f.mimeType === FOLDER) await list(botId, f.id, path.join(rel, name), out, match, depth + 1);
      else if (!String(f.mimeType).startsWith('application/vnd.google-apps.') && (!match || match.test(path.join(rel, name)))) out.push({ ...f, name, rel: path.join(rel, name) });
    }
    page = j.nextPageToken ?? '';
  } while (page);
}

async function md5(file: string): Promise<string> {
  return new Promise((resolve, reject) => { const h = crypto.createHash('md5'); fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))); });
}

async function run(job: Job, target: { folder?: string; file?: string }, match: RegExp | null, maxBytes: number) {
  const dest = path.join(workspaceRoot(job.botId), job.into);
  try {
    const entries: Entry[] = [];
    if (target.file) { const f = await api(job.botId, `${API}/files/${target.file}?fields=id,name,mimeType,size,md5Checksum&supportsAllDrives=true`); entries.push({ ...f, rel: String(f.name).replace(/[\/\\\0]/g, '_') }); }
    else await list(job.botId, target.folder!, '', entries, match);
    job.files = entries.length;
    job.total = entries.reduce((n, e) => n + Number(e.size ?? 0), 0);
    if (job.total > maxBytes) throw new Error(`That is ${(job.total / 1e9).toFixed(1)} GB, over the ${(maxBytes / 1e9).toFixed(1)} GB limit for one pull. Narrow it with match or raise max_gb.`);
    job.state = 'downloading';
    for (const e of entries) {
      const file = path.join(dest, e.rel);
      if (!file.startsWith(dest + path.sep)) { job.failed.push(`${e.rel}: bad name`); continue; }
      job.current = e.rel;
      try {
        if (fs.existsSync(file) && fs.statSync(file).size === Number(e.size ?? -1) && (!e.md5Checksum || await md5(file) === e.md5Checksum)) { job.skipped++; job.bytes += Number(e.size ?? 0); continue; }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const r = await fetch(`${API}/files/${e.id}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${await accessToken(job.botId)}` } });
        if (!r.ok || !r.body) throw new Error(`Drive said ${r.status}`);
        const tmp = `${file}.part`;
        const h = crypto.createHash('md5');
        const src = Readable.fromWeb(r.body as any);
        src.on('data', (c: Buffer) => { h.update(c); job.bytes += c.length; });
        await pipeline(src, fs.createWriteStream(tmp));
        if (e.md5Checksum && h.digest('hex') !== e.md5Checksum) { fs.rmSync(tmp, { force: true }); throw new Error('checksum did not match'); }
        fs.renameSync(tmp, file);
        job.done++;
      } catch (err) { job.failed.push(`${e.rel}: ${(err as Error).message}`.slice(0, 200)); }
    }
    job.state = 'finished';
  } catch (err) {
    job.state = 'failed'; job.error = (err as Error).message;
  }
  job.current = undefined; job.finished = Date.now();
}

export async function drivePull(a: any, ctx: Ctx): Promise<Out> {
  if (!readKey(ctx.botId)) return { output: 'No Drive key is set up for you yet. Call ask_drive_key first.', summary: 'failed' };
  const folder = idOf(String(a?.folder ?? ''));
  const file = idOf(String(a?.file ?? ''));
  if (!folder && !file) return { output: 'Give a Drive folder (its link or id) or a single file.', summary: 'failed' };
  const into = String(a?.into ?? 'drive').replace(/^\/+/, '').replace(/\.\.+/g, '').slice(0, 120) || 'drive';
  let match: RegExp | null = null;
  try { match = a?.match ? new RegExp(String(a.match).slice(0, 200), 'i') : null; } catch { return { output: 'match is not a valid pattern.', summary: 'failed' }; }
  const maxBytes = Math.min(Math.max(Number(a?.max_gb) || 8, 0.1), 40) * 1e9;
  if ([...jobs.values()].some((j) => j.botId === ctx.botId && (j.state === 'listing' || j.state === 'downloading'))) return { output: 'A pull is already running; check it with drive_pull_status.', summary: 'busy' };
  const job: Job = { id: `drv_${Date.now().toString(36)}`, botId: ctx.botId, into, started: Date.now(), done: 0, skipped: 0, failed: [], bytes: 0, total: 0, files: 0, state: 'listing' };
  jobs.set(job.id, job);
  void run(job, { folder: folder || undefined, file: file || undefined }, match, maxBytes);
  return { output: `Started copying into your files under ${into}/ (job ${job.id}). It runs in the background; check with drive_pull_status. Files already here with the same size and checksum are skipped.`, summary: 'Started' };
}

export function drivePullStatus(_a: any, ctx: Ctx): Out {
  const mine = [...jobs.values()].filter((j) => j.botId === ctx.botId).slice(-3);
  if (!mine.length) return { output: 'No Drive pulls since the app last started.', summary: 'none' };
  const gb = (n: number) => `${(n / 1e9).toFixed(2)} GB`;
  return {
    output: mine.map((j) => `${j.id} into ${j.into}/: ${j.state}${j.error ? ` (${j.error})` : ''}; ${j.done} copied, ${j.skipped} already here, ${j.failed.length} failed of ${j.files} files; ${gb(j.bytes)} of ${gb(j.total)}${j.current ? `; now ${j.current}` : ''}${j.failed.length ? `\nFailed: ${j.failed.slice(0, 10).join('; ')}` : ''}`).join('\n'),
    summary: mine[mine.length - 1].state,
  };
}
