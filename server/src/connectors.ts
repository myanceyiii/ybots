import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { appsStatus, invalidateApps, registerAppSource, wildMatch, type AppConfig } from './local-apps.js';
import { isOwner } from './plugins/owner.js';
import { allowedFor, audit, pluginOverview } from './plugins/registry.js';

/** A sign-in server has a token once its token file exists. */
const signedIn = (t: { oauth?: { tokenFile: string } }) => !t.oauth || fs.existsSync(path.resolve(new URL('../../', import.meta.url).pathname, t.oauth.tokenFile));

/**
 * Connectors: a catalog of every MCP server the owner has, on this machine, on the other machines in
 * the cluster, and in the cloud, past and present. It is what Settings → Connectors (web, Windows) and
 * the Connectors screen (Android) show, and where the owner adds one to bots.
 *
 * Where entries come from:
 *  - the catalog file (CONNECTORS_CATALOG, default data/connectors-catalog.json, kept on the machine,
 *    never in the repo): hand-kept entries with history, notes and, when Cleft can reach the server, an
 *    app template (an apps.json entry without id; keys as ${VAR} from .env);
 *  - a scan of the machines (CONNECTOR_SCAN_HOSTS, SSH targets): every day, and when the owner presses
 *    Scan now. A scan only reads unit, container and config names (deploy/connectors/scan-host.sh).
 *    Something found that no catalog entry claims becomes a new entry; an entry no longer found on a
 *    host that answered is kept and marked as gone, so the list is also the history.
 *
 * Adding a connector to bots is proposed, then confirmed with the digest shown (like plugin changes).
 * An added connector is served like an apps.json app (origin "catalog"), so every call still goes
 * through the approval check, and its per-bot switches are the bot's Tools tab.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  machine TEXT,
  transport TEXT,
  address TEXT,
  access TEXT,
  auth TEXT,
  reach TEXT,
  description TEXT,
  notes TEXT,
  firm INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  app_ids TEXT,
  template TEXT,
  match TEXT,
  first_seen INTEGER,
  last_seen INTEGER,
  gone_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_apps (
  connector_id TEXT PRIMARY KEY,
  bots TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  added_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_scans (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  hosts TEXT NOT NULL,
  found INTEGER NOT NULL,
  added INTEGER NOT NULL,
  gone INTEGER NOT NULL,
  error TEXT
);
`);
// Wanted connections (added 2026-11-23): what a connection would unlock, which bots and skills need it, and the setup it takes.
if (!(db.prepare("SELECT 1 FROM pragma_table_info('connectors') WHERE name='wanted'").get())) db.exec('ALTER TABLE connectors ADD COLUMN wanted TEXT');

export type ConnectorStatus = 'active' | 'stopped' | 'retired' | 'gone' | 'unknown' | 'wanted';
export type Reach = 'cleft' | 'needs-setup' | 'cloud' | 'native';

export interface CatalogEntry {
  id: string;
  name: string;
  machine?: string;
  /** http, stdio, unix, ssh, cloud */
  transport?: string;
  /** Where it listens (no keys): "127.0.0.1:3600/http", "claude.ai connector", ... */
  address?: string;
  /** read, read-write, admin */
  access?: string;
  /** none, key, oauth, ssh */
  auth?: string;
  /**
   * cleft: Cleft can serve it (has a template or is already an app); needs-setup: a tunnel or key is
   * missing; cloud: a hosted connector bots can't use without their own sign-in; native: wired straight
   * into a bot's Hermes, outside Cleft.
   */
  reach?: Reach;
  description?: string;
  notes?: string;
  /** Firm or work data: never offered to the household bots. */
  firm?: boolean;
  status?: ConnectorStatus;
  /** apps.json ids that already serve this connector. */
  appIds?: string[];
  /** An apps.json entry without id, for "Add to bots". */
  template?: Omit<AppConfig, 'id'>;
  /** Scan items this entry claims: "unit:<name>", "docker:<name>", "front:<name>", "hermes:<name>", with * wildcards. */
  match?: string[];
  /** ISO date this connector first existed, when known from history. */
  since?: string;
  /** ISO date it was retired. */
  retired?: string;
  /**
   * A connection the owner wants for the bots but that isn't set up yet (or a server that doesn't exist
   * yet: then status is "wanted"). Shown under Wanted, in rank order.
   */
  wanted?: Wanted;
}

