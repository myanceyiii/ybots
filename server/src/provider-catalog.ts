/**
 * The shared provider catalog (Alex, 2026-11-24): one maintained list of the model providers the app
 * offers every bot it runs, and the per-bot settings that sit on top of it (default provider and model,
 * an explicit fallback chain, and the opt-in for the experimental Claude subscription route).
 *
 * Three different things are reported for each provider and never folded into one:
 *  - listed:   it is in this catalog (or in the bot's own Hermes config). Says nothing about access.
 *  - access:   the bot's own agent has a credential for it (a shared key, its own sign-in, or the
 *              Claude Code login) and Hermes reports it as authenticated. Still not proof it answers.
 *  - verified: a real request from the bot's own agent came back from that provider and model
 *              (Check in settings, or a chat turn that ran on it), with the time it happened.
 *
 * Credentials. Managed bots inherit the owner's model keys (engine.ts writeHome). The Anthropic API key
 * used to be copied into each bot's .env, which Hermes loads into its process environment; the Claude
 * subscription plugin then refuses to run, on purpose, because an inherited ANTHROPIC_API_KEY would make
 * Claude Code bill the API instead of the plan. So the key now goes into the bot's Hermes credential pool
 * (auth.json, a "manual" API-key row this app owns) and none of the plugin's conflicting variables are
 * left in the bot's environment. Both routes then work side by side in one bot, and the plugin's guard
 * stays in place. Rotating OAuth tokens (ANTHROPIC_TOKEN, CLAUDE_CODE_OAUTH_TOKEN) are never copied to a
 * bot. The Claude Code login itself is never read, copied or refreshed by the app: an opted-in bot's
 * plugin is pointed at the login folder (claude_config_dir) and Claude Code uses it there.
 */
import crypto from 'node:crypto';
import type { FallbackChoice, ProviderStatus } from './types.js';

/** The Hermes model-provider plugin behind the Claude subscription route (NousResearch/hermes-official-plugins). */
export const SUBSCRIPTION = 'claude-subscription-directsdk-experimental';

/**
 * Variables the subscription plugin refuses to inherit (its directsdk.py guard, plus the OAuth token
 * names Hermes itself prefers over an API key). None of them may be in a managed bot's environment.
 */
export const CONFLICTING_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
];

/** Label of the credential-pool row this app keeps for the shared Anthropic API key. */
export const POOL_LABEL = 'cleft-shared-anthropic-api-key';

export const SUBSCRIPTION_WARNING =
  "Experimental. Anthropic's terms appear to forbid using a Claude Pro or Max login from a self-hosted, third-party agent like this one, and Anthropic may limit or close the account. " +
  'It shares the plan\'s 5-hour and weekly limits with your own Claude use, and if extra usage is switched on for that Claude account, going past the limits can be billed. ' +
  'The app never uses it as a silent fallback: only as a default or fallback you pick here.';

export interface CatalogEntry {
  id: string;
  name: string;
  /** How a bot reaches it: a shared API key, a Claude Code login, or the bot's own sign-in. */
  route: 'api_key' | 'subscription' | 'sign_in';
  /** The owner-level variable a shared key comes from (primary agent's .env, then this server's env). */
  keyEnv?: string;
  experimental?: boolean;
  /** Off for every bot until the owner switches it on for that bot. */
  optIn?: boolean;
  billing: string;
  /** Models to offer when the bot's agent lists none for it. Suggestions only, never shown as verified. */
  suggested?: string[];
}

/**
 * The maintained catalog. Add a provider here (one line) and every bot the app runs offers it; whether a
 * bot can use it is then reported per bot. Providers a bot's own Hermes config defines (custom endpoints)
 * are listed too, after these, as "from this bot's agent".
 */
export const CATALOG: CatalogEntry[] = [
  { id: 'anthropic', name: 'Claude API (Anthropic)', route: 'api_key', keyEnv: 'ANTHROPIC_API_KEY',
    billing: 'Billed per token to the Anthropic API account the shared key belongs to.' },
  { id: SUBSCRIPTION, name: 'Claude subscription (Claude Code, experimental)', route: 'subscription', experimental: true, optIn: true,
    billing: 'Uses the Claude plan\'s usage limits; extra usage can be billed if it is on for the account. Cost figures for this route are list-price estimates, not a bill.',
    suggested: ['sonnet', 'opus', 'haiku'] },
  { id: 'openrouter', name: 'OpenRouter', route: 'api_key', keyEnv: 'OPENROUTER_API_KEY',
    billing: 'Billed per token to the OpenRouter account the shared key belongs to.' },
  { id: 'openai-codex', name: 'ChatGPT (sign-in)', route: 'sign_in', billing: 'Uses the ChatGPT plan this bot is signed in to.' },
  { id: 'nous', name: 'Nous Portal', route: 'sign_in', billing: 'Uses the Nous account this bot is signed in to.' },
];

