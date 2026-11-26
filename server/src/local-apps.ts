import { redact } from './lib/redact.js';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { validatePluginCard, type PluginCard } from './plugins/ui-schema.js';
import { headersFileFetch, oauthFetch, oauthProblem, type AppOAuth } from './app-oauth.js';
import { HERMES_MCP_APP, hermesMcpKind } from './hermes-mcp-tools.js';

/**
 * Local apps: MCP servers you run yourself, in place of Composio.
 *
 * Each app is an MCP server listed in apps.json (see apps.example.json): a command this machine
 * starts (stdio) or a URL on this machine (streamable HTTP). Its tools are served to every bot
 * through the app's own /mcp endpoint (mcp.ts) under the name `<app id>__<tool name>`, so the
 * approval cards work the same as before: read-only tools run, anything else asks first, and
 * apps.json can allow, force-ask or block tools by name.
 *
 * Nothing here talks to a hosted service. Sign-in to the app behind each server (Microsoft 365,
 * a case-management system, ...) is that server's own business: it keeps its tokens on this
 * machine.
 *
 * This module does not read env.ts, so it can be loaded on its own (tests/local-apps.mjs).
 */

export interface AppConfig {
  /** Lower-case slug, letters, digits and dashes: becomes the tool-name prefix. */
  id: string;
  name?: string;
  description?: string;
  /** Optional logo URL or data: URI for the app's cards. Leave empty to show the name's initial. */
  logo?: string;
  enabled?: boolean;
  /** stdio: the command that starts the server, its arguments, extra environment and working directory. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Streamable HTTP: the server's URL and any headers (e.g. an Authorization header). */
  url?: string;
  headers?: Record<string, string>;
  /** Streamable HTTP behind an OAuth front: Cleft keeps the token file and refreshes it (app-oauth.ts). */
  oauth?: AppOAuth;
  /** Streamable HTTP: extra headers (keys) read from this JSON file on each request, so they never sit in apps.json or the catalog. */
  headersFile?: string;
  /** A URL that is not on this machine is refused unless this is true (client data would leave it). */
  remote?: boolean;
  /** Tool-name patterns (`*` matches anything) that run without asking. */
  allow?: string[];
  /** Tool-name patterns that always ask, even when the server marks them read-only or the user said "Always allow". */
  ask?: string[];
  /** Tool-name patterns that never run. */
  block?: string[];
  /** Tools the server marks read-only (readOnlyHint) run without asking. Default true. */
  trustReadOnlyHints?: boolean;
  /**
   * Read-only mode: only tools that would run without asking (an `allow` pattern, or a read-only hint)
   * are offered; everything else is blocked outright instead of asking. For servers that can spend
   * money or change a machine, before the owner has agreed to approval cards for their writes.
   */
  readOnly?: boolean;
  /** How long one tool call may take. Default 120 s. */
  timeoutMs?: number;

  // ----- plugin manifest fields (all optional; a plain apps.json entry is a plugin of kind "mcp-app") -----

  /** What sort of plugin this is. Only "mcp-app" (a local MCP server) runs code; see plugins/manifest.ts. */
  kind?: 'mcp-app';
  /** Exact version or full git commit the plugin is pinned to (informational for hand-written entries). */
  version?: string;
  /**
   * Which bots get this plugin by default: bot ids or bot names, or "*" for every bot. A hand-written
   * apps.json entry without this field goes to every bot, as before; a plugin installed through the
   * app goes to none until the owner turns it on. The owner's per-bot switches override this.
   */
  bots?: string[];
  /** At most one bot may have this plugin on (for example a firm-only app that belongs to one bot). */
  exclusive?: boolean;
  /**
   * The only bots that may ever have it (ids or names). Others can't be switched on, whatever the
   * defaults or stored switches say: for host-admin servers that belong to one bot.
   */
  onlyBots?: string[];
  /** Sites the plugin says it talks to (shown to the owner; not enforced here). */
  network?: string[];
  /** Fingerprint (sha256) of the installed package, for plugins installed through the app. */
  digest?: string;
  /** Where the entry came from. Set by the loader, never read from apps.json. */
  origin?: AppOrigin;
}

