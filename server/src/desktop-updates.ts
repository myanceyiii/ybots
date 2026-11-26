import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { requireUser, type AuthVars } from './lib/auth.js';

/**
 * Updates for the Windows app, served from this server so the app never has to reach GitHub (the
 * repository is private) and only signed-in people can fetch them.
 *
 * The build server puts two files in DESKTOP_UPDATES_DIR (data/desktop-updates by default) when it
 * publishes a release (scripts/release-windows.sh): the zip, and latest.json describing it:
 *   { version, file, size, sha256, sig, notes, publishedAt }
 * `sig` is an Ed25519 signature made with a key that lives only on the build server. The Windows app
 * checks the size, the SHA-256 and that signature before it uses anything, so this server (or anyone
 * who got into it) cannot hand a PC a program the build server did not make. The server itself only
 * checks the manifest's shape and never runs the file.
 *
 * Mounted at /api in index.ts.
 */
export const desktopUpdatesApi = new Hono<AuthVars>();
desktopUpdatesApi.use('/desktop/*', requireUser);

export const updatesDir = () => process.env.DESKTOP_UPDATES_DIR || new URL('../../data/desktop-updates', import.meta.url).pathname;

export type DesktopManifest = { version: string; file: string; size: number; sha256: string; sig: string; notes: string; publishedAt: number };

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
// Installed copies before 0.12 accept only the old "yanceybot-" name, so releases keep it for the in-app update file.
const FILE = /^(?:yanceybot|ybots)-windows-(\d{1,4}\.\d{1,4}\.\d{1,4})\.zip$/;

/** The manifest when it is well formed and names a zip that is really there with the size it says, else null. */
export function readManifest(dir = updatesDir()): DesktopManifest | null {
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const { version, file, size, sha256, sig } = raw;
  if (typeof version !== 'string' || !VERSION.test(version)) return null;
  const m = typeof file === 'string' ? FILE.exec(file) : null;
  if (!m || m[1] !== version) return null;
  if (!Number.isSafeInteger(size) || size <= 0 || size > 1024 ** 3) return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof sig !== 'string' || !/^[A-Za-z0-9+/=]{80,120}$/.test(sig)) return null;
  try { if (fs.statSync(path.join(dir, file)).size !== size) return null; } catch { return null; }
  return {
    version, file, size, sha256, sig,
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 4000) : '',
    publishedAt: Number.isFinite(raw.publishedAt) ? Number(raw.publishedAt) : 0,
  };
}

/** What the app asks on a timer: the newest Windows version this server has, or `{ version: null }`. */
desktopUpdatesApi.get('/desktop/latest', (c) => {
  c.header('cache-control', 'private, no-store');
  return c.json(readManifest() ?? { version: null });
});

/** The zip itself. Only ever the one file the manifest names. */
desktopUpdatesApi.get('/desktop/download/:file', (c) => {
  const m = readManifest();
  if (!m || c.req.param('file') !== m.file) return c.json({ error: 'not found' }, 404);
  const file = path.join(updatesDir(), m.file);
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(m.size),
      'content-disposition': `attachment; filename="${m.file}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
});