export const catalogEntry = (id: string) => CATALOG.find((c) => c.id === id) ?? null;

// ---------- a managed bot's environment and credential pool ----------

/**
 * Split a managed bot's .env: everything the subscription plugin would refuse is taken out, and the
 * Anthropic API key is handed back for the credential pool. Pure.
 */
export function isolateAnthropicEnv(vars: Record<string, string>): { vars: Record<string, string>; apiKey: string | null; dropped: string[] } {
  const out = { ...vars };
  const apiKey = (out.ANTHROPIC_API_KEY ?? '').trim() || null;
  const dropped: string[] = [];
  for (const k of CONFLICTING_ENV) if (k in out) { dropped.push(k); delete out[k]; }
  return { vars: out, apiKey, dropped };
}

/**
 * Put the shared Anthropic API key in a bot's Hermes credential pool (auth.json) as a row this app owns,
 * and take out rows Hermes seeded from the environment (they would go stale). Rows anyone else added
 * (a sign-in, a key typed in by hand) are left as they are. Returns whether anything changed. Pure:
 * mutates and returns the object it is given.
 */
export function upsertPoolKey(auth: any, apiKey: string | null): boolean {
  if (!auth || typeof auth !== 'object') return false;
  const before = JSON.stringify(auth.credential_pool ?? null);
  const pool = auth.credential_pool && typeof auth.credential_pool === 'object' && !Array.isArray(auth.credential_pool) ? auth.credential_pool : {};
  const rows: any[] = Array.isArray(pool.anthropic) ? pool.anthropic : [];
  const fromEnv = (r: any) => typeof r?.source === 'string' && /^env:(ANTHROPIC_|CLAUDE_CODE_)/.test(r.source);
  let kept = rows.filter((r) => !fromEnv(r));
  const mine = kept.find((r) => r?.label === POOL_LABEL);
  if (!apiKey) kept = kept.filter((r) => r?.label !== POOL_LABEL);
  else if (mine) {
    if (mine.access_token !== apiKey) {
      mine.access_token = apiKey;
      for (const k of ['last_status', 'last_status_at', 'last_error_code', 'last_error_reason', 'last_error_message', 'last_error_reset_at', 'failure_reason', 'secret_fingerprint']) delete mine[k];
    }
  } else {
    kept.unshift({ id: crypto.randomBytes(3).toString('hex'), label: POOL_LABEL, auth_type: 'api_key', priority: 0, source: 'manual', access_token: apiKey, base_url: 'https://api.anthropic.com' });
  }
  if (kept.length) pool.anthropic = kept; else delete pool.anthropic;
  auth.credential_pool = pool;
  if (!auth.version) auth.version = 1;
  return JSON.stringify(auth.credential_pool) !== before;
}

// ---------- a managed bot's Hermes config ----------

const ID = /^[a-z0-9][a-z0-9:._-]{0,60}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,119}$/;

/** A fallback chain from the app or a client: at most 3 {provider, model}, in order, no repeats. Throws on bad input. */
export function cleanFallbacks(input: unknown): FallbackChoice[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) throw new Error('fallbacks must be a list');
  if (input.length > 3) throw new Error('At most 3 fallbacks.');
  const out: FallbackChoice[] = [];
  for (const raw of input) {
    const provider = typeof raw?.provider === 'string' ? raw.provider.trim() : '';
    const model = typeof raw?.model === 'string' ? raw.model.trim() : '';
    if (!ID.test(provider)) throw new Error('Each fallback needs a provider.');
    if (!MODEL.test(model)) throw new Error(`The fallback on ${provider} needs a model id.`);
    if (out.some((f) => f.provider === provider && f.model === model)) continue;
    out.push({ provider, model });
  }
  return out;
}