/** apps.json (hand-written), EXTRA_MCP_SERVERS (folded in from the environment), installed through the app, or added from Connectors. */
export type AppOrigin = 'apps.json' | 'env' | 'installed' | 'catalog';

export interface AppStatus {
  id: string;
  name: string;
  description?: string;
  logo?: string;
  origin: AppOrigin;
  version?: string;
  digest?: string;
  status: 'ready' | 'error' | 'stopped' | 'disabled';
  error?: string;
  tools: number;
  /** Read-only mode (AppConfig.readOnly): writes are blocked, not asked. */
  readOnly: boolean;
  /** Of `tools`, how many run without asking and how many can never run here. */
  reads: number;
  blocked: number;
}

export interface AppTool {
  /** The name bots call it by: `<app id>__<tool name>`. */
  name: string;
  appId: string;
  /** The name the MCP server knows it by. */
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export type AppDecision = 'allow' | 'ask' | 'block';

/**
 * What apps.json says about one tool. `fixed` decisions are not changed by anything the user stored
 * with "Always allow" (block and force-ask); the others give way to a stored choice.
 */
export interface AppRule { decision: AppDecision; fixed: boolean }

interface Conn {
  cfg: AppConfig;
  client: Client | null;
  connecting: Promise<void> | null;
  tools: AppTool[];
  error?: string;
  failedAt?: number;
}

/** The longest an app id may be: it prefixes every tool name, and those are cut at 64 characters. */
export const MAX_APP_ID = 31;
const ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
const RESERVED = new Set(['hermes', 'hq']);
const RETRY_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 60_000;

/** apps.json: APPS_CONFIG (a relative path counts from the repo root), else apps.json in the repo root. */
export function configPath(): string {
  const root = new URL('../../', import.meta.url).pathname;
  return path.resolve(root, process.env.APPS_CONFIG || 'apps.json');
}

let loadedMtime = -1;
let loadedPath = '';
let loadedSources = '';
let configError: string | undefined;
const conns = new Map<string, Conn>();
/** Recent log lines per app (keys removed), newest last: for the admin view (connector-admin.ts). */
const logs = new Map<string, string[]>();
export function noteAppLog(id: string, line: string) {
  const l = logs.get(id) ?? [];
  l.push(`${new Date().toISOString().slice(0, 19)}Z ${redact(line).slice(0, 400)}`);
  if (l.length > 200) l.splice(0, l.length - 200);
  logs.set(id, l);
}
export const appLog = (id: string): string[] => [...(logs.get(id) ?? [])];

/** Bot-facing tool name, lower-cased → the tool. Hermes may fold names to lower case. */
let byName = new Map<string, AppTool>();

/** `${VAR}` in a string, taken from this process's environment, so keys can stay in .env. */
function expand(v: string): string {
  return v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, k: string) => process.env[k] ?? '');
}
const expandAll = (o: Record<string, string> | undefined) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, expand(String(v))]));

export function isLoopback(u: string): boolean {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch {
    return false;
  }
}