export interface Wanted {
  /** 1 = connect first. */
  rank?: number;
  /** What it lets the bots do. */
  unlocks: string;
  /** Bots that would get it, with their access: "Leonard (read, drafts on cards)". */
  bots?: string[];
  /** Skills that need it: "leonard/inbox-watch". */
  skills?: string[];
  /** Setup steps, in order. */
  setup?: string[];
  /** What needs the owner's OK or sign-in before it can be done. */
  needs?: string;
  /** Where it stands: "waiting for Alex's sign-in". */
  state?: string;
  /**
   * "browser": not a connection of its own but a site the bots will use through the shared browser
   * (a store, Marketplace). The apps show it under the shared browser, not as a connector.
   */
  via?: 'browser';
}

const cleanWanted = (w: unknown): Wanted | null => {
  if (!w || typeof w !== 'object') return null;
  const o = w as Record<string, unknown>;
  const strs = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : undefined);
  if (typeof o.unlocks !== 'string' || !o.unlocks) return null;
  return {
    rank: typeof o.rank === 'number' ? o.rank : undefined, unlocks: o.unlocks, bots: strs(o.bots), skills: strs(o.skills), setup: strs(o.setup),
    needs: typeof o.needs === 'string' ? o.needs : undefined, state: typeof o.state === 'string' ? o.state : undefined,
    via: o.via === 'browser' ? 'browser' : undefined,
  };
};

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'connector';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const day = (iso?: string) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };

export function catalogPath(): string {
  const root = new URL('../../', import.meta.url).pathname;
  return path.resolve(root, process.env.CONNECTORS_CATALOG || 'data/connectors-catalog.json');
}

let catalogMtime = -1;
/** Scan items that are not connectors (helpers, lab containers): the catalog file's top-level "ignore", same pattern form as "match". */
let ignorePatterns: string[] = [];
/** Read the catalog file into the table when it changed. Entries are upserted; nothing is deleted. */
export function loadCatalog(file = catalogPath()): { loaded: number; error?: string } {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return { loaded: 0 }; }
  if (mtime === catalogMtime) return { loaded: 0 };
  let list: CatalogEntry[];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    list = Array.isArray(raw) ? raw : Array.isArray(raw?.connectors) ? raw.connectors : [];
    ignorePatterns = Array.isArray(raw?.ignore) ? raw.ignore.map(String) : [];
  } catch (e) {
    console.warn(`[connectors] ${file} could not be read: ${(e as Error).message}`);
    return { loaded: 0, error: (e as Error).message };
  }
  catalogMtime = mtime;
  const t = now();
  let n = 0;
  const up = db.prepare(`INSERT INTO connectors(id,name,machine,transport,address,access,auth,reach,description,notes,firm,status,source,app_ids,template,match,first_seen,last_seen,gone_at,updated_at,wanted)
    VALUES (@id,@name,@machine,@transport,@address,@access,@auth,@reach,@description,@notes,@firm,@status,'catalog',@app_ids,@template,@match,@first_seen,NULL,@gone_at,@t,@wanted)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, machine=excluded.machine, transport=excluded.transport, address=excluded.address, access=excluded.access,
      auth=excluded.auth, reach=excluded.reach, description=excluded.description, notes=excluded.notes, firm=excluded.firm,
      status=CASE WHEN connectors.match IS NOT NULL AND excluded.match IS NOT NULL AND excluded.status IN ('active','unknown') THEN connectors.status ELSE excluded.status END,
      source='catalog', app_ids=excluded.app_ids, template=excluded.template, match=excluded.match,
      first_seen=MIN(COALESCE(connectors.first_seen, excluded.first_seen), COALESCE(excluded.first_seen, connectors.first_seen)),
      gone_at=COALESCE(excluded.gone_at, connectors.gone_at), updated_at=excluded.updated_at, wanted=excluded.wanted`);
  for (const e of list) {
    if (!e || !ID.test(String(e.id ?? '')) || !e.name) { console.warn(`[connectors] skipping catalog entry ${JSON.stringify(e?.id)}`); continue; }
    up.run({
      id: e.id, name: e.name, machine: e.machine ?? null, transport: e.transport ?? null, address: e.address ?? null, access: e.access ?? null,
      auth: e.auth ?? null, reach: e.reach ?? (e.template || e.appIds?.length ? 'cleft' : 'needs-setup'), description: e.description ?? null, notes: e.notes ?? null,
      firm: e.firm ? 1 : 0, status: e.retired ? 'retired' : e.status ?? (e.wanted && !e.machine && !e.template && !e.appIds?.length ? 'wanted' : 'unknown'), app_ids: e.appIds?.length ? JSON.stringify(e.appIds) : null,
      template: e.template ? JSON.stringify(e.template) : null, match: e.match?.length ? JSON.stringify(e.match) : null,
      first_seen: day(e.since), gone_at: day(e.retired), t, wanted: (() => { const w = cleanWanted(e.wanted); return w ? JSON.stringify(w) : null; })(),
    });
    n++;
  }
  invalidateApps();
  return { loaded: n };
}