/** The chain a Hermes config holds now (fallback_providers first, then the legacy fallback_model). Pure. */
export function readFallbacks(cfg: any): FallbackChoice[] {
  const raw: unknown[] = [
    ...(Array.isArray(cfg?.fallback_providers) ? cfg.fallback_providers : []),
    ...(cfg?.fallback_model && typeof cfg.fallback_model === 'object' ? (Array.isArray(cfg.fallback_model) ? cfg.fallback_model : [cfg.fallback_model]) : []),
  ];
  const out: FallbackChoice[] = [];
  for (const f of raw as any[]) {
    if (typeof f?.provider !== 'string' || typeof f?.model !== 'string' || !f.provider || !f.model) continue;
    if (!out.some((o) => o.provider === f.provider && o.model === f.model)) out.push({ provider: f.provider, model: f.model });
  }
  return out;
}

export function parseFallbacks(raw: string | null | undefined): FallbackChoice[] | null {
  if (raw === null || raw === undefined) return null;
  try { return cleanFallbacks(JSON.parse(raw)); } catch { return []; }
}

/**
 * The provider settings the app owns in a managed bot's Hermes config. Pure: mutates `cfg`.
 *  - fallback_providers is exactly the bot's chain (Hermes re-reads it before each new agent, so no
 *    restart); the legacy fallback_model is dropped so there is one source of truth.
 *  - auth.adopt_external_logins is off, so the Anthropic API route can never quietly pick up a
 *    Claude Code login it finds on the machine and bill the plan instead.
 *  - the subscription plugin's claude_config_dir points at the Claude Code login only when the owner
 *    switched the route on for this bot; otherwise at an empty folder in the bot's home, so the plugin
 *    finds no login whatever else is on the machine.
 */
export function applyProviderConfig(cfg: any, o: { fallbacks: FallbackChoice[]; subscriptionOn: boolean; loginDir: string; offDir: string }) {
  cfg.fallback_providers = o.fallbacks.map((f) => ({ provider: f.provider, model: f.model }));
  delete cfg.fallback_model;
  cfg.auth = { ...(cfg.auth && typeof cfg.auth === 'object' ? cfg.auth : {}), adopt_external_logins: false };
  const plugins = cfg.plugins && typeof cfg.plugins === 'object' ? cfg.plugins : {};
  const entries = plugins.entries && typeof plugins.entries === 'object' ? plugins.entries : {};
  const entry = entries[SUBSCRIPTION] && typeof entries[SUBSCRIPTION] === 'object' ? entries[SUBSCRIPTION] : {};
  const settings = entry.settings && typeof entry.settings === 'object' ? entry.settings : {};
  settings.claude_config_dir = o.subscriptionOn && o.loginDir ? o.loginDir : o.offDir;
  entry.settings = settings;
  entries[SUBSCRIPTION] = entry;
  plugins.entries = entries;
  cfg.plugins = plugins;
}

// ---------- what settings show ----------

export interface HermesProvider { slug: string; name?: string; authenticated?: boolean; models?: string[]; featured_models?: string[]; warning?: string; is_user_defined?: boolean }
export interface CheckRow { provider: string; model: string; at: number; ok: number; detail: string | null; ms: number | null }
export interface TurnRow { provider: string; model: string | null; at: number; ok: number }

/**
 * One row per provider for a bot's settings. Pure: everything it needs is passed in.
 * `managed` = the app runs this bot's agent (it may change its config); otherwise rows are information.
 */
