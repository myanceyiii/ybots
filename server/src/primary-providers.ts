/**
 * The shared provider catalog for the owner's own agent (Howard, the "primary" engine): the same settings
 * every bot has (default provider and model, fallbacks, the Claude subscription opt-in), written into that
 * agent's own Hermes home. That home is the owner's hand-kept setup, so every write here:
 *  - changes only the keys a setting names, and only when the owner changed that setting in the app
 *    (the default model is written only when the model or provider was changed, never on its own);
 *  - keeps comments and layout of config.yaml (yaml Document edits), and each file's owner and mode;
 *  - backs up config.yaml, .env and auth.json first (PRIMARY_BACKUP_DIR, default data/primary-backups);
 *  - writes one audit line (no secrets) to the maintainer log.
 * A change the running agent only picks up on start is not applied by restarting it here: it is marked
 * pending, and provider-runtime.ts runs PRIMARY_RESTART_COMMAND once the agent is idle.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { env } from './env.js';
import { parseFallbacks, POOL_LABEL, SUBSCRIPTION } from './provider-catalog.js';

const home = () => env.hermesHome;
const file = (name: string) => path.join(home(), name);

function readDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const readText = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/**
 * The shared Anthropic API key: the owner's agent's .env, or (once moved out of it for the Claude
 * subscription) the row in that agent's credential pool, or the app's own environment. Never logged.
 */
export function sharedAnthropicKey(): string {
  const fromEnv = (readDotenv(readText(file('.env')) ?? '').ANTHROPIC_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const rows: any[] = JSON.parse(readText(file('auth.json')) ?? '{}')?.credential_pool?.anthropic ?? [];
    const r = rows.find((x) => x?.label === POOL_LABEL && x?.access_token) ?? rows.find((x) => x?.source === 'env:ANTHROPIC_API_KEY' && x?.access_token);
    if (r) return String(r.access_token).trim();
  } catch { /* unreadable: none */ }
  return (process.env.ANTHROPIC_API_KEY ?? '').trim();
}

/** Write a file in the owner's home atomically, keeping its owner and mode (a new file gets the home's owner, 600). */
function writeKeeping(f: string, content: string) {
  let st: fs.Stats | null = null;
  try { st = fs.statSync(f); } catch { /* new file */ }
  const owner = st ?? fs.statSync(home());
  const tmp = `${f}.cleft-tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.chmodSync(tmp, st ? st.mode & 0o777 : 0o600);
  try { fs.chownSync(tmp, owner.uid, owner.gid); } catch { /* not root: already ours */ }
  fs.renameSync(tmp, f);
}

const backupRoot = () => process.env.PRIMARY_BACKUP_DIR || path.join(path.dirname(env.enginesDir), 'primary-backups');

/** Copy config.yaml, .env and auth.json to a new private backup folder; keeps the newest 30. Returns the folder. */
function backup(): string {
  const root = backupRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = path.join(root, new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z-' + crypto.randomBytes(2).toString('hex'));
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const n of ['config.yaml', '.env', 'auth.json']) {
    if (fs.existsSync(file(n))) { fs.copyFileSync(file(n), path.join(dir, n)); fs.chmodSync(path.join(dir, n), 0o600); }
  }
  try {
    const all = fs.readdirSync(root).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 30))) fs.rmSync(path.join(root, old), { recursive: true, force: true });
  } catch { /* best effort */ }
  return dir;
}

function audit(text: string) {
  const line = `${new Date().toISOString()} primary-providers ${text.replace(/\s+/g, ' ')}\n`;
  try { fs.appendFileSync(process.env.MAINTAINER_LOG || '/var/log/cleft-maintainer.log', line); } catch { /* not writable here (tests, or not root) */ }
  console.log(`[providers] ${line.trim()}`);
}

// ---------- restart, only when idle ----------

const pendingFile = () => path.join(path.dirname(env.enginesDir), 'primary-restart-pending');

export function primaryRestartPending(): string | null {
  return readText(pendingFile())?.trim() || null;
}

function markPending(reason: string) {
  try { fs.mkdirSync(path.dirname(pendingFile()), { recursive: true }); fs.writeFileSync(pendingFile(), reason.slice(0, 200)); } catch { /* best effort */ }
}

/** What settings say while a restart is pending, or null. */
export function primaryRestartNote(name: string): string | null {
  const why = primaryRestartPending();
  if (!why) return null;
  return env.primaryRestartCommand
    ? `${name}'s agent restarts to pick up the change (${why}) once it has been idle for a few minutes.`
    : `${name}'s agent needs a restart to pick up the change (${why}). The app is not set up to restart it (PRIMARY_RESTART_COMMAND), so restart it on the server.`;
}

/**
 * Whether the owner's agent did anything in the last few minutes on any of its platforms (its session
 * store changed). App turns are checked by the caller; this covers Telegram, the dashboard and the rest.
 */
