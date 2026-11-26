import { redact } from './lib/redact.js';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { displayFor } from './box.js';
import { cdpUrlFor, screenFor } from './computer.js';
import { db } from './db.js';
import { env } from './env.js';
import { installGate } from './plugins/hermes-gate.js';
import { libraryRoot } from './paths.js';
import { isSilo, siloFor, siloKey } from './silo.js';
import { isOutside } from './outside.js';
import type { EngineInfo, EngineProvider } from './types.js';
import { suggestTiers, cleanTiers } from './model-router.js';
import { lastRoute } from './model-choice.js';
import { applyWebConfig, primarySearchEnv } from './web-search.js';
import { primaryRestartNote, sharedAnthropicKey, syncPrimaryProviders, type PrimarySync } from './primary-providers.js';
import {
  applyProviderConfig, CATALOG, catalogEntry, isolateAnthropicEnv, parseFallbacks, providerStatuses, readFallbacks, SUBSCRIPTION, upsertPoolKey,
  type CheckRow, type HermesProvider, type TurnRow,
} from './provider-catalog.js';

/**
 * Every bot is run by a Hermes agent.
 *
 * - The 'primary' engine is a Hermes gateway that already runs on the computer (HERMES_URL, home
 *   HERMES_HOME_PRIMARY). It has its own life: messaging, memory, model. We only talk to its API
 *   server; we never write its config, restart it or stop it.
 * - A 'managed' engine is a Hermes home of our own under ENGINES_DIR/<botId> with its own
 *   `hermes gateway run`, started here and left running when this server exits. Its home sits
 *   outside ~/.hermes, so Hermes treats it as a separate tenant beside the primary gateway.
 * - A 'silo' engine is a Hermes agent inside a container (silo.ts, silo/sheldon/). We only call its
 *   API. Nothing of the primary agent (sign-ins, keys, model settings) is copied to it, and its home
 *   is never written, restarted or deleted from here.
 */

export type EngineKind = 'primary' | 'managed' | 'silo';
export interface Engine { kind: EngineKind; url: string; key: string; home: string }

const botRow = (botId: string) => db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as any;
/** A side chat (side-chats.ts) runs on its bot's engine: never one of its own. */
const ownerOf = (botId: string): string => (db.prepare('SELECT side_of FROM bots WHERE id=?').get(botId) as any)?.side_of ?? botId;

// ---------- small file helpers ----------