export function providerStatuses(o: {
  hermes: HermesProvider[] | null;
  managed: boolean;
  botName: string;
  subscriptionOn: boolean;
  loginDir: string;
  pluginInstalled: boolean;
  sharedKeys: Record<string, boolean>;
  checks: CheckRow[];
  turns: TurnRow[];
}): ProviderStatus[] {
  const hermes = o.hermes ?? [];
  const byId = new Map(hermes.map((p) => [p.slug, p]));
  const out: ProviderStatus[] = [];
  const models = (h: HermesProvider | undefined) => [...new Set((h?.featured_models?.length ? h.featured_models : h?.models ?? []).filter((m): m is string => typeof m === 'string' && !!m.trim()))].slice(0, 200);
  const verified = (id: string) => {
    const c = o.checks.filter((x) => x.provider === id).sort((a, b) => b.at - a.at)[0];
    return c ? { at: c.at, model: c.model, ok: !!c.ok, detail: c.detail, ms: c.ms } : null;
  };
  const lastTurn = (id: string) => {
    const t = o.turns.filter((x) => x.provider === id).sort((a, b) => b.at - a.at)[0];
    return t ? { at: t.at, model: t.model, ok: !!t.ok } : null;
  };

  for (const c of CATALOG) {
    const h = byId.get(c.id);
    const list = models(h);
    let access: ProviderStatus['access'] = 'unknown';
    let accessNote = '';
    let eligible = true;
    let eligibleNote: string | null = null;
    if (c.id === SUBSCRIPTION) {
      if (!o.managed) { eligible = false; eligibleNote = `Not offered for ${o.botName}: the app does not change the setup of an agent it does not run.`; }
      if (!eligible) { access = 'off'; accessNote = eligibleNote!; }
      else if (!o.subscriptionOn) { access = 'off'; accessNote = `Switched off for ${o.botName}. Nothing uses the Claude login until you switch it on here.`; }
      else if (!o.pluginInstalled) { access = 'not_installed'; accessNote = 'The Claude subscription plugin is not installed for this bot yet. It is added when the bot\'s agent next starts, if the server has a copy.'; }
      else if (!o.loginDir) { access = 'not_signed_in'; accessNote = 'No Claude Code login is set up for the app yet (CLAUDE_LOGIN_DIR on the server).'; }
      else if (h?.authenticated) { access = 'ready'; accessNote = 'Claude Code reports a login for this bot\'s agent.'; }
      else if (!h) { access = 'unknown'; accessNote = 'The bot\'s agent did not report this provider just now.'; }
      else { access = 'not_signed_in'; accessNote = h.warning ? `The bot's agent reports no usable login (${h.warning}).` : 'The bot\'s agent reports no usable Claude Code login.'; }
    } else if (c.route === 'api_key') {
      const key = !!o.sharedKeys[c.keyEnv!];
      if (h?.authenticated) { access = 'ready'; accessNote = o.managed ? 'The shared key is in this bot\'s agent.' : 'This agent reports a key.'; }
      else if (o.managed && !key) { access = 'needs_key'; accessNote = `No ${c.keyEnv} is set for the app, so bots have no key for it.`; }
      else if (!h) { access = 'unknown'; accessNote = 'The bot\'s agent did not report this provider just now.'; }
      else { access = 'needs_key'; accessNote = h.warning ? `The bot's agent reports: ${h.warning}.` : 'The bot\'s agent reports no key for it.'; }
    } else {
      if (h?.authenticated) { access = 'ready'; accessNote = 'This bot\'s agent is signed in.'; }
      else if (!h) { access = 'unknown'; accessNote = 'The bot\'s agent did not report this provider just now.'; }
      else { access = 'not_signed_in'; accessNote = 'Not signed in on this bot\'s agent. Each bot signs in on its own.'; }
    }
    out.push({
      id: c.id, name: c.name, route: c.route, experimental: !!c.experimental, optIn: !!c.optIn, billing: c.billing,
      warning: c.id === SUBSCRIPTION ? SUBSCRIPTION_WARNING : null,
      source: 'catalog', eligible, eligibleNote, access, accessNote,
      models: list.length ? list : c.suggested ?? [], modelsFromAgent: list.length > 0,
      verified: verified(c.id), lastTurn: lastTurn(c.id),
    });
  }
  // Providers the bot's own Hermes config defines and has credentials for (custom endpoints and the like).
  for (const h of hermes) {
    if (CATALOG.some((c) => c.id === h.slug) || !h.authenticated) continue;
    const list = models(h);
    out.push({
      id: h.slug, name: h.name || h.slug, route: 'api_key', experimental: false, optIn: false,
      billing: 'Billed by that provider\'s account.', warning: null, source: 'agent', eligible: true, eligibleNote: null,
      access: 'ready', accessNote: 'Set up in this bot\'s own agent config.', models: list, modelsFromAgent: list.length > 0,
      verified: verified(h.slug), lastTurn: lastTurn(h.slug),
    });
  }
  return out;
}

/**
 * Whether a check's answer really came from what was asked: Hermes may switch to a fallback mid-request,
 * and then the reply proves nothing about the route under test. Pure.
 */
export function answeredBy(requested: string, returned: unknown): { same: boolean; returned: string | null } {
  const r = typeof returned === 'string' && returned.trim() ? returned.trim() : null;
  if (!r) return { same: true, returned: null };
  const norm = (s: string) => s.toLowerCase().replace(/\[1m\]$/, '').replace(/^.*\//, '').replace(/[._]/g, '-');
  const a = norm(requested), b = norm(r);
  return { same: a === b || b.startsWith(`${a}-`) || a.startsWith(`${b}-`) || b.includes(a), returned: r };
}
