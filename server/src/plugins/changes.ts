import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { appConfig } from '../local-apps.js';
import { isOwner } from './owner.js';
import { audit, botsWith, PluginError, pluginOverview, setEnabled } from './registry.js';
import { InstallError, inspectPackage, stagePackage, treeDigest } from './install.js';
import { deletePluginForGood, ensureDirs, installedDir, installedPlugin, pluginHistory, recordInstall, recordRemove, recordRestore, stagingDir, type PluginManifest } from './store.js';

/**
 * Changes to plugins, made in two steps so the owner always sees exactly what will happen:
 *
 *  1. propose: the owner asks for a change in the app. The server works out everything (fetches and
 *     checks a package, finds the bots involved) and stores a pending change with a plain summary and
 *     a digest of exactly what will be done. Nothing changes yet.
 *  2. confirm: the owner confirms that change, sending the digest back. The server checks it is the
 *     same account, still the owner, the change has not expired (10 minutes), and the digest matches
 *     (for an install, the files are hashed again). Then it applies the change and returns what the
 *     database now says (readback). Confirming twice returns the first result and changes nothing.
 *
 * Both steps are API routes behind the signed-in session (routes.ts). No bot tool proposes or confirms
 * a change, a plugin's own code cannot, and a message from a bot is never a confirmation.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS plugin_changes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  digest TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`);

export const CHANGE_TTL_MS = 10 * 60 * 1000;
export type ChangeAction = 'enable' | 'disable' | 'install' | 'remove' | 'restore' | 'delete';

export interface ChangeView {
  id: string; action: ChangeAction; summary: string; details: string[]; digest: string;
  status: 'pending' | 'applied' | 'cancelled' | 'expired'; expiresAt: number; result?: unknown;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const botName = (id: string) => (db.prepare('SELECT name FROM bots WHERE id=?').get(id) as { name: string } | undefined)?.name;

function view(r: any): ChangeView {
  const p = JSON.parse(r.payload);
  const status = r.status === 'pending' && r.expires_at <= now() ? 'expired' : r.status;
  return { id: r.id, action: r.action, summary: r.summary, details: p.details ?? [], digest: r.digest, status, expiresAt: r.expires_at, result: r.result ? JSON.parse(r.result) : undefined };
}

function requireOwner(userId: string) {
  if (!isOwner(userId)) throw new PluginError('Only the owner of this server can change plugins.', 403);
}

function store(userId: string, action: ChangeAction, payload: Record<string, unknown>, summary: string, digest: string): ChangeView {
  const id = newId('pch');
  const t = now();
  db.prepare('INSERT INTO plugin_changes(id,user_id,action,payload,summary,digest,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, userId, action, JSON.stringify(payload), summary, digest, 'pending', t, t + CHANGE_TTL_MS);
  return view(db.prepare('SELECT * FROM plugin_changes WHERE id=?').get(id));
}

/**
 * An install from a folder on this server (a draft the AI builder made and the checks passed). Same
 * pending change as an npm install; the builder's review card then confirms it with its digest.
 */
export function proposeInstallFromDir(userId: string, src: string, source: string, bots: string[]): ChangeView {
  requireOwner(userId);
  ensureDirs();
  const key = newId('stg');
  const dir = path.join(stagingDir(), key, 'x');
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o750 });
  fs.cpSync(src, dir, { recursive: true, verbatimSymlinks: true });
  try {
    return stagedChange(userId, key, inspectPackage(dir, source), bots);
  } catch (e) {
    fs.rmSync(path.join(stagingDir(), key), { recursive: true, force: true });
    if (e instanceof InstallError) throw new PluginError(e.message, 400);
    throw e;
  }
}