/** KEY=value lines of a dotenv file (quotes stripped). Missing file = {}. */
function readDotenv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function readYaml(file: string): any {
  try { return YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}

function writePrivate(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// ---------- identity ----------

/** Token a bot's Hermes agent presents to this server's MCP endpoint. `primary` names the primary bot. */
export function mcpToken(botId: string): string {
  return crypto.createHmac('sha256', env.sessionSecret).update(`mcp:${botId}`).digest('hex');
}

export function primaryBotId(): string | null {
  return (db.prepare("SELECT id FROM bots WHERE engine='primary' LIMIT 1").get() as any)?.id ?? null;
}

export function engineKind(botId: string): EngineKind | null {
  botId = ownerOf(botId);
  if (isOutside(botId)) return null; // lives elsewhere; reached through its link (slack-link.ts)
  if (isSilo(botId)) return 'silo';
  const e = botRow(botId)?.engine;
  return e === 'primary' || e === 'managed' ? e : null;
}

const homeFor = (botId: string) => path.join(env.enginesDir, botId);

let cachedPrimaryKey: string | null = null;
function primaryKey(): string {
  if (env.hermesKey) return env.hermesKey;
  if (cachedPrimaryKey === null) cachedPrimaryKey = readDotenv(path.join(env.hermesHome, '.env')).API_SERVER_KEY ?? '';
  return cachedPrimaryKey;
}

// ---------- assignment ----------

function freePort(): number {
  const used = new Set((db.prepare('SELECT engine_port FROM bots WHERE engine_port IS NOT NULL').all() as any[]).map((r) => r.engine_port as number));
  let p = env.enginePortBase;
  while (used.has(p)) p++;
  return p;
}

/**
 * Whether this account's bots may be bound to the primary engine. That agent is the owner's own:
 * its memory, its messaging accounts and the computer's main screen come with it, so it goes to
 * OWNER_EMAIL only. Without OWNER_EMAIL any account qualifies while the app is local (development,
 * where whoever signs in is the developer) and none does on a public URL. How somebody signed in
 * does not count: the owner key also lets guests in.
 */
export function mayUsePrimary(userId: string): boolean {
  const email = String((db.prepare('SELECT email FROM users WHERE id=?').get(userId) as any)?.email ?? '').toLowerCase();
  return env.ownerEmail ? email === env.ownerEmail : env.localOnly;
}

/**
 * Give a new agent bot its engine: the existing agent if nobody has it and the bot belongs to the
 * owner, otherwise one of our own. A free primary engine (never bound, or its bot was deleted) so
 * waits for the owner's next bot instead of going to whoever creates one first.
 */
export function assignEngine(botId: string): EngineKind | null {
  botId = ownerOf(botId);
  const b = botRow(botId);
  if (!b) throw new Error('bot not found');
  if (isOutside(botId)) return null;
  if (isSilo(botId)) return 'silo';
  if (b.engine === 'primary' || b.engine === 'managed') return b.engine;
  if (!primaryBotId() && mayUsePrimary(b.user_id)) {
    db.prepare("UPDATE bots SET engine='primary', engine_port=NULL WHERE id=?").run(botId);
    return 'primary';
  }
  db.prepare("UPDATE bots SET engine='managed', engine_port=? WHERE id=?").run(freePort(), botId);
  return 'managed';
}

// ---------- a managed bot's Hermes home ----------

/**
 * Model credentials a managed agent may inherit from the primary agent. Never messaging tokens, and
 * never a rotating OAuth token (ANTHROPIC_TOKEN, CLAUDE_CODE_OAUTH_TOKEN): two agents refreshing one
 * grant sign each other out. The Anthropic key does not stay in the environment either; it goes into
 * the bot's credential pool (provider-catalog.ts), so the Claude subscription route can run beside it.
 */
const SHARED_ENV = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'NOUS_API_KEY',
  'FIRECRAWL_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'PARALLEL_API_KEY',
];

/**
 * Parts of the primary agent's config a managed agent starts from, so it reaches the same models. Its
 * fallback chain is not among them: a bot's fallbacks are only what is set for that bot in the app.
 */
const SHARED_CONFIG = ['model', 'providers', 'custom_providers', 'auxiliary'];

/**
 * Tools before the browser (Alex, 2026-11-23). It is in the persona, not only in the
 * connectors-first skill, because a bot in a long chat acts on what it saw fail earlier in that chat
 * without loading the skill again.
 */
const TOOLS_FIRST = '\nUse your connected tools (named like google__search_gmail_messages) before your browser. If a connected tool covers the job but fails, retry it once, then tell your person in one line which connector failed and why; do not switch to the website instead. Your browser is for jobs that no connected tool covers.';

/**
 * Email (Alex, 2026-11-23): a bot may send mail, but only through the send tool, which puts the whole
 * email on a card in its chat; nothing goes until a person reads it and presses Send there.
 */
const MAIL = "\nYou may send email for your person when they ask, with your connected mail tool (for example google__send_gmail_message). Each send puts the whole email on a card in this chat, and nothing goes until your person reads it and presses Send. Write the email in full in the tool call, never send without being asked, and never say an email was sent unless the tool's result says it was.";

/** Persona lines added over time: 0 = none, 1 = tools first, 2 = and email. Old personas we wrote are upgraded. */
const SOUL_LEVEL = 2;

function soul(b: any, level = SOUL_LEVEL): string {
  const owner = (db.prepare('SELECT name FROM users WHERE id=?').get(b.user_id) as any)?.name ?? 'the user';
  const role = b.label ? `, ${b.label}` : '';
  return [
    `You are ${b.name}${role}. You work for ${owner} as one of a small team of AI agents, each with its own screen on a shared computer.`,
    b.description ? `\n${b.description}` : '',
    '\nYou are direct, warm and brief. You do the work rather than describe it, and you say plainly what you did and what you could not do.',
    level >= 1 ? TOOLS_FIRST : null,
    level >= 2 ? MAIL : null,
    '',
  ].filter((l) => l !== null).join('\n');
}

/** Rewrite the persona file after a rename or a new description. The primary agent keeps its own. */
export function syncPersona(botId: string) {
  const b = botRow(botId);
  if (!b || b.engine !== 'managed' || isSilo(botId) || isOutside(botId)) return;
  const home = homeFor(botId);
  if (!fs.existsSync(home)) return;
  fs.writeFileSync(path.join(home, 'SOUL.md'), soul(b));
}

/**
 * Names of the EXTRA_MCP_SERVERS entries. They used to be written into each managed bot's Hermes
 * config, where their calls skipped the approval check; they are now served through /mcp like the
 * apps in apps.json (local-apps.ts), so old copies are taken out of the config here.
 */
function extraMcpServerNames(): string[] {
  if (!env.extraMcpServers) return [];
  try {
    const v = JSON.parse(env.extraMcpServers);
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
  } catch {
    return [];
  }
}

/**
 * Point a Hermes config's default model at the bot's chosen provider and model. Hermes resolves the
 * config's default route before it applies the provider and model sent with a turn (v0.23.3,
 * gateway/run_turn_runner.py: _resolve_session_agent_runtime, then prepare_api_runtime), so a default
 * provider the bot is not signed in to fails the turn ("No Codex credentials stored") whatever the
 * turn asked for. Endpoint settings of another provider (base_url, api_mode, context_length) are
 * dropped when the provider changes. Returns true when anything changed. Pure: exported for tests.
 */
export function applyModelToConfig(cfg: any, provider: string | null, model: string | null): boolean {
  if (!provider) return false;
  const cur = cfg.model;
  const block: Record<string, any> = cur && typeof cur === 'object' && !Array.isArray(cur) ? { ...cur } : typeof cur === 'string' && cur ? { default: cur } : {};
  const before = JSON.stringify(block);
  if (block.provider !== provider) {
    for (const k of ['base_url', 'api_mode', 'context_length', 'api_key']) delete block[k];
    if (!model) delete block.default;
    block.provider = provider;
  }
  if (model) { block.default = model; delete block.model; }
  if (JSON.stringify(block) === before) return false;
  cfg.model = block;
  return true;
}

/**
 * After a model change in the app: write it into a managed bot's config.yaml. The primary agent's
 * config is the owner's own Hermes setup and a siloed bot's lives in its container, so neither is
 * touched. Returns whether the provider in the config changed (Hermes then needs a restart).
 */
export function syncEngineModel(botId: string): { written: boolean; providerChanged: boolean } {
  const b = botRow(botId);
  if (!b || engineKind(botId) !== 'managed') return { written: false, providerChanged: false };
  const cfgFile = path.join(homeFor(botId), 'config.yaml');
  if (!fs.existsSync(cfgFile)) return { written: false, providerChanged: false };
  const cfg = readYaml(cfgFile);
  const oldProvider = cfg.model && typeof cfg.model === 'object' ? cfg.model.provider ?? null : null;
  if (!applyModelToConfig(cfg, b.provider ?? null, b.model ?? null)) return { written: false, providerChanged: false };
  try { fs.copyFileSync(cfgFile, `${cfgFile}.bak`); } catch { /* best effort */ }
  writePrivate(cfgFile, YAML.stringify(cfg));
  optionsCache.delete(botId);
  return { written: true, providerChanged: oldProvider !== (b.provider ?? null) };
}

// ---------- the shared provider catalog (provider-catalog.ts) ----------

/** Bump when what writeHome does for providers changes, so running agents pick it up (provider-refresh.ts). */
const PROVIDER_SETUP_VERSION = 1;

/** The version line of a plugin folder's plugin.yaml, or null. */
function pluginVersion(dir: string): string | null {
  try { return /^version:\s*(\S+)/m.exec(fs.readFileSync(path.join(dir, 'plugin.yaml'), 'utf8'))?.[1] ?? null; } catch { return null; }
}

/** The model-provider plugins the server offers every managed bot (folder name -> version). */
export function sharedProviderPlugins(): Record<string, string> {
  const out: Record<string, string> = {};
  let names: string[] = [];
  try { names = fs.readdirSync(env.providerPluginsDir); } catch { return out; }
  for (const n of names) {
    if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(n)) continue;
    const v = pluginVersion(path.join(env.providerPluginsDir, n));
    if (v) out[n] = v;
  }
  return out;
}

/**
 * Give a bot's home the server's copy of each model-provider plugin, replacing an older version. Code
 * only: a plugin holds no credentials. Hermes finds model-provider plugins in its plugins folder by itself.
 */