/** Problems with one app's entry, or null when it is usable. */
function invalid(c: AppConfig): string | null {
  if (!c || typeof c !== 'object') return 'not an object';
  if (!ID.test(String(c.id ?? ''))) return `id "${c.id}" must be lower-case letters, digits and dashes (up to 31)`;
  if (!c.command === !c.url) return 'needs exactly one of "command" (stdio) or "url" (HTTP)';
  // `hermes__<tool>` names Hermes' own tools in stored approvals (plugins/hermes-gate.ts); `hq` is this server.
  if (RESERVED.has(c.id)) return `id "${c.id}" is reserved`;
  if (c.kind !== undefined && c.kind !== 'mcp-app') return `kind "${c.kind}" is not supported (only "mcp-app")`;
  if (c.readOnly !== undefined && typeof c.readOnly !== 'boolean') return '"readOnly" must be true or false';
  if (c.onlyBots !== undefined && (!Array.isArray(c.onlyBots) || !c.onlyBots.every((b) => typeof b === 'string' && b && b !== '*'))) return '"onlyBots" must be a list of bot ids or names';
  if (c.bots !== undefined && !(Array.isArray(c.bots) && c.bots.every((b) => typeof b === 'string'))) return '"bots" must be a list of bot ids or names';
  if (c.oauth !== undefined) {
    if (!c.url) return '"oauth" is only for "url" apps';
    if (c.origin === 'installed') return 'installed plugins cannot use "oauth"';
    const p = oauthProblem(c.oauth);
    if (p) return p;
    if (!c.remote && !isLoopback(c.oauth.tokenUrl)) return `oauth.tokenUrl ${c.oauth.tokenUrl} is not on this machine; set "remote": true only if that is acceptable`;
  }
  if (c.headersFile !== undefined) {
    if (!c.url) return '"headersFile" is only for "url" apps';
    if (c.origin === 'installed') return 'installed plugins cannot use "headersFile"';
    if (typeof c.headersFile !== 'string' || !c.headersFile) return '"headersFile" must be a file path';
  }
  if (c.url && !c.remote && !isLoopback(expand(c.url))) return `url ${c.url} is not on this machine; set "remote": true only if sending data there is acceptable`;
  return null;
}

// ---------- other sources of apps ----------

/**
 * Apps can come from places other than apps.json: EXTRA_MCP_SERVERS (below) and plugins installed
 * through the app (plugins/registry.ts). A source is a function returning entries; registering one
 * returns a function that removes it again, and everything it added goes away on the next load.
 */
const sources = new Map<string, () => AppConfig[]>();
let sourcesVersion = 0;

export function registerAppSource(name: string, list: () => AppConfig[]): () => void {
  sources.set(name, list);
  sourcesVersion++;
  return () => { if (sources.get(name) === list) { sources.delete(name); sourcesVersion++; } };
}

/** A source's entries changed: pick them up on the next call. */
export function invalidateApps() { sourcesVersion++; }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'server';

/**
 * EXTRA_MCP_SERVERS (Hermes mcp_servers entries as JSON) used to be handed straight to each extra
 * bot's Hermes engine, where nothing asked before a call. They are now served like apps.json entries
 * (as `extra-<name>`), so every call passes the approval check and the per-bot switches.
 */
export function appsFromExtraMcpServers(raw: string | undefined): AppConfig[] {
  if (!raw || !raw.trim()) return [];
  let v: any;
  try { v = JSON.parse(raw); } catch { console.warn('[apps] EXTRA_MCP_SERVERS is not valid JSON; ignored'); return []; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) { console.warn('[apps] EXTRA_MCP_SERVERS must be a JSON object; ignored'); return []; }
  const out: AppConfig[] = [];
  for (const [name, e] of Object.entries<any>(v)) {
    if (!e || typeof e !== 'object') continue;
    out.push({
      id: `extra-${slug(name)}`,
      name,
      description: 'From EXTRA_MCP_SERVERS',
      ...(e.url ? { url: String(e.url), headers: e.headers ?? undefined, remote: e.remote === true } : {}),
      ...(e.command ? { command: String(e.command), args: Array.isArray(e.args) ? e.args.map(String) : [], env: e.env ?? undefined, cwd: e.cwd ?? undefined } : {}),
      ...(typeof e.timeout === 'number' ? { timeoutMs: e.timeout * 1000 } : {}),
      origin: 'env',
    });
  }
  return out;
}

registerAppSource('env', () => appsFromExtraMcpServers(process.env.EXTRA_MCP_SERVERS));