// ---------- scanning ----------

export interface ScanItem { kind: 'unit' | 'userunit' | 'docker' | 'front' | 'hermes'; host: string; name: string; active: boolean; detail: string }

/** Lines from deploy/connectors/scan-host.sh → items. Hosts that printed "done" answered completely. */
export function parseScan(text: string): { items: ScanItem[]; hostsDone: Set<string> } {
  const items: ScanItem[] = [];
  const hostsDone = new Set<string>();
  for (const line of text.split('\n')) {
    const f = line.split('|');
    const host = f[1];
    if (!host) continue;
    switch (f[0]) {
      case 'done': hostsDone.add(host); break;
      case 'unit': case 'userunit': items.push({ kind: f[0], host, name: f[2], active: f[4] === 'active', detail: f[5] || '' }); break;
      case 'docker': items.push({ kind: 'docker', host, name: f[2], active: /^up/i.test(f[4] ?? ''), detail: f[3] || '' }); break;
      case 'front': items.push({ kind: 'front', host, name: f[2], active: true, detail: [f[3], f[4]].filter(Boolean).join(' → ') }); break;
      case 'hermes': items.push({ kind: 'hermes', host, name: f[3], active: f[5] !== 'False', detail: `in ${f[2]}` }); break;
    }
  }
  return { items, hostsDone };
}

const wild = (p: string, s: string) => wildMatch(p, s);
const itemKey = (i: ScanItem) => `${i.kind === 'userunit' ? 'unit' : i.kind}:${i.kind === 'userunit' ? i.name.split(':').slice(1).join(':') : i.name}`;