function syncProviderPlugins(home: string) {
  for (const [name, version] of Object.entries(sharedProviderPlugins())) {
    const dest = path.join(home, 'plugins', name);
    if (pluginVersion(dest) === version) continue;
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(path.join(env.providerPluginsDir, name), dest, { recursive: true, filter: (src) => !src.includes(`${path.sep}__pycache__`) && !src.includes(`${path.sep}.git`) });
      console.log(`[engine] provider plugin ${name} ${version} put in ${path.basename(home)}`);
    } catch (e: any) {
      console.warn(`[engine] could not copy provider plugin ${name}: ${e?.message ?? e}`);
    }
  }
}

/** Whether a bot's home has the subscription plugin. */
function hasSubscriptionPlugin(botId: string): boolean {
  const home = engineHome(botId);
  return !!home && !!pluginVersion(path.join(home, 'plugins', SUBSCRIPTION));
}

/**
 * After a provider change in the app for the owner's own agent (Howard): write it into that agent's Hermes
 * home, with a backup and an audit line, and mark a restart for when it is idle (primary-providers.ts).
 * `model` = the default provider or model was changed in this request; otherwise the default is left as it is.
 */
export function syncPrimaryEngine(botId: string, o: { model: boolean; actor: string }): PrimarySync | null {
  const b = botRow(botId);
  if (!b || engineKind(botId) !== 'primary') return null;
  const r = syncPrimaryProviders(b, { ...o, applyModel: applyModelToConfig });
  optionsCache.delete(botId);
  return r;
}

/**
 * A bot's fallback chain. Set in the app it is exactly that; never set, the chain its Hermes config holds
 * now is adopted (and saved) once, so an existing chain is kept and becomes visible. A new bot starts with none.
 */
function fallbacksFor(b: any, cfg: any) {
  const set = parseFallbacks(b.fallbacks);
  if (set) return set;
  const adopted = readFallbacks(cfg);
  db.prepare('UPDATE bots SET fallbacks=? WHERE id=? AND fallbacks IS NULL').run(JSON.stringify(adopted), b.id);
  return adopted;
}

/**
 * What a running agent's provider setup was made from. A change (a new shared key, the subscription
 * switched, a new plugin, a newer setup) needs the agent restarted; provider-refresh.ts does that when idle.
 * Only hashes: no key is written anywhere by this.
 */
export function providerFingerprint(botId: string): string {
  const b = botRow(botId);
  const key = sharedAnthropicKey();
  return crypto.createHash('sha256').update(JSON.stringify({
    v: PROVIDER_SETUP_VERSION, key: key ? crypto.createHash('sha256').update(key).digest('hex') : '',
    sub: !!b?.claude_subscription, login: env.claudeLoginDir, bin: env.claudeCodeBin, plugins: sharedProviderPlugins(),
  })).digest('hex').slice(0, 32);
}

/** The fingerprint the running agent was started with, or null (started before this existed). */
export function startedProviderFingerprint(botId: string): string | null {
  try { return fs.readFileSync(path.join(homeFor(botId), '.hq-provider-fp'), 'utf8').trim() || null; } catch { return null; }
}

/**
 * After a fallback or subscription change in the app: write it into a managed bot's config.yaml.
 * Hermes re-reads the fallback chain before each new agent, so that needs no restart; the subscription
 * switch changes the plugin's login setting, which does (returned as `restart`).
 */
export function syncEngineProviders(botId: string): { written: boolean; restart: boolean } {
  const b = botRow(botId);
  if (!b || engineKind(botId) !== 'managed') return { written: false, restart: false };
  const home = homeFor(botId);
  const cfgFile = path.join(home, 'config.yaml');
  if (!fs.existsSync(home)) return { written: false, restart: false };
  syncProviderPlugins(home); // code only; the restart below makes the agent load it
  if (!fs.existsSync(cfgFile)) return { written: false, restart: startedProviderFingerprint(botId) !== providerFingerprint(botId) };
  const cfg = readYaml(cfgFile);
  const before = JSON.stringify(cfg);
  applyProviderConfig(cfg, { fallbacks: fallbacksFor(b, cfg), subscriptionOn: !!b.claude_subscription, loginDir: env.claudeLoginDir, offDir: path.join(home, 'no-claude-login') });
  const written = JSON.stringify(cfg) !== before;
  if (written) {
    try { fs.copyFileSync(cfgFile, `${cfgFile}.bak`); } catch { /* best effort */ }
    writePrivate(cfgFile, YAML.stringify(cfg));
    optionsCache.delete(botId);
  }
  return { written, restart: startedProviderFingerprint(botId) !== providerFingerprint(botId) };
}

/**
 * The skills every bot should share (env.sharedSkillsDir, e.g. household/gbrain-shared-memory): each one
 * is copied into the bot's skills folder once. A copy the bot already has is never overwritten, and one
 * that was removed from a bot on purpose is not put back: skills/.shared-installed lists what was given.
 */
export function installSharedSkills(botId: string, home: string): string[] {
  const src = env.sharedSkillsDir;
  if (!src || !fs.existsSync(src)) return [];
  const ledger = path.join(home, 'skills', '.shared-installed');
  const given = new Set(fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : []);
  const added: string[] = [];
  for (const cat of fs.readdirSync(src, { withFileTypes: true })) {
    if (!cat.isDirectory() || cat.name.startsWith('.')) continue;
    for (const sk of fs.readdirSync(path.join(src, cat.name), { withFileTypes: true })) {
      const rel = `${cat.name}/${sk.name}`;
      if (!sk.isDirectory() || sk.name.startsWith('.') || given.has(rel)) continue;
      if (!fs.existsSync(path.join(src, rel, 'SKILL.md'))) continue;
      const dest = path.join(home, 'skills', rel);
      try {
        if (!fs.existsSync(dest)) { fs.cpSync(path.join(src, rel), dest, { recursive: true }); added.push(rel); }
        given.add(rel);
      } catch (e: any) { console.warn(`[engine] ${botId}: could not add shared skill ${rel}: ${e?.message ?? e}`); }
    }
  }
  if (given.size) { fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.writeFileSync(ledger, [...given].sort().join('\n') + '\n'); }
  if (added.length) console.log(`[engine] ${botId}: shared skills added: ${added.join(', ')}`);
  return added;
}

