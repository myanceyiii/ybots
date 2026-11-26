// Small JSON files in the app's own storage (drafts, unsent messages). Nothing here leaves the phone.
// Every call is best effort: a phone that can't write keeps working, it just forgets on restart.
import { File as FsFile, Paths } from 'expo-file-system';

const fileFor = (name: string) => new FsFile(Paths.document, name);

export async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    const f = fileFor(name);
    if (!f.exists) return fallback;
    return JSON.parse(await f.text()) as T;
  } catch { return fallback; }
}

const queued = new Map<string, ReturnType<typeof setTimeout>>();
/** Writes a moment later, so typing does not write on every letter. */
export function writeJsonSoon(name: string, value: () => unknown, ms = 400) {
  const t = queued.get(name);
  if (t) clearTimeout(t);
  queued.set(name, setTimeout(() => {
    queued.delete(name);
    void (async () => {
      try {
        const f = fileFor(name);
        if (!f.exists) f.create({ intermediates: true });
        await f.write(JSON.stringify(value()));
      } catch { /* storage unavailable */ }
    })();
  }, ms));
}

/** Delete one of these files (and drop a write that was still waiting for it). */
export function removeFile(name: string) {
  const t = queued.get(name);
  if (t) { clearTimeout(t); queued.delete(name); }
  try { const f = fileFor(name); if (f.exists) f.delete(); } catch { /* nothing to delete */ }
}

/** A name safe to use as a file name for one account's data. */
export const accountKey = (account: string) => account.replace(/[^A-Za-z0-9]+/g, '_').slice(-80) || 'none';