/** Fold one scan into the table. Returns counts. `at` is the scan time. */
export function applyScan(items: ScanItem[], hostsDone: Set<string>, at = now()): { found: number; added: number; gone: number } {
  const rows = db.prepare('SELECT id, machine, match, source, status FROM connectors').all() as { id: string; machine: string | null; match: string | null; source: string; status: string }[];
  const claimed = new Map<string, { active: boolean }>(); // connector id → seen
  const extra: ScanItem[] = [];
  const hits = (p: string, key: string, host: string) => {
    const [m, rest] = p.includes('@') ? [p.split('@')[1], p.split('@')[0]] : [null, p];
    return wild(rest, key) && (!m || wild(m, host));
  };
  for (const it of items) {
    const key = itemKey(it);
    if (ignorePatterns.some((p) => hits(p, key, it.host))) continue;
    const owner = rows.find((r) => r.match && (JSON.parse(r.match) as string[]).some((p) => hits(p, key, it.host)));
    if (owner) { const c = claimed.get(owner.id); claimed.set(owner.id, { active: (c?.active ?? false) || it.active }); }
    else extra.push(it);
  }
  const t = at;
  const seen = db.prepare(`UPDATE connectors SET last_seen=@t, gone_at=NULL, status=CASE WHEN status='retired' THEN status WHEN @active=1 THEN 'active' ELSE 'stopped' END, updated_at=@t WHERE id=@id`);
  for (const [id, s] of claimed) seen.run({ id, t, active: s.active ? 1 : 0 });
  let added = 0;
  const ins = db.prepare(`INSERT INTO connectors(id,name,machine,transport,address,access,auth,reach,description,notes,firm,status,source,first_seen,last_seen,updated_at)
    VALUES (@id,@name,@machine,@transport,NULL,NULL,NULL,'needs-setup',@description,NULL,0,@status,'scan',@t,@t,@t)
    ON CONFLICT(id) DO UPDATE SET last_seen=@t, gone_at=NULL, status=@status, description=@description, updated_at=@t`);
  const scanIds = new Set<string>();
  for (const it of extra) {
    const id = slug(`scan-${it.host}-${it.kind}-${it.name}`);
    scanIds.add(id);
    const existed = db.prepare('SELECT 1 FROM connectors WHERE id=?').get(id);
    ins.run({ id, name: it.kind === 'hermes' ? `${it.name} (in Hermes)` : it.name.replace(/\.service$/, ''), machine: it.host, transport: it.kind, description: it.detail || null, status: it.active ? 'active' : 'stopped', t });
    if (!existed) added++;
  }
  // Something found before on a host that answered completely, and not found now, is marked gone (kept as history).
  let gone = 0;
  const markGone = db.prepare(`UPDATE connectors SET status='gone', gone_at=@t, updated_at=@t WHERE id=@id AND status NOT IN ('gone','retired')`);
  for (const r of rows) {
    if (!r.machine || !hostsDone.has(r.machine)) continue;
    const scanned = r.source === 'scan' || !!r.match;
    if (!scanned || claimed.has(r.id) || scanIds.has(r.id)) continue;
    gone += markGone.run({ id: r.id, t }).changes;
  }
  return { found: items.length, added, gone };
}

const SCRIPT = () => path.resolve(new URL('../../', import.meta.url).pathname, 'deploy/connectors/scan-host.sh');

function runOn(host: string, user: string, script: string): Promise<string> {
  return new Promise((resolve) => {
    const ssh = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', host, 'bash -s'];
    const [cmd, args] = user && process.getuid?.() === 0 ? ['sudo', ['-u', user, ...ssh]] : [ssh[0], ssh.slice(1)];
    const child = execFile(cmd, args as string[], { timeout: 90_000, maxBuffer: 2_000_000 }, (_err, stdout) => resolve(String(stdout ?? '')));
    child.stdin?.end(script);
  });
}

let scanning: Promise<unknown> | null = null;
/** Scan every host in CONNECTOR_SCAN_HOSTS. One at a time; a second call while one runs waits for it. */
export async function scanNow(): Promise<{ at: number; hosts: string[]; answered: string[]; found: number; added: number; gone: number; error?: string }> {
  if (scanning) await scanning.catch(() => {});
  const hosts = (process.env.CONNECTOR_SCAN_HOSTS ?? '').split(/[\s,]+/).filter(Boolean);
  const user = process.env.CONNECTOR_SCAN_USER ?? '';
  const at = now();
  const job = (async () => {
    if (!hosts.length) return { at, hosts, answered: [], found: 0, added: 0, gone: 0, error: 'CONNECTOR_SCAN_HOSTS is not set, so there is nothing to scan.' };
    let script: string;
    try { script = fs.readFileSync(SCRIPT(), 'utf8'); } catch (e) { return { at, hosts, answered: [], found: 0, added: 0, gone: 0, error: `scan script missing: ${(e as Error).message}` }; }
    const outs = await Promise.all(hosts.map((h) => runOn(h, user, script)));
    loadCatalog();
    const { items, hostsDone } = parseScan(outs.join('\n'));
    const r = applyScan(items, hostsDone, at);
    const answered = [...hostsDone];
    const error = answered.length < hosts.length ? `${hosts.length - answered.length} of ${hosts.length} machines didn't answer` : undefined;
    db.prepare('INSERT INTO connector_scans(id,at,hosts,found,added,gone,error) VALUES (?,?,?,?,?,?,?)').run(newId('csc'), at, JSON.stringify(answered), r.found, r.added, r.gone, error ?? null);
    return { at, hosts, answered, ...r, error };
  })();
  scanning = job;
  try { return await job; } finally { scanning = null; }
}

