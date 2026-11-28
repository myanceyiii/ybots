import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stagingDir, type PluginManifest } from './store.js';
import { validateSettingsSpec } from './ui-schema.js';

/**
 * Getting a plugin package onto this machine and checking it, before the owner is asked.
 *
 *  - From npm: the spec must be `name@exact-version`. `npm pack --ignore-scripts` fetches the
 *    tarball; nothing in it runs.
 *  - From a local tarball (`file:/abs/path.tgz`): only when PLUGINS_ALLOW_LOCAL_TARBALLS=1. The AI
 *    plugin builder (builder.ts) hands its drafts over this way.
 *
 * The package is unpacked into its own staging folder and refused when it has links, install
 * scripts, native build files, or dependencies without an npm-shrinkwrap.json that pins them. The
 * tree digest (sha256 over every file's sha256 and path) is computed here, shown on the owner's card,
 * and checked again on confirm and after the files are moved into place.
 */

export class InstallError extends Error {}

const EXACT = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare'];
const MAX_FILES = 5000;
const MAX_BYTES = 50 * 1024 * 1024;

/** Every file under dir as a sorted list of relative paths. Refuses links and anything not a file or folder. */
export function walk(dir: string): string[] {
  const out: string[] = [];
  let bytes = 0;
  // The folder itself too: a tarball whose top-level package/ is a link would otherwise walk (and later
  // install) whatever folder on this machine it points at.
  const top = fs.lstatSync(dir);
  if (top.isSymbolicLink() || !top.isDirectory()) throw new InstallError('The package folder is a link or not a folder; links are not allowed.');
  const go = (rel: string) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isSymbolicLink()) throw new InstallError(`The package contains a link (${r}); links are not allowed.`);
      if (st.isDirectory()) go(r);
      else if (st.isFile()) {
        if (st.nlink > 1) throw new InstallError(`The package contains a hard link (${r}).`);
        out.push(r);
        bytes += st.size;
        if (out.length > MAX_FILES || bytes > MAX_BYTES) throw new InstallError('The package is too big (5000 files or 50 MB at most).');
      } else throw new InstallError(`The package contains something that is not a file (${r}).`);
    }
  };
  go('');
  return out;
}

const fileSha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** sha256 over "<sha256 of file>  <relative path>" lines, sorted by path: the same files give the same digest. */
export function treeDigest(dir: string): string {
  const lines = walk(dir).map((r) => `${fileSha(path.join(dir, r))}  ${r}\n`).join('');
  return crypto.createHash('sha256').update(lines).digest('hex');
}

const slug = (s: string) => s.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'plugin';

export interface Staged {
  /** The folder holding the package's files (its package.json at the top). */
  dir: string;
  id: string;
  version: string;
  digest: string;
  manifest: PluginManifest;
  source: string;
  files: number;
  /** Plain-language notes for the owner's card, e.g. which sites it says it talks to. */
  notes: string[];
}