export function primaryRecentlyActive(t = Date.now(), quietMs = 3 * 60_000): boolean {
  for (const n of ['state.db-wal', 'state.db', 'sessions']) {
    try { if (t - fs.statSync(file(n)).mtimeMs < quietMs) return true; } catch { /* missing */ }
  }
  return false;
}

let lastTry = 0;
/**
 * Run the restart command for a pending change. The caller has checked the agent is idle (`blocker` null).
 * Returns what happened, for the log and tests.
 */
export async function restartPrimaryIfPending(blocker: string | null, t = Date.now()): Promise<'none' | 'waiting' | 'no_command' | 'restarted' | 'failed'> {
  const why = primaryRestartPending();
  if (!why) return 'none';
  if (!env.primaryRestartCommand) return 'no_command';
  if (blocker || primaryRecentlyActive(t) || t - lastTry < 10 * 60_000) return 'waiting';
  lastTry = t;
  const ok = await new Promise<boolean>((resolve) => {
    execFile('/bin/sh', ['-c', env.primaryRestartCommand], { timeout: 60_000 }, (err, _out, stderr) => {
      if (err) console.warn(`[providers] restarting the owner's agent failed: ${String(stderr || err.message).slice(0, 300)}`);
      resolve(!err);
    });
  });
  if (ok) { try { fs.rmSync(pendingFile(), { force: true }); } catch { /* ignore */ } }
  audit(`restart ${ok ? 'done' : 'FAILED'} for: ${why}`);
  return ok ? 'restarted' : 'failed';
}

// ---------- the write ----------

export interface PrimarySync { changed: string[]; restart: boolean; backup: string | null; notes: string[] }

/**
 * Bring the owner's agent's Hermes home in line with its settings in the app.
 * `b` is its bots row; `o.model` = the default provider or model was changed in this request;
 * `applyModel` is engine.ts's applyModelToConfig (passed in to keep the modules apart).
 */
