import fs from 'node:fs';
import path from 'node:path';
import { db, now } from '../db.js';
import { registerAppSource, invalidateApps, type AppConfig } from '../local-apps.js';
import type { SettingField, SettingValues } from './ui-schema.js';

/**
 * Plugins installed through the app: where their files live, the table that lists them, and the app
 * source that serves them to local-apps.ts like any other MCP app (origin "installed").
 *
 * An installed plugin always runs in a container (docker by default) with no network unless its
 * manifest lists sites, a read-only file system, no Linux capabilities, an unprivileged user, and
 * none of the server's environment. PLUGINS_UNSANDBOXED=1 runs it as a plain node process instead;
 * that is for tests and development only and is logged loudly.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  digest TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  manifest TEXT NOT NULL,
  dir TEXT NOT NULL,
  status TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  installed_by TEXT NOT NULL,
  PRIMARY KEY (id, digest)
);
CREATE TABLE IF NOT EXISTS plugin_settings (
  plugin_id TEXT PRIMARY KEY,
  vals TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
`);

export interface PluginManifest {
  name: string;
  description?: string;
  /** Path of the MCP server's start file inside the package (.js, .mjs or .cjs). */
  entry: string;
  network?: string[];
  ask?: string[];
  block?: string[];
  exclusive?: boolean;
  /** A settings form the owner fills in on the Plugins page (ui-schema.ts). Values reach the plugin as CLEFTBOT_SETTING_<KEY>. */
  settings?: SettingField[];
}

export interface PluginRow {
  id: string; version: string; digest: string; name: string; source: string;
  manifest: PluginManifest; dir: string; status: 'installed' | 'removed'; installedAt: number; installedBy: string;
}

const toRow = (r: any): PluginRow => ({
  id: r.id, version: r.version, digest: r.digest, name: r.name, source: r.source, manifest: JSON.parse(r.manifest),
  dir: r.dir, status: r.status, installedAt: r.installed_at, installedBy: r.installed_by,
});

export const pluginsDir = () => path.resolve(process.env.PLUGINS_DIR || path.join(process.cwd(), 'data', 'plugins'));
export const stagingDir = () => path.join(pluginsDir(), 'staging');
export const installedDir = () => path.join(pluginsDir(), 'installed');

export function installedPlugins(): PluginRow[] {
  return (db.prepare("SELECT * FROM plugins WHERE status='installed' ORDER BY id").all() as any[]).map(toRow);
}
export function installedPlugin(id: string): PluginRow | undefined {
  const r = db.prepare("SELECT * FROM plugins WHERE id=? AND status='installed'").get(id);
  return r ? toRow(r) : undefined;
}
/** Every version of a plugin ever installed, newest first (for Restore). */
export function pluginHistory(id: string): PluginRow[] {
  return (db.prepare('SELECT * FROM plugins WHERE id=? ORDER BY installed_at DESC').all(id) as any[]).map(toRow);
}

export function recordInstall(r: Omit<PluginRow, 'status' | 'installedAt'>) {
  const tx = db.transaction(() => {
    db.prepare("UPDATE plugins SET status='removed' WHERE id=? AND status='installed'").run(r.id);
    db.prepare(`INSERT INTO plugins(id,version,digest,name,source,manifest,dir,status,installed_at,installed_by) VALUES (?,?,?,?,?,?,?,'installed',?,?)
                ON CONFLICT(id,digest) DO UPDATE SET status='installed', installed_at=excluded.installed_at, installed_by=excluded.installed_by`)
      .run(r.id, r.version, r.digest, r.name, r.source, JSON.stringify(r.manifest), r.dir, now(), r.installedBy);
  });
  tx();
  invalidateApps();
}

export function recordRemove(id: string, digest: string): boolean {
  const removed = db.prepare("UPDATE plugins SET status='removed' WHERE id=? AND digest=? AND status='installed'").run(id, digest);
  if (removed.changes) invalidateApps();
  return removed.changes === 1;
}

/**
 * Delete an installed plugin for good: every version's files under installed/, its rows, its per-bot
 * switches and its saved settings. Only folders inside installedDir() are touched. Returns what was
 * removed so the caller can read it back.
 */