/** Check an unpacked package and work out its manifest. */
export function inspectPackage(dir: string, source: string): Staged {
  const files = walk(dir);
  const pkgFile = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgFile)) throw new InstallError('The package has no package.json.');
  let pkg: any;
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch { throw new InstallError('package.json is not valid JSON.'); }
  const scripts = Object.keys(pkg.scripts ?? {}).filter((s) => INSTALL_SCRIPTS.includes(s));
  if (scripts.length) throw new InstallError(`The package has install scripts (${scripts.join(', ')}); plugins may not run code when installed.`);
  if (files.some((f) => /(^|\/)binding\.gyp$/.test(f) && !f.startsWith('node_modules/'))) throw new InstallError('The package builds native code (binding.gyp); that is not allowed.');
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length && !fs.existsSync(path.join(dir, 'npm-shrinkwrap.json'))) {
    throw new InstallError('The package has dependencies but no npm-shrinkwrap.json pinning them; it cannot be installed.');
  }
  let extra: any = {};
  const extraFile = path.join(dir, 'cleftbot-plugin.json');
  if (fs.existsSync(extraFile)) {
    try { extra = JSON.parse(fs.readFileSync(extraFile, 'utf8')); } catch { throw new InstallError('cleftbot-plugin.json is not valid JSON.'); }
  }
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && typeof pkg.bin === 'object' && Object.keys(pkg.bin).length === 1 ? Object.values(pkg.bin)[0] : undefined;
  const entry = String(extra.entry ?? bin ?? pkg.main ?? 'index.js').replace(/^\.\//, '');
  if (!/^[A-Za-z0-9._/-]+\.(m?js|cjs)$/.test(entry) || entry.split('/').includes('..')) throw new InstallError(`The start file "${entry}" is not a plain .js path inside the package.`);
  if (!files.includes(entry)) throw new InstallError(`The start file ${entry} is not in the package.`);
  const strList = (v: unknown, what: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.length < 200)) throw new InstallError(`"${what}" in cleftbot-plugin.json must be a list of strings.`);
    return v;
  };
  const version = String(pkg.version ?? '');
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new InstallError('package.json needs an exact version (like 1.2.3).');
  const settings = validateSettingsSpec(extra.settings);
  if (!settings.ok) throw new InstallError(`cleftbot-plugin.json: ${settings.error}`);
  const manifest: PluginManifest = {
    name: String(extra.name ?? pkg.name ?? 'plugin').slice(0, 80),
    description: typeof (extra.description ?? pkg.description) === 'string' ? String(extra.description ?? pkg.description).slice(0, 500) : undefined,
    entry,
    network: strList(extra.network, 'network'),
    ask: strList(extra.ask, 'ask'),
    block: strList(extra.block, 'block'),
    exclusive: extra.exclusive === true,
    ...(settings.value.length ? { settings: settings.value } : {}),
  };
  const notes: string[] = [];
  notes.push(manifest.network?.length ? `Says it talks to: ${manifest.network.join(', ')}. It gets network access.` : 'Gets no network access.');
  if (deps.length) notes.push(`Brings ${deps.length} pinned dependencies.`);
  return { dir, id: slug(String(pkg.name ?? manifest.name)), version, digest: treeDigest(dir), manifest, source, files: files.length, notes };
}

function unpack(tgz: string, into: string) {
  fs.mkdirSync(into, { recursive: true });
  // GNU tar: refuses members outside the folder by default; never restores owners or set-id bits.
  execFileSync('tar', ['-xzf', tgz, '-C', into, '--no-same-owner', '--no-same-permissions'], { stdio: 'pipe' });
  const pkgDir = path.join(into, 'package');
  let st: fs.Stats;
  try { st = fs.lstatSync(pkgDir); } catch { throw new InstallError('The tarball has no package/ folder.'); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new InstallError('The tarball\'s package/ is a link or not a folder; links are not allowed.');
  return pkgDir;
}

/** Fetch and check a package into staging/<key>. Throws InstallError with a message for the owner. */
export function stagePackage(spec: string, key: string): Staged {
  const root = path.join(stagingDir(), key);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o750 });
  let tgz: string;
  let source: string;
  if (spec.startsWith('file:')) {
    if (process.env.PLUGINS_ALLOW_LOCAL_TARBALLS !== '1') throw new InstallError('Installing from a local file is turned off (PLUGINS_ALLOW_LOCAL_TARBALLS).');
    tgz = spec.slice(5);
    if (!path.isAbsolute(tgz) || !/\.t(ar\.)?gz$/.test(tgz) || !fs.existsSync(tgz)) throw new InstallError('A local plugin must be an absolute path to an existing .tgz file.');
    source = `file:${path.basename(tgz)}`;
  } else {
    if (!EXACT.test(spec)) throw new InstallError('Give the package as name@exact-version, for example my-plugin@1.2.3.');
    try {
      const out = execFileSync('npm', ['pack', spec, '--ignore-scripts', '--json', '--pack-destination', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
      tgz = path.join(root, JSON.parse(out)[0].filename);
    } catch (e) {
      throw new InstallError(`npm could not fetch ${spec}: ${String((e as any).stderr ?? (e as Error).message).split('\n').find(Boolean) ?? 'unknown error'}`);
    }
    source = `npm:${spec}`;
  }
  let dir: string;
  try { dir = unpack(tgz, path.join(root, 'x')); } catch (e) { throw e instanceof InstallError ? e : new InstallError('The tarball could not be unpacked.'); }
  const first = inspectPackage(dir, source);
  if (fs.existsSync(path.join(dir, 'npm-shrinkwrap.json')) && Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dependencies ?? {}).length) {
    try {
      execFileSync('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-bin-links', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'pipe', timeout: 300_000 });
    } catch (e) {
      throw new InstallError(`Its pinned dependencies could not be fetched: ${String((e as any).stderr ?? '').split('\n').find(Boolean) ?? 'npm ci failed'}`);
    }
    return inspectPackage(dir, source);
  }
  return first;
}