/** Create or refresh the home. config.yaml is created once; after that only the keys we own are patched. */
async function writeHome(botId: string): Promise<{ home: string; key: string; display: string | null }> {
  const b = botRow(botId);
  const home = homeFor(botId);
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'locks'), { recursive: true });
  fs.chmodSync(home, 0o700);
  installSharedSkills(botId, home);

  // Its screen decides which display and which Chrome it drives. Only meaningful on the computer itself.
  let display: string | null = null;
  let cdp = '';
  if (env.localBox) {
    try {
      const s = await screenFor(b.user_id, botId);
      display = displayFor(s.screenId);
      cdp = cdpUrlFor(botId, s.screenId);
    } catch (e: any) {
      console.warn(`[engine] no screen for ${b.name} yet: ${e?.message ?? e}`);
    }
  }

  const cwd = env.localBox ? `${libraryRoot()}/${botId}` : path.join(home, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });

  const cfgFile = path.join(home, 'config.yaml');
  const fresh = !fs.existsSync(cfgFile);
  const cfg = fresh ? {} : readYaml(cfgFile);
  if (fresh) {
    const primary = readYaml(path.join(env.hermesHome, 'config.yaml'));
    for (const k of SHARED_CONFIG) if (primary[k] !== undefined) cfg[k] = primary[k];
    cfg.agent = { reasoning_effort: 'medium' };
    // Sign-ins (ChatGPT, Nous) are the owner's own and are not copied, so a new bot cannot start on the
    // owner's sign-in route. It starts on the app's default for new bots instead, saved as its own
    // choice so settings show it (NEW_BOT_PROVIDER / NEW_BOT_MODEL).
    const from = typeof primary.model === 'object' ? primary.model?.provider : null;
    if (b && !b.provider && catalogEntry(String(from ?? ''))?.route === 'sign_in' && env.newBotProvider) {
      db.prepare('UPDATE bots SET provider=?, model=? WHERE id=? AND provider IS NULL').run(env.newBotProvider, env.newBotModel || null, botId);
      b.provider = env.newBotProvider; b.model = env.newBotModel || null;
      console.log(`[engine] ${b.name} starts on ${env.newBotProvider}${env.newBotModel ? ` / ${env.newBotModel}` : ''}: the owner's ${from} sign-in is not shared with bots`);
    }
  }
  // The model the app has chosen for this bot is Hermes' default route too (see applyModelToConfig).
  applyModelToConfig(cfg, b.provider ?? null, b.model ?? null);
  cfg.platform_toolsets = { ...(cfg.platform_toolsets ?? {}), api_server: ['hermes-api-server', ...(display ? ['computer_use'] : [])] };
  cfg.terminal = { ...(cfg.terminal ?? {}), cwd };
  // Web search by API, the primary agent's service and settings, unless the owner switched it off (web-search.ts).
  applyWebConfig(cfg, botId);
  if (cdp) cfg.browser = { ...(cfg.browser ?? {}), cdp_url: cdp };
  const servers = { ...(cfg.mcp_servers ?? {}) };
  for (const name of extraMcpServerNames()) if (name !== 'hq') delete servers[name];
  cfg.mcp_servers = {
    ...servers,
    hq: { url: `${env.mcpBaseUrl}/mcp/${botId}`, headers: { Authorization: `Bearer ${mcpToken(botId)}` }, timeout: 1800, connect_timeout: 30 },
  };
  // Hermes' own tools (terminal, files, browser, ...) ask this server first, through our gate plugin
  // (plugins/hermes-gate.ts). approvals.timeout covers the 25 minutes an approval card waits, so
  // Hermes does not give up on a tool while the owner is still deciding.
  if (env.hermesGate) {
    const gate = installGate(home, `${env.mcpBaseUrl}/mcp/${botId}/gate`, mcpToken(botId));
    const plugins = { ...(cfg.plugins ?? {}) };
    plugins.enabled = [...new Set([...(Array.isArray(plugins.enabled) ? plugins.enabled : []), gate])];
    if (Array.isArray(plugins.disabled)) plugins.disabled = plugins.disabled.filter((p: string) => p !== gate);
    cfg.plugins = plugins;
    cfg.approvals = { ...(cfg.approvals ?? {}), timeout: Math.max(Number(cfg.approvals?.timeout) || 0, 1560) };
    // Hermes bounds a pre_tool_call hook to plugins.hook_callback_timeout (30 s by default). Our gate waits
    // on a person, so after 30 s Hermes gave up on it and, for the next 60 s, refused every tool the bot
    // tried, the app's own included ("pre_tool_call plugin callback timed out or is still running";
    // Leonard 2026-11-23, and Howard before). 0 runs hooks inline with no limit; the gate has its
    // own (gate.json, 26 min) and the card's 25 minutes come first. Managed homes load only the app's own plugins.
    cfg.plugins.hook_callback_timeout = 0;
  }
  // The shared provider catalog: this bot's fallback chain, the Claude subscription opt-in, and the
  // model-provider plugins every bot gets (provider-catalog.ts).
  syncProviderPlugins(home);
  applyProviderConfig(cfg, { fallbacks: fallbacksFor(b, cfg), subscriptionOn: !!b.claude_subscription, loginDir: env.claudeLoginDir, offDir: path.join(home, 'no-claude-login') });
  writePrivate(cfgFile, YAML.stringify(cfg));

  // A persona we wrote before the newer lines is brought up to date; a hand-edited one is left alone.
  const soulFile = path.join(home, 'SOUL.md');
  const current = fs.existsSync(soulFile) ? fs.readFileSync(soulFile, 'utf8') : null;
  const ours = Array.from({ length: SOUL_LEVEL }, (_, i) => soul(b, i));
  if (current === null || ours.includes(current)) fs.writeFileSync(soulFile, soul(b));

  // Sign-ins live in auth.json and are each bot's own. A new bot starts with none: copying the primary
  // agent's would hand it the owner's rotating OAuth grants (ChatGPT and the like), and two agents
  // refreshing one grant sign each other out.
  const auth = path.join(home, 'auth.json');

  // .env is ours entirely: the API server plus inherited model keys. Keys the user added by hand are kept.
  const envFile = path.join(home, '.env');
  const mine = readDotenv(envFile);
  const key = mine.API_SERVER_KEY || crypto.randomBytes(24).toString('hex');
  const primaryEnv = readDotenv(path.join(env.hermesHome, '.env'));
  const vars: Record<string, string> = { ...mine };
  for (const k of SHARED_ENV) {
    const v = primaryEnv[k] ?? process.env[k];
    if (v && !vars[k]) vars[k] = v;
  }
  // The search key follows the primary agent's, so a new key reaches every bot on its next start.
  Object.assign(vars, primarySearchEnv());
  Object.assign(vars, { API_SERVER_ENABLED: 'true', API_SERVER_KEY: key, API_SERVER_PORT: String(b.engine_port), API_SERVER_HOST: '127.0.0.1' });
  if (cdp) vars.BROWSER_CDP_URL = cdp; else delete vars.BROWSER_CDP_URL;
  // Nothing the Claude subscription plugin refuses stays in the environment; the API key moves to the
  // credential pool, where Hermes' Anthropic route finds it and Claude Code never sees it. The newest
  // shared key wins, so a rotated key reaches every bot on its next start.
  const iso = isolateAnthropicEnv(vars);
  const apiKey = sharedAnthropicKey() || iso.apiKey;
  const clean = iso.vars;
  // The subscription plugin's login comes only from its per-bot setting (applyProviderConfig).
  delete clean.CLAUDE_CONFIG_DIR; delete clean.CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR;
  if (env.claudeCodeBin) clean.CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND = env.claudeCodeBin; else delete clean.CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND;
  writePrivate(envFile, Object.entries(clean).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  let store: any = {};
  try { store = JSON.parse(fs.readFileSync(auth, 'utf8')); } catch { /* none yet */ }
  if (upsertPoolKey(store, apiKey) || !fs.existsSync(auth)) writePrivate(auth, JSON.stringify(store, null, 2) + '\n');
  try { fs.writeFileSync(path.join(home, '.hq-provider-fp'), providerFingerprint(botId)); } catch { /* best effort */ }

  return { home, key, display };
}