/** (Re)read apps.json and the other sources when something changed. Apps whose entry changed or went away are stopped. */
function load() {
  const file = configPath();
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* no file: no apps */ }
  const extra: AppConfig[] = [];
  for (const [name, list] of sources) {
    try { extra.push(...list()); } catch (e) { console.warn(`[apps] app source ${name} failed: ${(e as Error).message}`); }
  }
  const sourcesSig = `${sourcesVersion}:${JSON.stringify(extra)}`;
  if (file === loadedPath && mtime === loadedMtime && sourcesSig === loadedSources) return;
  loadedPath = file;
  loadedMtime = mtime;
  loadedSources = sourcesSig;
  configError = undefined;
  let list: AppConfig[] = [];
  if (mtime) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      list = Array.isArray(raw) ? raw : Array.isArray(raw?.apps) ? raw.apps : [];
    } catch (e) {
      configError = `apps.json could not be read: ${(e as Error).message}`;
      console.warn(`[apps] ${configError}`);
    }
  }
  // An apps.json entry cannot claim to be something else: its origin is set here.
  list = list.map((c) => (c && typeof c === 'object' ? { ...c, origin: 'apps.json' as const } : c));
  const next = new Map<string, AppConfig>();
  for (const c of [...list, ...extra]) {
    const why = invalid(c);
    if (why) { console.warn(`[apps] skipping ${c?.id ?? '(no id)'}: ${why}`); continue; }
    if (next.has(c.id)) { console.warn(`[apps] skipping a second app with id ${c.id}`); continue; }
    next.set(c.id, c);
  }
  for (const [id, conn] of conns) {
    if (JSON.stringify(next.get(id)) !== JSON.stringify(conn.cfg)) { void close(conn); conns.delete(id); }
  }
  for (const [id, cfg] of next) if (!conns.has(id)) conns.set(id, { cfg, client: null, connecting: null, tools: [] });
  rebuildIndex();
  const fromFile = [...next.values()].filter((c) => c.origin === 'apps.json').length;
  console.log(`[apps] ${next.size} app(s) configured: ${fromFile} from ${file}${mtime ? '' : ' (file not found)'}, ${next.size - fromFile} from other sources`);
}

async function close(conn: Conn) {
  const c = conn.client;
  conn.client = null;
  conn.tools = [];
  if (c) await c.close().catch(() => {});
}

const exposed = (appId: string, tool: string) => `${appId}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

function rebuildIndex() {
  const next = new Map<string, AppTool>();
  for (const conn of conns.values()) {
    for (const t of conn.tools) {
      let name = t.name;
      for (let i = 2; next.has(name.toLowerCase()); i++) name = `${t.name.slice(0, 60)}_${i}`;
      t.name = name;
      next.set(name.toLowerCase(), t);
    }
  }
  byName = next;
}

function transportFor(c: AppConfig): Transport {
  if (c.url) {
    if (c.origin === 'installed') throw new Error('installed plugins run as a local command, not a URL');
    return new StreamableHTTPClientTransport(new URL(expand(c.url)), { requestInit: { headers: expandAll(c.headers) }, ...(c.oauth ? { fetch: oauthFetch(c.oauth, c.headersFile ? headersFileFetch(c.headersFile) : fetch) } : c.headersFile ? { fetch: headersFileFetch(c.headersFile) } : {}) });
  }
  // A plugin installed through the app gets its command exactly as the server built it: no ${VAR}
  // expansion, so nothing in its manifest can pull the server's secrets into its arguments.
  const lit = c.origin === 'installed';
  const x = (v: string) => (lit ? v : expand(v));
  const t = new StdioClientTransport({
    command: x(c.command!),
    args: (c.args ?? []).map(x),
    env: { ...getDefaultEnvironment(), ...(lit ? { ...(c.env ?? {}) } : expandAll(c.env)) },
    cwd: c.cwd ? x(c.cwd) : undefined,
    stderr: 'pipe',
  });
  // The server's own log lines, marked with the app they came from.
  t.stderr?.on('data', (d: Buffer) => {
    for (const line of d.toString('utf8').split('\n')) if (line.trim()) { console.log(`[app:${c.id}] ${redact(line)}`); noteAppLog(c.id, line); }
  });
  return t;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function connect(conn: Conn): Promise<void> {
  if (conn.client) return;
  if (conn.connecting) return conn.connecting;
  if (conn.failedAt && Date.now() - conn.failedAt < RETRY_MS) return;
  const cfg = conn.cfg;
  conn.connecting = (async () => {
    const client = new Client({ name: 'cleft-bot', version: '1.0.0' });
    try {
      await withTimeout(client.connect(transportFor(cfg)), CONNECT_TIMEOUT_MS, `Starting ${cfg.id}`);
      const tools: AppTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), CONNECT_TIMEOUT_MS, `Listing ${cfg.id}'s tools`);
        for (const t of page.tools) {
          tools.push({
            name: exposed(cfg.id, t.name),
            appId: cfg.id,
            tool: t.name,
            description: `[${cfg.name ?? cfg.id}] ${t.description ?? t.title ?? t.name}`.slice(0, 2000),
            inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
            // The Hermes MCP server marks nothing read-only; its reads are sorted here (hermes-mcp-tools.ts).
            readOnly: t.annotations?.readOnlyHint === true || (cfg.id === HERMES_MCP_APP && hermesMcpKind(t.name) === 'read'),
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      // apps.json may have changed while this was starting; then this connection is not wanted any more.
      if (conns.get(cfg.id) !== conn) { await client.close().catch(() => {}); return; }
      client.onclose = () => {
        if (conn.client === client) { conn.client = null; conn.tools = []; rebuildIndex(); }
      };
      conn.client = client;
      conn.tools = tools;
      conn.error = undefined;
      conn.failedAt = undefined;
      rebuildIndex();
      console.log(`[apps] ${cfg.id} ready with ${tools.length} tool(s)`);
      noteAppLog(cfg.id, `ready with ${tools.length} tool(s)`);
    } catch (e) {
      await client.close().catch(() => {});
      conn.error = (e as Error).message;
      conn.failedAt = Date.now();
      console.warn(`[apps] ${cfg.id} failed to start: ${conn.error}`);
      noteAppLog(cfg.id, `failed to start: ${conn.error}`);
    } finally {
      conn.connecting = null;
    }
  })();
  return conn.connecting;
}