function stagedChange(userId: string, key: string, staged: ReturnType<typeof inspectPackage>, botsIn: string[] | undefined): ChangeView {
  if (staged.id === 'hermes' || staged.id === 'hq') throw new PluginError(`The name ${staged.id} is reserved; rename the package.`, 409);
  const clash = appConfig(staged.id);
  if (clash && clash.origin !== 'installed') throw new PluginError(`The name ${staged.id} is already used by ${clash.origin === 'env' ? 'EXTRA_MCP_SERVERS' : 'apps.json'}.`, 409);
  const bots = (botsIn ?? []).map(String);
  for (const b of bots) if (!botName(b)) throw new PluginError('No such bot.', 404);
  if (staged.manifest.exclusive && bots.length > 1) throw new PluginError(`${staged.manifest.name} can be on for one bot only.`, 409);
  const prev = installedPlugin(staged.id);
  const details = [
    `${staged.source}, version ${staged.version}, ${staged.files} files.`,
    `Fingerprint ${staged.digest.slice(0, 16)}…`,
    ...staged.notes,
    'Runs in a locked-down container with none of the server\'s secrets.',
    bots.length ? `Then turn it on for: ${bots.map((b) => botName(b)).join(', ')}.` : 'It starts switched off for every bot.',
    ...(prev ? [`Replaces version ${prev.version}; the old one can be restored.`] : []),
  ];
  const payload = { key, dir: staged.dir, id: staged.id, version: staged.version, manifest: staged.manifest, source: staged.source, bots, details };
  return store(userId, 'install', payload, `Install ${staged.manifest.name} ${staged.version}`, staged.digest);
}

export interface ProposeInput { action: ChangeAction; pluginId?: string; botId?: string; spec?: string; bots?: string[]; digest?: string }

/** Step 1. Returns the pending change for the confirm card. Throws PluginError for anything refused. */
export function proposeChange(userId: string, input: ProposeInput): ChangeView {
  requireOwner(userId);
  switch (input.action) {
    case 'enable':
    case 'disable': {
      const cfg = appConfig(String(input.pluginId ?? ''));
      if (!cfg) throw new PluginError(`No plugin called ${input.pluginId}.`, 404);
      const name = botName(String(input.botId ?? ''));
      if (!name) throw new PluginError('No such bot.', 404);
      const on = input.action === 'enable';
      if (on && cfg.exclusive) {
        const other = botsWith(cfg.id).find((b) => b.id !== input.botId);
        if (other) throw new PluginError(`${cfg.name ?? cfg.id} can be on for one bot only, and ${other.name} has it. Turn it off for ${other.name} first.`, 409);
      }
      const payload = { pluginId: cfg.id, botId: input.botId, details: [cfg.origin === 'installed' ? 'Installed through the app: every tool asks before it runs until you choose "Always allow".' : `From ${cfg.origin ?? 'apps.json'}.`] };
      return store(userId, input.action, payload, `${on ? 'Turn on' : 'Turn off'} ${cfg.name ?? cfg.id} for ${name}`, sha(JSON.stringify([input.action, cfg.id, input.botId])));
    }
    case 'install': {
      ensureDirs();
      const key = newId('stg');
      let staged;
      try { staged = stagePackage(String(input.spec ?? ''), key); } catch (e) {
        fs.rmSync(path.join(stagingDir(), key), { recursive: true, force: true });
        if (e instanceof InstallError) throw new PluginError(e.message, 400);
        throw e;
      }
      try {
        return stagedChange(userId, key, staged, input.bots);
      } catch (e) {
        fs.rmSync(path.join(stagingDir(), key), { recursive: true, force: true });
        throw e;
      }
    }
    case 'remove': {
      const p = installedPlugin(String(input.pluginId ?? ''));
      if (!p) throw new PluginError(`No installed plugin called ${input.pluginId}.`, 404);
      const on = botsWith(p.id).map((b) => b.name);
      const payload = { pluginId: p.id, details: [on.length ? `It is on for: ${on.join(', ')}. They lose its tools.` : 'No bot has it on.', 'Its files are kept, so it can be restored.'] };
      return store(userId, 'remove', payload, `Remove ${p.manifest.name} ${p.version}`, p.digest);
    }
    case 'delete': {
      const id = String(input.pluginId ?? '');
      const p = installedPlugin(id);
      if (!p) {
        const cfg = appConfig(id);
        if (cfg) throw new PluginError(`${cfg.name ?? cfg.id} is built in (${cfg.origin === 'catalog' ? 'added under Connections; remove it there with Remove from Bots' : `from ${cfg.origin === 'env' ? 'EXTRA_MCP_SERVERS' : 'apps.json'}`}). It can only be switched off here.`, 409);
        throw new PluginError(`No installed plugin called ${id}.`, 404);
      }
      const on = botsWith(p.id).map((b) => b.name);
      const versions = pluginHistory(p.id).length;
      const payload = { pluginId: p.id, details: [
        on.length ? `It is on for ${on.join(', ')}. They lose its tools.` : 'No bot has it on.',
        `Its files (${versions === 1 ? 'one version' : `all ${versions} versions`}) and saved settings are deleted from the server. This can't be undone.`,
      ] };
      return store(userId, 'delete', payload, `Delete ${p.manifest.name}`, sha(JSON.stringify(['delete', p.id, pluginHistory(p.id).map((h) => h.digest)])));
    }
    case 'restore': {
      const hist = pluginHistory(String(input.pluginId ?? ''));
      const target = input.digest ? hist.find((h) => h.digest === input.digest) : hist.find((h) => h.status === 'removed');
      if (!target) throw new PluginError('There is no earlier version of that plugin to restore.', 404);
      if (!fs.existsSync(target.dir) || treeDigest(target.dir) !== target.digest) throw new PluginError('The files of that version changed or are gone; it cannot be restored.', 409);
      const payload = { pluginId: target.id, digest: target.digest, details: [`Version ${target.version}, fingerprint ${target.digest.slice(0, 16)}…`, 'Bot switches stay as they are.'] };
      return store(userId, 'restore', payload, `Restore ${target.manifest.name} ${target.version}`, target.digest);
    }
    default:
      throw new PluginError('Unknown change.', 400);
  }
}