// ---------- a managed bot's gateway ----------

async function healthy(url: string, timeoutMs = 2500): Promise<any | null> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function keyAccepted(url: string, key: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/v1/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

/** The gateway's pid, but only if the pid file belongs to this home and the process is alive. */
function gatewayPid(home: string): number | null {
  let raw = '';
  try { raw = fs.readFileSync(path.join(home, 'gateway.pid'), 'utf8').trim(); } catch { return null; }
  let pid = NaN;
  try {
    const j = JSON.parse(raw);
    if (typeof j === 'number') pid = j;
    else {
      if (j?.hermes_home && path.resolve(j.hermes_home) !== path.resolve(home)) return null;
      pid = Number(j?.pid);
    }
  } catch { pid = Number(raw); }
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try { process.kill(pid, 0); } catch { return null; }
  try {
    if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('gateway')) return null;
  } catch { /* no /proc: trust the pid file */ }
  return pid;
}

async function stopGateway(botId: string) {
  const home = homeFor(botId);
  const pid = gatewayPid(home);
  if (!pid) return;
  const signal = (sig: NodeJS.Signals) => {
    try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } }
  };
  signal('SIGTERM');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { process.kill(pid, 0); } catch { return; }
  }
  signal('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
}

const starting = new Map<string, Promise<void>>();
const failures = new Map<string, string>();
const keys = new Map<string, string>();

function managedUrl(botId: string): string {
  return `http://127.0.0.1:${botRow(botId).engine_port}`;
}

function managedKey(botId: string): string {
  let k = keys.get(botId);
  if (!k) {
    k = readDotenv(path.join(homeFor(botId), '.env')).API_SERVER_KEY ?? '';
    if (k) keys.set(botId, k);
  }
  return k;
}

async function startGateway(botId: string): Promise<void> {
  const b = botRow(botId);
  if (!b || b.engine !== 'managed') throw new Error('not a managed engine');
  if (!b.engine_port) db.prepare('UPDATE bots SET engine_port=? WHERE id=?').run(freePort(), botId);
  const url = managedUrl(botId);

  // A gateway from an earlier run of this server is still good: use it as it is.
  if ((await healthy(url)) && managedKey(botId) && (await keyAccepted(url, managedKey(botId)))) return;
  if (await healthy(url)) {
    if (gatewayPid(homeFor(botId))) await stopGateway(botId);
    else throw new Error(`Port ${botRow(botId).engine_port} is taken by something else.`);
  }

  const { home, key, display } = await writeHome(botId);
  keys.set(botId, key);
  if (gatewayPid(home)) await stopGateway(botId);

  const log = fs.openSync(path.join(home, 'logs', 'gateway.out.log'), 'a');
  const child = spawn(env.hermesBin, ['gateway', 'run', '--no-supervise'], {
    cwd: home,
    detached: true,
    stdio: ['ignore', log, log],
    // Only what the agent needs. None of this server's secrets, and nothing of the primary agent's messaging.
    env: {
      PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: process.env.HOME ?? '/root',
      USER: process.env.USER ?? 'root',
      LANG: process.env.LANG ?? 'C.UTF-8',
      HERMES_HOME: home,
      HERMES_GATEWAY_LOCK_DIR: path.join(home, 'locks'),
      // Hermes' browser tool talks to a helper process it finds under this folder. With the default
      // (one folder per HOME) every agent on the computer would end up driving the same browser.
      BH_HOME: path.join(home, 'browser-harness'),
      ...(display ? { DISPLAY: display } : {}),
      // Behind a proxy or a TLS-inspecting firewall the agent needs the same network settings as this server
      // (its first start installs Python packages).
      ...networkEnv(),
    },
  });
  fs.closeSync(log);
  let exited: string | null = null;
  child.once('error', (e) => { exited = `could not run ${env.hermesBin}: ${e.message}`; });
  child.once('exit', (code) => { exited = `the agent stopped while starting (exit ${code}). See ${path.join(home, 'logs', 'gateway.out.log')}`; });
  child.unref();

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (exited) throw new Error(exited);
    if (await healthy(url, 1500)) {
      console.log(`[engine] ${b.name}: gateway up on ${url}`);
      return;
    }
  }
  throw new Error('The agent did not come up within 90 seconds.');
}

/** Once a managed bot's agent is up, give it its Auto tiers if it is still waiting for them (seedTiers). */
async function seedAfterStart(botId: string): Promise<void> {
  try {
    const b = botRow(botId);
    if (!b?.tiers_seed) return;
    const data = await modelOptions(botId, { url: managedUrl(botId), key: managedKey(botId) });
    if (!data) return;
    seedTiers(botId, toProviders(data, { subscription: !!b.claude_subscription, configurable: true }));
  } catch (e: any) { console.warn(`[engine] ${botId}: could not set Auto tiers: ${e?.message ?? e}`); }
}

