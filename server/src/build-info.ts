import fs from 'node:fs';
import path from 'node:path';

/** Which build this server is: the version in server/package.json and the checked-out commit, read once. */
let build: { version: string; commit: string | null } | null = null;
export function buildInfo(): { version: string; commit: string | null } {
  if (build) return build;
  let version = '0';
  let commit: string | null = null;
  const here = path.dirname(new URL(import.meta.url).pathname);
  try { version = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version ?? '0'; } catch { /* unknown */ }
  try {
    const git = path.join(here, '..', '..', '.git');
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref:')) {
      const ref = head.slice(5).trim();
      try { commit = fs.readFileSync(path.join(git, ref), 'utf8').trim(); }
      catch {
        // A ref that lives only in packed-refs (after `git gc` or a fresh clone).
        const packed = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
        commit = packed ? packed.split(' ')[0] : null;
      }
    } else commit = head;
  } catch { /* not a checkout */ }
  build = { version, commit: commit ? commit.slice(0, 7) : null };
  return build;
}

/** Where the built web app lives (web/dist beside the server). */
export const webDist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'web', 'dist');

let web: { name: string | null; mtimeMs: number } | null = null;
/**
 * The build an open page can compare itself with: the server's commit, and the name of the web app's
 * entry script (it changes whenever the web app does), read again when index.html changes.
 */
export function webBuild(): { commit: string | null; web: string | null } {
  let name: string | null = null;
  try {
    const file = path.join(webDist, 'index.html');
    const mtimeMs = fs.statSync(file).mtimeMs;
    if (!web || web.mtimeMs !== mtimeMs) web = { name: /\/assets\/(index-[\w-]+\.js)/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? null, mtimeMs };
    name = web.name;
  } catch { /* no built web app here */ }
  return { commit: buildInfo().commit, web: name };
}