/** Start every enabled app that is not running (each at most every 30 s after a failure). */
export async function ensureApps(): Promise<void> {
  load();
  await Promise.all([...conns.values()].filter((c) => c.cfg.enabled !== false).map((c) => connect(c)));
}

/** Every tool of every running app, as the bots see them. */
export async function listAppTools(): Promise<AppTool[]> {
  await ensureApps();
  return [...byName.values()];
}

/** The app tool a bot-facing name stands for, matched case-insensitively. */
export function findAppTool(name: string): AppTool | undefined {
  load();
  return byName.get(name.toLowerCase());
}

/** One app's full entry (as loaded), or undefined. */
export function appConfig(appId: string): AppConfig | undefined {
  load();
  return conns.get(appId)?.cfg;
}

/** Every loaded entry, started or not. */
export function allAppConfigs(): AppConfig[] {
  load();
  return [...conns.values()].map((c) => c.cfg);
}

export function appInfo(appId: string): { id: string; name: string; logo?: string } | undefined {
  load();
  const c = conns.get(appId)?.cfg;
  return c ? { id: c.id, name: c.name ?? c.id, logo: c.logo } : undefined;
}

export async function appsStatus(): Promise<{ apps: AppStatus[]; configFile: string; error?: string }> {
  await ensureApps();
  const apps = [...conns.values()].map(({ cfg, client, tools, error }) => ({
    id: cfg.id,
    name: cfg.name ?? cfg.id,
    description: cfg.description,
    logo: cfg.logo,
    origin: cfg.origin ?? 'apps.json',
    version: cfg.version,
    digest: cfg.digest,
    status: cfg.enabled === false ? 'disabled' as const : client ? 'ready' as const : error ? 'error' as const : 'stopped' as const,
    error,
    tools: tools.length,
    readOnly: cfg.readOnly === true,
    reads: tools.filter((t) => { const r = appRule(t); return r.decision === 'allow'; }).length,
    blocked: tools.filter((t) => { const r = appRule(t); return r.fixed && r.decision === 'block'; }).length,
  }));
  return { apps, configFile: configPath(), error: configError };
}