/** Start (or adopt) the bot's gateway. Safe to call often; concurrent calls share one start. */
function ensureManaged(botId: string): Promise<void> {
  let p = starting.get(botId);
  if (!p) {
    p = startGateway(botId)
      .then(() => { failures.delete(botId); void seedAfterStart(botId); })
      .catch((e: any) => {
        const msg = String(e?.message ?? e);
        failures.set(botId, msg);
        console.warn(`[engine] ${botId}: ${msg}`);
        throw e;
      })
      .finally(() => starting.delete(botId));
    starting.set(botId, p);
  }
  return p;
}

/** Where to send this bot's turns. Starts its gateway if it is not running. */
export async function engineFor(botId: string): Promise<Engine> {
  botId = ownerOf(botId);
  let kind = engineKind(botId);
  if (!kind) {
    const b = botRow(botId);
    if (!b) throw new Error('bot not found');
    if (b.kind === 'room') throw new Error('A group chat has no agent of its own.');
    kind = assignEngine(botId);
    if (!kind) throw new Error('This bot lives outside the app and has no agent here.');
  }
  if (kind === 'primary') {
    // The computer's own agent (its memory, messaging and main screen) works only for the owner's bots. A
    // binding left from before that rule is held, not used, until the owner decides (initEngines says so).
    const owner = botRow(botId)?.user_id;
    if (owner && !mayUsePrimary(owner)) throw new Error("This bot is bound to the computer's own agent, which only the owner's bots may use. The owner has to move or delete this bot before it can work again.");
    return { kind, url: env.hermesUrl, key: primaryKey(), home: env.hermesHome };
  }
  if (kind === 'silo') return { kind, url: siloFor(botId)!.url, key: siloKey(botId), home: '' };
  const url = managedUrl(botId);
  if (!(await healthy(url, 1500)) || !managedKey(botId)) await ensureManaged(botId);
  return { kind, url, key: managedKey(botId), home: homeFor(botId) };
}

/**
 * Whether a bot's agent answers right now, without starting it or asking it anything else (status.ts).
 * 'starting' and the last start failure come from this process's own bookkeeping.
 */
export async function engineHealth(botId: string): Promise<{ kind: EngineKind | null; state: 'ready' | 'starting' | 'stopped' | 'error' | 'none'; error: string | null; version: string | null }> {
  botId = ownerOf(botId);
  const kind = engineKind(botId);
  if (!kind) return { kind: null, state: 'none', error: null, version: null };
  const url = kind === 'primary' ? env.hermesUrl : kind === 'silo' ? siloFor(botId)?.url ?? '' : botRow(botId)?.engine_port ? managedUrl(botId) : '';
  if (!url) return { kind, state: 'stopped', error: null, version: null };
  const h = await healthy(url, 1500);
  if (h) return { kind, state: kind === 'managed' && starting.has(botId) ? 'starting' : 'ready', error: null, version: typeof h.version === 'string' && h.version !== 'unknown' ? h.version : null };
  if (starting.has(botId)) return { kind, state: 'starting', error: null, version: null };
  const failed = failures.get(botId) ?? null;
  // A managed agent that is simply not running is started on its next message: that is not a fault.
  return { kind, state: failed || kind !== 'managed' ? 'error' : 'stopped', error: failed ?? (kind !== 'managed' ? 'The agent is not answering.' : null), version: null };
}

/** The bot's Hermes home, without starting anything (memory files, sign-in commands). */
export function engineHome(botId: string): string | null {
  botId = ownerOf(botId);
  const kind = engineKind(botId);
  // A siloed agent's home is inside its container; the host has no copy to read.
  return kind === 'primary' ? env.hermesHome : kind === 'managed' ? homeFor(botId) : null;
}

/**
 * Hermes can run a private screen of its own for a profile (its "Bot Desktop": an Xvnc display with
 * state in <home>/bot-desktop). While that screen is up, the agent's computer-use tool acts there and
 * not on the screen this app shows (so does its browser tool, unless the config pins it to a Chrome
 * with `browser.cdp_url`), so the user could be watching an idle desktop.
 */