export function lastScan(): { at: number; answered: string[]; found: number; added: number; gone: number; error: string | null } | null {
  const r = db.prepare('SELECT * FROM connector_scans ORDER BY at DESC LIMIT 1').get() as any;
  return r ? { at: r.at, answered: JSON.parse(r.hosts), found: r.found, added: r.added, gone: r.gone, error: r.error } : null;
}

const DAY = 24 * 60 * 60 * 1000;
/** Daily scan (first one two minutes after start). Does nothing without CONNECTOR_SCAN_HOSTS. */
export function startConnectorScans() {
  if (!process.env.CONNECTOR_SCAN_HOSTS) return;
  const run = () => scanNow().then((r) => console.log(`[connectors] scan: ${r.found} found, ${r.added} new, ${r.gone} gone${r.error ? ` (${r.error})` : ''}`)).catch((e) => console.warn(`[connectors] scan failed: ${e.message}`));
  setTimeout(run, 2 * 60 * 1000).unref?.();
  setInterval(run, DAY).unref?.();
}

// ---------- added connectors are apps ----------

function addedApps(): AppConfig[] {
  const rows = db.prepare('SELECT a.connector_id AS id, a.bots, c.name, c.description, c.template FROM connector_apps a JOIN connectors c ON c.id = a.connector_id').all() as { id: string; bots: string; name: string; description: string | null; template: string | null }[];
  const out: AppConfig[] = [];
  for (const r of rows) {
    if (!r.template) continue;
    const t = JSON.parse(r.template) as Omit<AppConfig, 'id'>;
    out.push({ ...t, id: r.id, name: t.name ?? r.name, description: t.description ?? r.description ?? undefined, bots: JSON.parse(r.bots), origin: 'catalog' });
  }
  return out;
}
registerAppSource('catalog', addedApps);

// ---------- what the app shows ----------

export interface ConnectorView {
  id: string; name: string; machine: string | null; transport: string | null; address: string | null; access: string | null; auth: string | null;
  reach: Reach; description: string | null; notes: string | null; firm: boolean; status: ConnectorStatus; source: string;
  firstSeen: number | null; lastSeen: number | null; goneAt: number | null;
  /** The apps that serve it now and which bots have them on. */
  apps: { id: string; name: string; status: string; bots: string[] }[];
  /** "Add to bots" is possible (a template, not added yet). */
  canAdd: boolean;
  /** Added from this list (so it can be removed from here). */
  added: boolean;
  /** Bots it may be added to (onlyBots in its template), or null for any. */
  onlyBots: string[] | null;
  /** Connected by address in the app (can be removed and signed in again from there). */
  custom: boolean;
  /** A sign-in server that has no token yet. */
  needsSignIn: boolean;
  /** Wanted for the bots and not connected yet: what it unlocks, who and which skills need it, the setup. Null once bots use it. */
  wanted: Wanted | null;
  /** A site the bots will use through the shared browser (wanted.via "browser"), not a connection. */
  browserSite: boolean;
}