/** `*` matches anything; matching ignores case. */
export function matches(patterns: string[] | undefined, name: string): boolean {
  return (patterns ?? []).some((p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(name));
}

/**
 * The owner's own choice for one tool, made in Connections (connections.ts keeps them): 'allow' runs it
 * without asking, 'ask' always asks, 'block' switches it off. Set by connections.ts, so this module
 * still loads on its own (tests/local-apps.mjs).
 */
export type ToolOverride = 'allow' | 'ask' | 'block';
let toolOverride: (appId: string, tool: string) => ToolOverride | undefined = () => undefined;
export function setToolOverrides(fn: (appId: string, tool: string) => ToolOverride | undefined) { toolOverride = fn; }

/** What apps.json and the server's own hints say about a tool, before the owner's choice in Connections. */
export function appBaseRule(t: Pick<AppTool, 'appId' | 'tool' | 'readOnly'>): AppRule {
  load();
  const cfg = conns.get(t.appId)?.cfg;
  if (!cfg) return { decision: 'block', fixed: true };
  const rule = baseRule(cfg, t);
  // Read-only mode: anything that would ask is blocked instead, and "Always allow" cannot undo that.
  if (cfg.readOnly && rule.decision === 'ask') return { decision: 'block', fixed: true };
  return rule;
}

/**
 * What a tool does when a bot calls it (before anything the user stored with "Always allow").
 * The owner's choice in Connections can always make a tool stricter (ask, or off). It can make one
 * run without asking only where nothing fixed says otherwise: a blocked tool, a tool that must always
 * ask (sending mail, the Hermes connector's risky tools, an `ask` pattern) and a read-only
 * connection's writes stay as they are.
 */
export function appRule(t: Pick<AppTool, 'appId' | 'tool' | 'readOnly'>): AppRule {
  const base = appBaseRule(t);
  if (base.fixed && base.decision === 'block') return base;
  const o = toolOverride(t.appId, t.tool);
  if (o === 'block') return { decision: 'block', fixed: true };
  if (o === 'ask') return { decision: 'ask', fixed: true };
  if (o === 'allow' && !base.fixed) return { decision: 'allow', fixed: false };
  return base;
}

function baseRule(cfg: AppConfig, t: Pick<AppTool, 'tool' | 'readOnly'>): AppRule {
  if (matches(cfg.block, t.tool)) return { decision: 'block', fixed: true };
  if (matches(cfg.ask, t.tool)) return { decision: 'ask', fixed: true };
  // The Hermes MCP connector's risky tools (owner commands, config, gateway, approvals, dispatch) always ask.
  if (cfg.id === HERMES_MCP_APP && hermesMcpKind(t.tool) === 'risky') return { decision: 'ask', fixed: true };
  // A plugin installed through the app cannot loosen its own rules: its `allow` patterns and its
  // server's read-only hints are not trusted, so every tool asks until the owner says otherwise.
  if (cfg.origin === 'installed') return { decision: 'ask', fixed: false };
  if (matches(cfg.allow, t.tool)) return { decision: 'allow', fixed: false };
  if (t.readOnly && cfg.trustReadOnlyHints !== false) return { decision: 'allow', fixed: false };
  return { decision: 'ask', fixed: false };
}

/**
 * A streamable HTTP server that no longer knows our session id answers 404 with JSON-RPC error -32001
 * "Session not found" (actual-mcp does this after it restarts). The MCP spec says the client must then
 * start a new session. Exported for tests.
 */
export function sessionLost(e: unknown): boolean {
  const m = String((e as any)?.message ?? e ?? '');
  const code = (e as any)?.code;
  return /session not found|unknown session|session (has )?expired|invalid session|re-?initiali[sz]e/i.test(m) || (code === 404 && /streamable http/i.test(m));
}

/** Run one app tool. The output is the tool's text (images and files are described, not passed on). */
export async function callAppTool(t: AppTool, args: Record<string, unknown>): Promise<{ output: string; isError: boolean; card?: PluginCard }> {
  load();
  const conn = conns.get(t.appId);
  if (!conn || conn.cfg.enabled === false) return { output: `The app "${t.appId}" is not set up any more.`, isError: true };
  await connect(conn);
  if (!conn.client) return { output: `The app "${conn.cfg.name ?? t.appId}" is not running${conn.error ? `: ${conn.error}` : ''}.`, isError: true };
  let r: any;
  try {
    r = await conn.client.callTool({ name: t.tool, arguments: args }, undefined, { timeout: conn.cfg.timeoutMs ?? 120_000 });
  } catch (e) {
    // The app's server forgot our session (it restarted, or dropped an idle one). It refused the call
    // before running it, so connect again and send the same call once more.
    if (!sessionLost(e)) {
      noteAppLog(t.appId, `${t.tool} failed: ${(e as Error).message}`);
      throw e;
    }
    noteAppLog(t.appId, `session lost on ${t.tool}; reconnecting and trying once more`);
    console.warn(`[apps] ${t.appId}: session lost; reconnecting`);
    await close(conn);
    conn.failedAt = undefined;
    rebuildIndex();
    await connect(conn);
    if (!conn.client) return { output: `The app "${conn.cfg.name ?? t.appId}" lost its connection and could not reconnect${conn.error ? `: ${conn.error}` : ''}.`, isError: true };
    try {
      r = await conn.client.callTool({ name: t.tool, arguments: args }, undefined, { timeout: conn.cfg.timeoutMs ?? 120_000 });
    } catch (e2) {
      noteAppLog(t.appId, `${t.tool} failed after reconnecting: ${(e2 as Error).message}`);
      throw e2;
    }
  }
  if (r?.isError === true) noteAppLog(t.appId, `${t.tool} returned an error: ${String(r.content?.find((c: any) => c?.type === 'text')?.text ?? '').slice(0, 300)}`);
  const parts: string[] = [];
  for (const c of r.content ?? []) {
    if (c?.type === 'text') parts.push(String(c.text));
    else if (c?.type === 'resource') parts.push(typeof c.resource?.text === 'string' ? c.resource.text : `[file: ${c.resource?.uri ?? 'unnamed'}]`);
    else if (c?.type === 'resource_link') parts.push(`[link: ${c.uri}${c.name ? ` (${c.name})` : ''}]`);
    else if (c?.type === 'image' || c?.type === 'audio') parts.push(`[${c.type}: ${c.mimeType ?? 'unknown type'}]`);
  }
  // A card for the conversation (plugins/ui-schema.ts): shown as data, never run. A bad one is dropped.
  let card: PluginCard | undefined;
  const raw = r.structuredContent?.cleftbot_card;
  if (raw !== undefined) {
    const v = validatePluginCard(raw);
    if (v.ok) card = v.value;
    else console.warn(`[apps] ${t.appId} sent a card that was not shown: ${v.error}`);
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  if (!parts.length && r.toolResult !== undefined) parts.push(JSON.stringify(r.toolResult));
  let output = parts.join('\n\n') || '(no output)';
  if (output.length > MAX_OUTPUT) output = `${output.slice(0, MAX_OUTPUT)}…(truncated)`;
  return { output, isError: r.isError === true, ...(card ? { card } : {}) };
}

/** Problems with an entry (null when usable), as the loader sees them: for changes proposed by a bot. */
export function checkAppEntry(c: AppConfig): string | null { return invalid({ ...c, origin: 'apps.json' }); }

/** Drop an app's connection and connect again, so its tools are listed afresh (after its server changed). */
export async function reconnectApp(id: string): Promise<{ ok: boolean; tools: number; error?: string }> {
  load();
  const conn = conns.get(id);
  if (!conn) return { ok: false, tools: 0, error: `No app called ${id}.` };
  await close(conn);
  conn.failedAt = undefined;
  conn.error = undefined;
  rebuildIndex();
  noteAppLog(id, 'reconnecting (asked for a restart)');
  if (conn.cfg.enabled === false) return { ok: true, tools: 0 };
  await connect(conn);
  return { ok: !!conn.client, tools: conn.tools.length, ...(conn.error ? { error: conn.error } : {}) };
}

/** One app's tools as listed by its server (empty when it is not running). */
export function appTools(id: string): AppTool[] { load(); return [...(conns.get(id)?.tools ?? [])]; }

/** Stop every app (on shutdown). */
export async function stopApps(): Promise<void> {
  await Promise.all([...conns.values()].map(close));
}