export function ownScreenOn(botId: string): boolean {
  const home = engineHome(botId);
  if (!home) return false;
  const dir = path.join(home, 'bot-desktop');
  try {
    // launcher.pid holds "<pid> <create time>"; the env file appears once the screen is usable.
    const pid = Number(fs.readFileSync(path.join(dir, 'launcher.pid'), 'utf8').trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 1 || !fs.existsSync(path.join(dir, 'env'))) return false;
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** Ask Hermes to stop that private screen. Hermes refuses while a person is using it; the refusal is passed on. */
export function stopOwnScreen(botId: string): Promise<void> {
  const home = engineHome(botId);
  if (!home) return Promise.reject(new Error('This bot has no agent.'));
  return new Promise((resolve, reject) => {
    execFile(env.hermesBin, ['computer-use', 'screen', 'stop'], { env: { ...process.env, HERMES_HOME: home }, timeout: 60_000 }, (err, stdout, stderr) => {
      if (!ownScreenOn(botId)) return resolve();
      const said = `${stderr || ''}\n${stdout || ''}`.trim().split('\n').filter(Boolean).pop();
      reject(new Error(said || (err ? String(err.message) : 'The screen is still running.')));
    });
  });
}

/** Start the gateway in the background (after creating a bot, or on server start). */
export function provisionEngine(botId: string) {
  if (engineKind(botId) === 'managed') ensureManaged(botId).catch(() => {});
}

export async function restartEngine(botId: string): Promise<void> {
  if (engineKind(botId) !== 'managed') return;
  await starting.get(botId)?.catch(() => {});
  await stopGateway(botId);
  optionsCache.delete(botId);
  provisionEngine(botId);
}

/** The bot is gone: stop its gateway and delete its home. The primary agent is left alone. */
export async function removeEngine(botId: string): Promise<void> {
  if (isSilo(botId)) return; // its container and data are removed by hand, never from the app
  const home = homeFor(botId);
  if (!fs.existsSync(home)) return;
  await starting.get(botId)?.catch(() => {});
  await stopGateway(botId);
  keys.delete(botId);
  failures.delete(botId);
  optionsCache.delete(botId);
  if (path.resolve(home).startsWith(path.resolve(env.enginesDir) + path.sep)) fs.rmSync(home, { recursive: true, force: true });
}

/** On server start: give older bots an engine, then bring the managed gateways up. */
export function initEngines() {
  fs.mkdirSync(env.enginesDir, { recursive: true });
  // A binding made before the owner rule existed is left alone (moving it would hand one account's
  // conversation to another agent, or take a bot away). It is only pointed out.
  const held = db.prepare("SELECT b.name, b.user_id, u.email FROM bots b JOIN users u ON u.id=b.user_id WHERE b.engine='primary'").get() as any;
  if (held && !mayUsePrimary(held.user_id)) {
    console.warn(`[engine] The computer's own agent (its memory, messaging and main screen) is bound to "${held.name}", a bot of another account (${redact(held.email)}), ${env.ownerEmail ? 'which is not OWNER_EMAIL' : 'and OWNER_EMAIL is not set'}. It is held: that bot gets no answers from the agent until this is fixed. To take it back, that bot has to be deleted in the app by its account (scripts/sign-in-link.sh signs you in as it); the owner's next new bot then gets the agent.`);
  }
  const bots = db.prepare("SELECT id, is_primary FROM bots WHERE engine IS NULL AND COALESCE(kind,'agent') <> 'room' AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at ASC").all() as any[];
  for (const b of bots) assignEngine(b.id);
  for (const b of db.prepare("SELECT id FROM bots WHERE engine='managed'").all() as any[]) if (!isOutside(b.id)) provisionEngine(b.id);
  for (const b of db.prepare("SELECT id, name FROM bots WHERE COALESCE(kind,'agent') <> 'room'").all() as any[]) {
    if (isOutside(b.id)) console.log(`[engine] ${b.name}: outside member, no engine here`);
    else if (isSilo(b.id)) console.log(`[engine] ${b.name}: siloed agent at ${siloFor(b.id)!.url}`);
  }
}

// ---------- what the settings panel shows ----------

/** Providers worth showing even when not signed in. */
const WELL_KNOWN = ['anthropic', 'openai-codex', 'xai-oauth', 'xai', 'openrouter', 'nous', 'gemini', 'openai-api'];

const optionsCache = new Map<string, { at: number; data: any }>();

async function modelOptions(botId: string, e: { url: string; key: string }): Promise<any | null> {
  const hit = optionsCache.get(botId);
  if (hit && Date.now() - hit.at < 15_000) return hit.data;
  try {
    const r = await fetch(`${e.url}/api/model/options`, { headers: e.key ? { Authorization: `Bearer ${e.key}` } : {}, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data = await r.json();
    optionsCache.set(botId, { at: Date.now(), data });
    return data;
  } catch { return null; }
}

function toProviders(data: any, o: { subscription: boolean; configurable: boolean } = { subscription: false, configurable: false }): EngineProvider[] {
  const list: any[] = (Array.isArray(data?.providers) ? data.providers : []).filter((p: any) => p?.slug !== SUBSCRIPTION || o.configurable);
  // The Claude subscription route is always in the picker of a bot whose setup the app may change, even
  // when its agent does not list it yet: switched off it says so, and picking it asks to switch it on
  // (with the warning) first. It is never usable or "connected" while off (provider-catalog.ts).
  if (o.configurable && !list.some((p) => p?.slug === SUBSCRIPTION)) list.push({ slug: SUBSCRIPTION, authenticated: false, models: [] });
  const out = list
    .filter((p) => p?.slug && (p.slug === SUBSCRIPTION || p.authenticated || WELL_KNOWN.includes(p.slug)))
    .map((p): EngineProvider => {
      // Hermes' own list for this account. Routing aggregators also get Hermes' featured shortlist;
      // every other provider keeps its whole list (cutting it at 12 hid real models and made the
      // settings panel flag them as missing).
      let featured = Array.isArray(p.featured_models) && p.featured_models.length ? p.featured_models : Array.isArray(p.models) ? p.models : [];
      const cat = CATALOG.find((c) => c.id === p.slug);
      if (!featured.length && cat?.suggested) featured = cat.suggested;
      return {
        id: String(p.slug),
        // The catalog's names say which route is which: "Claude API" is the API key, the subscription is its own entry.
        name: cat?.name ?? String(p.name ?? p.slug),
        // The Anthropic provider is the API key route here. Signing Hermes in to a Claude subscription
        // directly (its OAuth) is not offered; the subscription has its own opt-in route (SUBSCRIPTION).
        kind: p.slug === SUBSCRIPTION || (p.slug !== 'anthropic' && String(p.auth_type ?? '').includes('oauth')) ? 'subscription' : 'api_key',
        connected: !!p.authenticated && (p.slug !== SUBSCRIPTION || o.subscription),
        models: [...new Set<string>(featured.filter((m: unknown): m is string => typeof m === 'string' && !!m.trim()))].slice(0, 200),
        ...(p.slug === SUBSCRIPTION ? { optIn: true, enabled: o.subscription } : {}),
      };
    });
  const rank = (p: EngineProvider) => (p.connected ? 0 : 1) * 100 + (WELL_KNOWN.indexOf(p.id) < 0 ? 50 : WELL_KNOWN.indexOf(p.id));
  return out.sort((a, b) => rank(a) - rank(b));
}

export async function engineInfo(botId: string): Promise<EngineInfo> {
  const b = botRow(botId);
  if (!b) throw new Error('bot not found');
  const kind = engineKind(botId);
  const base: EngineInfo = { botId, profile: kind === 'primary' ? 'default' : botId, status: 'stopped', error: null, model: b.model ?? null, provider: b.provider ?? null, version: null, providers: [], ownScreen: kind ? ownScreenOn(botId) : false,
    modelMode: b.model_mode === 'auto' ? 'auto' : 'manual', modelTiers: cleanTiers(b.model_tiers), providerLock: b.provider_lock ?? null,
    tierPresets: {}, lastRoute: lastRoute(botId) };
  if (!kind) return { ...base, status: 'error', error: isOutside(botId) ? `${b.name} lives outside the app and is reached through Slack; it has no agent here.` : 'This bot has no agent.' };

  let e: { url: string; key: string };
  if (kind === 'primary') e = { url: env.hermesUrl, key: primaryKey() };
  else if (kind === 'silo') e = { url: siloFor(botId)!.url, key: siloKey(botId) };
  else {
    if (!b.engine_port) return { ...base, status: 'error', error: 'No port assigned.' };
    e = { url: managedUrl(botId), key: managedKey(botId) };
  }

  const health = await healthy(e.url);
  if (!health) {
    if (kind === 'primary') return { ...base, status: 'error', error: `The agent at ${env.hermesUrl} is not answering.` };
    if (kind === 'silo') return { ...base, status: 'error', error: `The agent in this bot's container (${e.url}) is not answering. Check the container on the host.` };
    // A managed bot's catalog and fallbacks stay on screen while its agent (re)starts.
    const view = providerView(botId, b, true, null);
    if (starting.has(botId)) return { ...base, ...view, status: 'starting' };
    const failed = failures.get(botId);
    if (failed) return { ...base, ...view, status: 'error', error: failed };
    provisionEngine(botId);
    return { ...base, ...view, status: 'starting' };
  }
  if (kind === 'managed' && starting.has(botId)) return { ...base, ...providerView(botId, b, true, null), status: 'starting' };

  const data = await modelOptions(botId, e);
  // The app may change the provider setup of a bot whose agent it runs and of the owner's own agent;
  // a siloed agent's lives in its container.
  const configurable = kind === 'managed' || kind === 'primary';
  const providers = toProviders(data, { subscription: configurable && !!b.claude_subscription, configurable });
  const seeded = kind === 'managed' ? seedTiers(botId, providers) : null;
  return {
    ...base,
    ...providerView(botId, b, configurable, data),
    status: 'ready',
    version: typeof health.version === 'string' && health.version !== 'unknown' ? health.version : null,
    model: b.model ?? data?.model ?? null,
    provider: b.provider ?? data?.provider ?? null,
    providers,
    // Only models Hermes reports for this bot's signed-in accounts; nothing when it reported none.
    tierPresets: suggestTiers(providers),
    ...(seeded ?? {}),
  };
}

/**
 * A new bot gets the same three Auto tiers (light / standard / heavy) the others have: the first time
 * its agent reports a model list, the suggested tiers for its saved provider are stored and Auto is
 * switched on. Its own model stays as the fallback. Nothing is guessed: no list or no suggestion for
 * that provider leaves the bot as it is, and it tries again next time. A person's change in settings
 * clears bots.tiers_seed first, so this never overwrites a choice.
 */
export function seedTiers(botId: string, providers: EngineProvider[]): Pick<EngineInfo, 'modelMode' | 'modelTiers'> | null {
  const b = botRow(botId);
  if (!b?.tiers_seed || !b.provider) return null;
  if (cleanTiers(b.model_tiers)) { db.prepare('UPDATE bots SET tiers_seed=0 WHERE id=?').run(botId); return null; }
  const preset = suggestTiers(providers)[b.provider];
  if (!preset || !Object.keys(preset.tiers).length) return null;
  const r = db.prepare("UPDATE bots SET model_mode='auto', model_tiers=?, tiers_seed=0, updated_at=? WHERE id=? AND tiers_seed=1")
    .run(JSON.stringify(preset.tiers), Date.now(), botId);
  if (!r.changes) return null;
  console.log(`[engine] ${b.name}: Auto tiers set from the suggested ${preset.label} tiers (${Object.entries(preset.tiers).map(([t, c]) => `${t} ${c!.model}`).join(', ')})`);
  return { modelMode: 'auto', modelTiers: cleanTiers(JSON.stringify(preset.tiers)) };
}

/** The catalog, fallbacks and opt-in for settings (provider-catalog.ts). */
function providerView(botId: string, b: any, managed: boolean, data: any): Pick<EngineInfo, 'appManaged' | 'catalog' | 'fallbacks' | 'subscriptionAllowed' | 'restartNote'> {
  const hermes: HermesProvider[] | null = Array.isArray(data?.providers) ? data.providers.filter((p: any) => typeof p?.slug === 'string') : null;
  const primaryEnv = readDotenv(path.join(env.hermesHome, '.env'));
  const sharedKeys: Record<string, boolean> = {};
  for (const c of CATALOG) if (c.keyEnv) sharedKeys[c.keyEnv] = !!(c.keyEnv === 'ANTHROPIC_API_KEY' ? sharedAnthropicKey() : (primaryEnv[c.keyEnv] ?? process.env[c.keyEnv] ?? '').trim());
  const primary = engineKind(botId) === 'primary';
  const checks = db.prepare('SELECT provider, model, at, ok, detail, ms FROM provider_checks WHERE bot_id=?').all(botId) as CheckRow[];
  const turns = db.prepare(`SELECT provider, model, MAX(at) AS at, ok FROM model_turns WHERE bot_id=? AND provider IS NOT NULL AND at > ? GROUP BY provider`)
    .all(botId, Date.now() - 30 * 86_400_000) as TurnRow[];
  let fallbacks = parseFallbacks(b.fallbacks);
  if (!fallbacks) { try { fallbacks = readFallbacks(readYaml(path.join(primary ? env.hermesHome : homeFor(botId), 'config.yaml'))); } catch { fallbacks = []; } }
  return {
    appManaged: managed,
    restartNote: primary ? primaryRestartNote(b.name) : null,
    subscriptionAllowed: managed && !!b.claude_subscription,
    fallbacks,
    catalog: providerStatuses({
      hermes, managed, botName: b.name, subscriptionOn: managed && !!b.claude_subscription, loginDir: env.claudeLoginDir,
      pluginInstalled: managed && hasSubscriptionPlugin(botId), sharedKeys, checks, turns,
    }),
  };
}

/** After a sign-in the provider list changes; drop what we remembered. */
export function forgetEngineOptions(botId: string) { optionsCache.delete(botId); }

/**
 * The model an engine answers with when a turn names none (the app has no model set for the bot):
 * Hermes reports its current default in /api/model/options. Null when the engine does not say.
 */
export async function engineDefaultModel(botId: string, e: { url: string; key: string }): Promise<{ model: string; provider: string | null } | null> {
  const data = await modelOptions(botId, e).catch(() => null);
  const model = typeof data?.model === 'string' && data.model.trim() ? data.model.trim() : null;
  if (!model) return null;
  return { model, provider: typeof data?.provider === 'string' && data.provider ? data.provider : null };
}

const NETWORK_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE',
  'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'UV_NATIVE_TLS'];

/** Proxy and certificate settings passed on to each bot's agent, and nothing else. */
export function networkEnv(from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of NETWORK_VARS) if (from[k]) out[k] = from[k] as string;
  return out;
}