export async function listConnectors(): Promise<ConnectorView[]> {
  loadCatalog();
  const status = new Map((await appsStatus()).apps.map((a) => [a.id, a]));
  const overview = new Map(pluginOverview().map((p) => [p.id, p]));
  const added = new Set((db.prepare('SELECT connector_id FROM connector_apps').all() as { connector_id: string }[]).map((r) => r.connector_id));
  const rows = db.prepare('SELECT * FROM connectors ORDER BY name COLLATE NOCASE').all() as any[];
  return rows.map((r) => {
    const ids: string[] = [...(r.app_ids ? JSON.parse(r.app_ids) : []), ...(added.has(r.id) ? [r.id] : [])];
    const apps = ids.filter((id) => status.has(id) || overview.has(id)).map((id) => ({
      id, name: status.get(id)?.name ?? id, status: status.get(id)?.status ?? 'stopped',
      bots: (overview.get(id)?.bots ?? []).filter((b) => b.enabled).map((b) => b.name),
    }));
    return {
      id: r.id, name: r.name, machine: r.machine, transport: r.transport, address: r.address, access: r.access, auth: r.auth,
      reach: (apps.length ? 'cleft' : r.reach) as Reach, description: r.description, notes: r.notes, firm: r.firm === 1, status: r.status, source: r.source,
      firstSeen: r.first_seen, lastSeen: r.last_seen, goneAt: r.gone_at, apps,
      canAdd: !!r.template && !r.app_ids && !added.has(r.id) && !r.firm && r.status !== 'retired' && signedIn(JSON.parse(r.template)), added: added.has(r.id),
      custom: r.source === 'custom' || r.source === 'google', needsSignIn: !!r.template && !signedIn(JSON.parse(r.template)),
      onlyBots: r.template ? (JSON.parse(r.template).onlyBots ?? null) : null,
      wanted: r.wanted && !apps.some((a) => a.bots.length) ? (JSON.parse(r.wanted) as Wanted) : null,
      browserSite: !!r.wanted && (JSON.parse(r.wanted) as Wanted).via === 'browser' && !apps.length,
    };
  });
}

// ---------- add and remove, proposed then confirmed ----------

export class ConnectorError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) { super(message); }
}

interface Pending { id: string; userId: string; action: 'add' | 'remove'; connectorId: string; bots: string[]; summary: string; details: string[]; digest: string; expiresAt: number; status: 'pending' | 'applied' | 'cancelled' }
const pending = new Map<string, Pending>();
const TTL = 10 * 60 * 1000;
/** Bots a connector can be added to (not group chats). */
export const botRows = () => db.prepare("SELECT id, name FROM bots WHERE COALESCE(kind,'agent') <> 'room' ORDER BY created_at").all() as { id: string; name: string }[];

export interface ProposalView { id: string; summary: string; details: string[]; digest: string; status: string; expiresAt: number }
const viewOf = (p: Pending): ProposalView => ({ id: p.id, summary: p.summary, details: p.details, digest: p.digest, status: p.expiresAt <= now() && p.status === 'pending' ? 'expired' : p.status, expiresAt: p.expiresAt });

export function proposeConnector(userId: string, body: { action?: string; connectorId?: string; bots?: unknown }): ProposalView {
  if (!isOwner(userId)) throw new ConnectorError('Only the owner of this server can add connectors.', 403);
  loadCatalog();
  const c = db.prepare('SELECT * FROM connectors WHERE id=?').get(String(body.connectorId ?? '')) as any;
  if (!c) throw new ConnectorError('No such connector.', 404);
  const isAdded = !!db.prepare('SELECT 1 FROM connector_apps WHERE connector_id=?').get(c.id);
  if (body.action === 'add') {
    if (isAdded || c.app_ids) throw new ConnectorError(`${c.name} is already set up. Change which bots have it in each bot's Tools tab.`, 409);
    if (!c.template) throw new ConnectorError(`${c.name} needs setup on the machines before bots can use it.`, 409);
    if (!signedIn(JSON.parse(c.template))) throw new ConnectorError(`${c.name} isn't signed in yet. Sign in first.`, 409);
    if (c.firm) throw new ConnectorError(`${c.name} holds firm data and is never added to the household bots.`, 409);
    if (c.status === 'retired') throw new ConnectorError(`${c.name} is retired.`, 409);
    if (pluginOverview().some((p) => p.id === c.id && p.origin !== 'catalog')) throw new ConnectorError(`Another app already uses the id ${c.id}; rename the catalog entry first.`, 409);
    const all = botRows();
    const want = Array.isArray(body.bots) ? body.bots.map(String) : [];
    const t = JSON.parse(c.template) as Omit<AppConfig, 'id'>;
    const refused = all.filter((b) => want.includes(b.id) && !allowedFor({ ...t, id: c.id }, b));
    if (refused.length) throw new ConnectorError(`${c.name} is only for ${t.onlyBots!.join(', ')}.`, 409);
    const bots = all.filter((b) => want.includes(b.id));
    if (!bots.length) throw new ConnectorError('Pick at least one bot.');
    const details = [
      `Serves ${c.name}${c.machine ? ` on ${c.machine}` : ''} to ${bots.map((b) => b.name).join(', ')}.`,
      t.readOnly ? 'Read only: anything that changes data is blocked.' : 'Reads run on their own; every change asks on a card first.',
      `Other bots stay off; change that any time in each bot's Tools tab.`,
    ];
    return store({ userId, action: 'add', connectorId: c.id, bots: bots.map((b) => b.id), summary: `Add ${c.name} for ${bots.map((b) => b.name).join(', ')}`, details, digest: sha(JSON.stringify(['add', c.id, c.template, bots.map((b) => b.id)])) });
  }
  if (body.action === 'remove') {
    if (!isAdded) throw new ConnectorError(`${c.name} wasn't added from this list (it is set up in apps.json on the server).`, 409);
    return store({ userId, action: 'remove', connectorId: c.id, bots: [], summary: `Remove ${c.name} from every bot`, details: ['Its tools go away for every bot that has it. It stays in the catalog and can be added again.'], digest: sha(JSON.stringify(['remove', c.id])) });
  }
  throw new ConnectorError('Unknown action.');
}