function readback(pluginId: string) {
  const p = installedPlugin(pluginId);
  return {
    plugin: pluginOverview().find((o) => o.id === pluginId) ?? null,
    installed: p ? { id: p.id, version: p.version, digest: p.digest, status: p.status } : null,
  };
}

function apply(userId: string, action: ChangeAction, payload: any, digest: string): unknown {
  switch (action) {
    case 'enable':
    case 'disable':
      setEnabled(userId, payload.pluginId, payload.botId, action === 'enable');
      return readback(payload.pluginId);
    case 'install': {
      if (!fs.existsSync(payload.dir) || treeDigest(payload.dir) !== digest) throw new PluginError('The package changed after you were shown it; nothing was installed. Start again.', 409);
      fs.mkdirSync(installedDir(), { recursive: true, mode: 0o750 });
      const dest = path.join(installedDir(), `${payload.id}@${payload.version}-${digest.slice(0, 12)}`);
      if (!fs.existsSync(dest)) fs.renameSync(payload.dir, dest);
      fs.rmSync(path.join(stagingDir(), payload.key), { recursive: true, force: true });
      if (treeDigest(dest) !== digest) {
        fs.rmSync(dest, { recursive: true, force: true });
        throw new PluginError('The installed files do not match what you approved; the install was undone.', 409);
      }
      recordInstall({ id: payload.id, version: payload.version, digest, name: (payload.manifest as PluginManifest).name, source: payload.source, manifest: payload.manifest, dir: dest, installedBy: userId });
      audit(userId, 'install', payload.id, null, { version: payload.version, digest, source: payload.source });
      for (const b of payload.bots ?? []) setEnabled(userId, payload.id, b, true);
      return readback(payload.id);
    }
    case 'remove':
      if (!recordRemove(payload.pluginId, digest)) throw new PluginError('The installed version changed. Review the current version before removing it.', 409);
      audit(userId, 'remove', payload.pluginId, null, { digest });
      return readback(payload.pluginId);
    case 'delete': {
      const cur = sha(JSON.stringify(['delete', payload.pluginId, pluginHistory(payload.pluginId).map((h) => h.digest)]));
      if (cur !== digest) throw new PluginError('That plugin changed after you were shown it; nothing was deleted. Start again.', 409);
      const gone = deletePluginForGood(payload.pluginId);
      audit(userId, 'delete', payload.pluginId, null, gone);
      return { deleted: payload.pluginId, ...gone, ...readback(payload.pluginId) };
    }
    case 'restore': {
      // The files were hashed when the card was made; hash them again now, so a version whose files
      // changed or vanished since is never switched back on.
      const target = pluginHistory(payload.pluginId).find((h) => h.digest === payload.digest);
      if (!target) throw new PluginError('That version is gone.', 404);
      if (!fs.existsSync(target.dir) || treeDigest(target.dir) !== target.digest) throw new PluginError('The files of that version changed or are gone since you were shown it; nothing was restored.', 409);
      if (!recordRestore(payload.pluginId, payload.digest)) throw new PluginError('That version is gone.', 404);
      audit(userId, 'restore', payload.pluginId, null, { digest });
      return readback(payload.pluginId);
    }
  }
}