export function syncPrimaryProviders(b: any, o: { model: boolean; actor: string; applyModel: (cfg: any, provider: string | null, model: string | null) => boolean }): PrimarySync {
  const out: PrimarySync = { changed: [], restart: false, backup: null, notes: [] };
  const cfgFile = file('config.yaml');
  const text = readText(cfgFile);
  if (text === null) { out.notes.push('Its agent has no config.yaml where the app looks, so nothing was written.'); return out; }
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(`Its agent's config.yaml does not parse (${doc.errors[0].message}); not changing it.`);
  const cfg = (doc.toJSON() ?? {}) as any;
  const subOn = !!b.claude_subscription;
  const offDir = path.join(home(), 'no-claude-login');
  const restartWhy: string[] = [];

  // Fallbacks: exactly the app's chain, once it has been set there (until then the agent's own is shown).
  const fb = parseFallbacks(b.fallbacks);
  if (fb) {
    const want = fb.map((f) => ({ provider: f.provider, model: f.model }));
    if (JSON.stringify(cfg.fallback_providers ?? []) !== JSON.stringify(want) || cfg.fallback_model !== undefined) {
      doc.setIn(['fallback_providers'], doc.createNode(want));
      if (doc.hasIn(['fallback_model'])) doc.deleteIn(['fallback_model']);
      out.changed.push('fallbacks');
    }
  }

  // The subscription plugin's login: the bots' own Claude login when switched on, else an empty folder,
  // so it never finds the owner's personal ~/.claude login.
  const loginWant = subOn && env.claudeLoginDir ? env.claudeLoginDir : offDir;
  const loginNow = cfg.plugins?.entries?.[SUBSCRIPTION]?.settings?.claude_config_dir;
  if (loginNow !== loginWant) {
    doc.setIn(['plugins', 'entries', SUBSCRIPTION, 'settings', 'claude_config_dir'], loginWant);
    out.changed.push(`subscription login ${subOn ? 'on' : 'off'}`);
    // Pointing an unused plugin at the empty folder needs no restart; switching the route on or off does.
    if (subOn || (env.claudeLoginDir && loginNow === env.claudeLoginDir)) restartWhy.push(subOn ? 'Claude subscription switched on' : 'Claude subscription switched off');
  }
  if (!subOn || !env.claudeLoginDir) {
    try {
      if (!fs.existsSync(offDir)) {
        fs.mkdirSync(offDir, { mode: 0o700 });
        const st = fs.statSync(home());
        try { fs.chownSync(offDir, st.uid, st.gid); } catch { /* not root */ }
      }
    } catch { /* best effort */ }
  }
  if (subOn && cfg.auth?.adopt_external_logins !== false) {
    // The API route must never quietly use a Claude Code login it finds and bill the plan instead.
    doc.setIn(['auth', 'adopt_external_logins'], false);
    out.changed.push('no borrowed Claude logins');
  }
  if (subOn) {
    const enabled: unknown = cfg.plugins?.enabled;
    if (Array.isArray(enabled) && !enabled.includes(SUBSCRIPTION)) {
      doc.setIn(['plugins', 'enabled'], doc.createNode([...enabled, SUBSCRIPTION]));
      out.changed.push('subscription plugin enabled');
      restartWhy.push('subscription plugin enabled');
    }
    if (!fs.existsSync(path.join(home(), 'plugins', SUBSCRIPTION, 'plugin.yaml'))) {
      out.notes.push('The Claude subscription plugin is not installed in its agent, so the route will not work there yet.');
    }
  }

  // The default model, only when it was changed in the app just now.
  if (o.model && b.provider) {
    const m = JSON.parse(JSON.stringify(cfg));
    const oldProvider = cfg.model && typeof cfg.model === 'object' ? cfg.model.provider ?? null : null;
    if (o.applyModel(m, b.provider, b.model ?? null)) {
      doc.setIn(['model'], doc.createNode(m.model));
      out.changed.push(`default ${b.provider}${b.model ? ` / ${b.model}` : ''}`);
      restartWhy.push(oldProvider !== b.provider ? 'new default provider' : 'new default model');
    }
  }

  // .env: with the subscription on, the API key moves to the credential pool, because the plugin refuses
  // to run with it in its environment. Nothing else in the owner's .env is touched; other settings the
  // plugin refuses are only pointed out.
  const envText = readText(file('.env'));
  let newEnv: string | null = null;
  let newAuth: string | null = null;
  if (subOn && envText !== null) {
    const vars = readDotenv(envText);
    const key = (vars.ANTHROPIC_API_KEY ?? '').trim();
    let lines = envText.split('\n');
    if (key) {
      let store: any = {};
      try { store = JSON.parse(readText(file('auth.json')) ?? '{}') ?? {}; } catch { throw new Error('Its agent\'s auth.json does not parse; not moving the key.'); }
      putPoolKey(store, key);
      newAuth = JSON.stringify(store, null, 2) + '\n';
      lines = lines.filter((l) => !/^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=/.test(l));
      out.changed.push('Anthropic key moved to the credential pool');
      restartWhy.push('Anthropic key moved out of its environment');
    }
    if (env.claudeCodeBin && vars.CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND !== env.claudeCodeBin) {
      lines = lines.filter((l) => !/^\s*(?:export\s+)?CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND\s*=/.test(l));
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      lines.push(`CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND=${env.claudeCodeBin}`, '');
      out.changed.push('Claude Code path');
      restartWhy.push('Claude Code path');
    }
    const next = lines.join('\n');
    if (next !== envText) newEnv = next;
    const blocking = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY'].filter((k) => (vars[k] ?? '').trim());
    blocking.push(...['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].filter((k) => !['', '0', 'false', 'no', 'off'].includes((vars[k] ?? '').trim().toLowerCase())));
    if (blocking.length) out.notes.push(`Its agent's .env also sets ${blocking.join(', ')}; the subscription plugin refuses to run while those are set, and the app leaves them for you to remove.`);
  }

  const newCfg = doc.toString();
  if (newCfg === text && newEnv === null && newAuth === null) return out;
  out.backup = backup();
  if (newCfg !== text) writeKeeping(cfgFile, newCfg);
  if (newAuth !== null) writeKeeping(file('auth.json'), newAuth);
  if (newEnv !== null) writeKeeping(file('.env'), newEnv); // after the pool has the key
  if (restartWhy.length) { out.restart = true; markPending(restartWhy.join(', ')); }
  audit(`actor=${o.actor} bot=${b.id} changed=[${out.changed.join('; ')}] restart=${out.restart ? 'pending' : 'no'} backup=${out.backup}`);
  return out;
}

/** The shared key as this app's row in a credential pool; rows seeded from ANTHROPIC_API_KEY go (it left the environment). Others stay. */
function putPoolKey(store: any, key: string) {
  const pool = store.credential_pool && typeof store.credential_pool === 'object' && !Array.isArray(store.credential_pool) ? store.credential_pool : {};
  const rows: any[] = (Array.isArray(pool.anthropic) ? pool.anthropic : []).filter((r: any) => r?.source !== 'env:ANTHROPIC_API_KEY');
  const mine = rows.find((r) => r?.label === POOL_LABEL);
  if (mine) mine.access_token = key;
  else rows.unshift({ id: crypto.randomBytes(3).toString('hex'), label: POOL_LABEL, auth_type: 'api_key', priority: 0, source: 'manual', access_token: key, base_url: 'https://api.anthropic.com' });
  pool.anthropic = rows;
  store.credential_pool = pool;
  if (!store.version) store.version = 1;
}