function store(p: Omit<Pending, 'id' | 'expiresAt' | 'status'>): ProposalView {
  for (const [k, v] of pending) if (v.expiresAt < now() - TTL) pending.delete(k);
  const full: Pending = { ...p, id: newId('cch'), expiresAt: now() + TTL, status: 'pending' };
  pending.set(full.id, full);
  return viewOf(full);
}

export function confirmConnector(userId: string, id: string, digest: unknown): ProposalView {
  const p = pending.get(id);
  if (!p || p.userId !== userId) throw new ConnectorError('No such change.', 404);
  if (!isOwner(userId)) throw new ConnectorError('Only the owner of this server can add connectors.', 403);
  if (p.status === 'applied') return viewOf(p);
  if (p.status !== 'pending' || p.expiresAt <= now()) throw new ConnectorError('That change expired or was cancelled. Start again.', 409);
  if (digest !== p.digest) throw new ConnectorError('That change is not the one shown. Start again.', 409);
  if (p.action === 'add') {
    // Check the connector again as it is now: a template, sign-in, firm flag or bot list that changed
    // since the card was made means what you approved is not what would be switched on.
    loadCatalog();
    const c = db.prepare('SELECT * FROM connectors WHERE id=?').get(p.connectorId) as any;
    const changed = () => new ConnectorError('That connector changed after you were shown it; nothing was added. Start again.', 409);
    if (!c || !c.template || c.firm || c.status === 'retired' || c.app_ids) throw changed();
    if (db.prepare('SELECT 1 FROM connector_apps WHERE connector_id=?').get(c.id)) throw new ConnectorError(`${c.name} is already set up.`, 409);
    if (sha(JSON.stringify(['add', c.id, c.template, p.bots])) !== p.digest) throw changed();
    const t = JSON.parse(c.template) as Omit<AppConfig, 'id'>;
    if (!signedIn(t)) throw new ConnectorError(`${c.name} isn't signed in any more. Sign in first.`, 409);
    const all = botRows();
    const bots = all.filter((b) => p.bots.includes(b.id));
    if (bots.length !== p.bots.length || bots.some((b) => !allowedFor({ ...t, id: c.id }, b))) throw changed();
    db.prepare('INSERT INTO connector_apps(connector_id,bots,added_at,added_by) VALUES (?,?,?,?)').run(p.connectorId, JSON.stringify(p.bots), now(), userId);
  } else {
    db.prepare('DELETE FROM connector_apps WHERE connector_id=?').run(p.connectorId);
    db.prepare('DELETE FROM plugin_bots WHERE plugin_id=?').run(p.connectorId);
  }
  audit(userId, `connector-${p.action}`, p.connectorId, null, { bots: p.bots });
  invalidateApps();
  p.status = 'applied';
  return viewOf(p);
}

export function cancelConnector(userId: string, id: string): ProposalView {
  const p = pending.get(id);
  if (!p || p.userId !== userId) throw new ConnectorError('No such change.', 404);
  if (p.status === 'pending') p.status = 'cancelled';
  return viewOf(p);
}