/** Step 2. Only the same owner, before expiry, with the digest they were shown. Idempotent. */
export function confirmChange(userId: string, changeId: string, digest: string): ChangeView {
  requireOwner(userId);
  const r = db.prepare('SELECT * FROM plugin_changes WHERE id=?').get(changeId) as any;
  if (!r || r.user_id !== userId) throw new PluginError('No such change.', 404);
  if (r.status === 'applied') return view(r);
  if (r.status !== 'pending') throw new PluginError(`That change was ${r.status}.`, 409);
  if (r.expires_at <= now()) {
    db.prepare("UPDATE plugin_changes SET status='expired' WHERE id=? AND status='pending'").run(changeId);
    throw new PluginError('That change expired; ask for it again.', 409);
  }
  if (typeof digest !== 'string' || digest !== r.digest) throw new PluginError('That is not the change you were shown.', 409);
  // Claim it first, so two confirms at once cannot both apply it.
  const claimed = db.prepare("UPDATE plugin_changes SET status='applying' WHERE id=? AND status='pending'").run(changeId).changes === 1;
  if (!claimed) return view(db.prepare('SELECT * FROM plugin_changes WHERE id=?').get(changeId));
  try {
    const result = apply(userId, r.action, JSON.parse(r.payload), r.digest);
    db.prepare("UPDATE plugin_changes SET status='applied', result=? WHERE id=?").run(JSON.stringify(result), changeId);
  } catch (e) {
    db.prepare("UPDATE plugin_changes SET status='cancelled', result=? WHERE id=?").run(JSON.stringify({ error: (e as Error).message }), changeId);
    throw e instanceof PluginError ? e : new PluginError((e as Error).message, 400);
  }
  return view(db.prepare('SELECT * FROM plugin_changes WHERE id=?').get(changeId));
}

export function cancelChange(userId: string, changeId: string): ChangeView {
  const r = db.prepare('SELECT * FROM plugin_changes WHERE id=?').get(changeId) as any;
  if (!r || r.user_id !== userId) throw new PluginError('No such change.', 404);
  if (r.status === 'pending') {
    db.prepare("UPDATE plugin_changes SET status='cancelled' WHERE id=? AND status='pending'").run(changeId);
    const p = JSON.parse(r.payload);
    if (r.action === 'install' && p.key) fs.rmSync(path.join(stagingDir(), p.key), { recursive: true, force: true });
  }
  return view(db.prepare('SELECT * FROM plugin_changes WHERE id=?').get(changeId));
}

export function changeAction(changeId: string): ChangeAction | undefined {
  return (db.prepare('SELECT action FROM plugin_changes WHERE id=?').get(changeId) as { action: ChangeAction } | undefined)?.action;
}

export function pendingChanges(userId: string): ChangeView[] {
  return (db.prepare("SELECT * FROM plugin_changes WHERE user_id=? AND status='pending' AND action NOT IN ('enable','disable') AND expires_at>? ORDER BY created_at DESC").all(userId, now()) as any[]).map(view);
}