export function deletePluginForGood(id: string): { versions: number; folders: number } {
  const rows = db.prepare('SELECT dir FROM plugins WHERE id=?').all(id) as { dir: string }[];
  const base = path.resolve(installedDir()) + path.sep;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM plugins WHERE id=?').run(id);
    db.prepare('DELETE FROM plugin_settings WHERE plugin_id=?').run(id);
    db.prepare('DELETE FROM plugin_bots WHERE plugin_id=?').run(id);
  });
  tx();
  invalidateApps();
  let folders = 0;
  for (const r of rows) {
    const d = path.resolve(r.dir);
    if (!d.startsWith(base) || !fs.existsSync(d)) continue;
    fs.rmSync(d, { recursive: true, force: true });
    folders++;
  }
  return { versions: rows.length, folders };
}

export function recordRestore(id: string, digest: string): boolean {
  const tx = db.transaction(() => {
    const r = db.prepare('SELECT 1 FROM plugins WHERE id=? AND digest=?').get(id, digest);
    if (!r) return false;
    db.prepare("UPDATE plugins SET status='removed' WHERE id=? AND status='installed'").run(id);
    db.prepare("UPDATE plugins SET status='installed', installed_at=? WHERE id=? AND digest=?").run(now(), id, digest);
    return true;
  });
  const ok = tx();
  invalidateApps();
  return ok;
}

export function pluginSettings(id: string): SettingValues {
  const r = db.prepare('SELECT vals FROM plugin_settings WHERE plugin_id=?').get(id) as { vals: string } | undefined;
  return r ? JSON.parse(r.vals) : {};
}
export function savePluginSettings(id: string, vals: SettingValues, userId: string) {
  db.prepare('INSERT INTO plugin_settings(plugin_id,vals,updated_at,updated_by) VALUES (?,?,?,?) ON CONFLICT(plugin_id) DO UPDATE SET vals=excluded.vals, updated_at=excluded.updated_at, updated_by=excluded.updated_by')
    .run(id, JSON.stringify(vals), now(), userId);
  invalidateApps();
}

/** The owner's settings as environment variables for the plugin, and nothing else. */
function settingsEnv(p: PluginRow): Record<string, string> {
  const vals = pluginSettings(p.id);
  const out: Record<string, string> = {};
  for (const f of p.manifest.settings ?? []) if (vals[f.key] !== undefined) out[`CLEFTBOT_SETTING_${f.key.toUpperCase()}`] = String(vals[f.key]);
  return out;
}

let warned = false;
/** How an installed plugin is started. Nothing from the server's environment is passed on. */
export function launchConfig(p: PluginRow): Pick<AppConfig, 'command' | 'args' | 'cwd' | 'env'> {
  const entry = p.manifest.entry;
  if (process.env.PLUGINS_UNSANDBOXED === '1') {
    if (!warned) { warned = true; console.warn('[plugins] PLUGINS_UNSANDBOXED=1: installed plugins run WITHOUT a container. Use this for tests only.'); }
    return { command: process.execPath, args: [path.join(p.dir, entry)], cwd: p.dir, env: settingsEnv(p) };
  }
  const runtime = process.env.PLUGIN_RUNTIME || 'docker';
  const image = process.env.PLUGIN_RUNTIME_IMAGE || 'node:22-slim';
  const net = p.manifest.network?.length ? 'bridge' : 'none';
  const env = settingsEnv(p);
  // `-e NAME` without a value: docker takes the value from its own environment, so settings (which
  // may be secrets) never appear in the command line.
  const envArgs = Object.keys(env).flatMap((k) => ['-e', k]);
  return {
    command: runtime,
    args: [
      'run', '--rm', '-i', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', '65534:65534', '--memory', '512m', '--pids-limit', '128', '--network', net,
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '-v', `${p.dir}:/plugin:ro`, '-w', '/plugin',
      '--name', `cleftbot-plugin-${p.id}-${p.digest.slice(0, 8)}-${process.pid}`, ...envArgs,
      image, 'node', `/plugin/${entry}`,
    ],
    env,
  };
}

/** The installed plugins as apps (local-apps.ts). Its own allow rules are ignored there (appRule). */
export function installedApps(): AppConfig[] {
  return installedPlugins().map((p) => ({
    id: p.id,
    name: p.manifest.name || p.name,
    description: p.manifest.description,
    kind: 'mcp-app' as const,
    version: p.version,
    digest: p.digest,
    exclusive: p.manifest.exclusive === true,
    network: p.manifest.network,
    ask: p.manifest.ask,
    block: p.manifest.block,
    origin: 'installed' as const,
    ...launchConfig(p),
  }));
}

registerAppSource('installed', installedApps);

export function ensureDirs() {
  for (const d of [pluginsDir(), stagingDir(), installedDir()]) fs.mkdirSync(d, { recursive: true, mode: 0o750 });
}
