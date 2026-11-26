import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import YAML from 'yaml';
import { db } from './db.js';
import { env } from './env.js';

/**
 * Web search by API (Alex, 2026-11-24: "I'd rather the bots have some ability to search the web via
 * api rather than having to use a search engine on the browser").
 *
 * Hermes already has the tools: web_search (titles, links and snippets from a search API) and web_extract
 * (a page's readable text, no browser). Both are read-only, so the gate (plugins/hermes-gate.ts) lets them
 * run without a card, and Hermes caches results itself (tools/web_result_cache.py: identical searches share
 * one paid request; pages are kept on disk). What was missing:
 *
 *  - the bots the app runs (Leonard, Raj, ...) got no search key and no `web` settings, so they
 *    fell back to Hermes' keyless free tier, and their prompt told them to use the browser for any site
 *    without a connected app; none of them ever called web_search (state.db, 2026-11-24);
 *  - nothing in the app showed which search service the bots use or how much they use it.
 *
 * So the app copies the primary agent's (Howard's) search key and `web` settings into every bot it runs
 * (engine.ts writeHome), turns the `web` toolset off for a bot whose owner switched it off, tells each bot
 * to search by API before opening a browser (agent/prompt.ts), and reports the setup and this month's use
 * in Settings > Connections on every app. The key stays where it already lives, in the primary agent's
 * .env on this machine; the app never sends it to a device.
 */

/** Search-service keys a bot may inherit from the primary agent. Model keys are in engine.ts SHARED_ENV. */
export const SEARCH_ENV = [
  'BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'PARALLEL_API_KEY', 'FIRECRAWL_API_KEY', 'FIRECRAWL_API_URL',
  'SEARXNG_URL', 'KEENABLE_API_KEY', 'PERPLEXITY_API_KEY',
];

/** Hermes `web:` keys the app copies from the primary agent (tools/web_tools.py, web_result_cache.py). */
const WEB_KEYS = ['backend', 'search_backend', 'extract_backend', 'keyless_fallback', 'keyless_rescue', 'cache_enabled', 'cache_exempt_hosts', 'extract_char_limit', 'extract_timeout'];

/** Results are kept an hour (Hermes' default is 20 minutes): household questions repeat within a chat. */
export const CACHE_MINUTES = 60;

/** Which service each Hermes backend name is, in words, and the key it needs. */
const SERVICES: Record<string, { name: string; env?: string }> = {
  'brave-free': { name: 'Brave Search API', env: 'BRAVE_SEARCH_API_KEY' },
  tavily: { name: 'Tavily', env: 'TAVILY_API_KEY' },
  exa: { name: 'Exa', env: 'EXA_API_KEY' },
  parallel: { name: 'Parallel', env: 'PARALLEL_API_KEY' },
  firecrawl: { name: 'Firecrawl', env: 'FIRECRAWL_API_KEY' },
  searxng: { name: 'SearXNG (self-hosted)', env: 'SEARXNG_URL' },
  keenable: { name: 'Keenable', env: 'KEENABLE_API_KEY' },
  perplexity: { name: 'Perplexity', env: 'PERPLEXITY_API_KEY' },
  ddgs: { name: 'DuckDuckGo (no key)' },
};
const KEYLESS = 'Free public search services, no key (Exa, Parallel, Firecrawl, Keenable)';

function readDotenv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
function readYaml(file: string): any {
  try { return YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}

/** The primary agent's `web:` settings, limited to the keys we share. */
export function primaryWebConfig(): Record<string, unknown> {
  const web = readYaml(path.join(env.hermesHome, 'config.yaml')).web ?? {};
  const out: Record<string, unknown> = {};
  for (const k of WEB_KEYS) if (web[k] !== undefined && web[k] !== '') out[k] = web[k];
  return out;
}

/** Search keys from the primary agent's .env (or this server's environment). Values never leave this machine. */
export function primarySearchEnv(): Record<string, string> {
  const primary = readDotenv(path.join(env.hermesHome, '.env'));
  const out: Record<string, string> = {};
  for (const k of SEARCH_ENV) {
    const v = primary[k] ?? process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

/** Whether the owner left web search on for this bot (bots.web_search: NULL or 1 = on). */
export function webSearchOn(botId: string): boolean {
  const r = db.prepare('SELECT web_search FROM bots WHERE id=?').get(botId) as { web_search?: number | null } | undefined;
  return r?.web_search !== 0;
}

/**
 * Put the shared search setup into a bot's Hermes config (engine.ts writeHome). Settings the bot's own
 * config has for keys we do not share are kept; the `web` toolset is disabled when the owner turned it off.
 */
export function applyWebConfig(cfg: any, botId: string): void {
  cfg.web = { ...(cfg.web ?? {}), ...primaryWebConfig(), cache_enabled: true, cache_ttl_minutes: CACHE_MINUTES };
  const agent = { ...(cfg.agent ?? {}) };
  const off = new Set<string>(Array.isArray(agent.disabled_toolsets) ? agent.disabled_toolsets : []);
  if (webSearchOn(botId)) off.delete('web'); else off.add('web');
  agent.disabled_toolsets = [...off];
  cfg.agent = agent;
}

/** The search service the bots use, in words, and whether its key is in place. */
export function serviceInfo(): { service: string; backend: string; keySet: boolean; extract: string; fallback: string | null } {
  const web = primaryWebConfig();
  const keys = primarySearchEnv();
  const pick = String(web.search_backend || web.backend || '');
  const auto = Object.entries(SERVICES).find(([, s]) => s.env && keys[s.env])?.[0] ?? '';
  const backend = pick || auto;
  const s = SERVICES[backend];
  const extractPick = String(web.extract_backend || '');
  // Brave answers searches only; Hermes reads pages through the keyless services unless another reader is set.
  const extract = extractPick && SERVICES[extractPick] ? SERVICES[extractPick].name
    : backend === 'brave-free' || !s ? KEYLESS : s.name;
  return {
    service: s ? s.name : KEYLESS,
    backend: backend || 'keyless',
    keySet: s?.env ? !!keys[s.env] : false,
    extract,
    fallback: web.keyless_fallback === false ? null : KEYLESS,
  };
}

/** Where a bot's Hermes keeps its history, or null for a bot without one here (an outside member). */
function stateDb(botId: string, engine: string | null): string | null {
  if (engine === 'primary') return path.join(env.hermesHome, 'state.db');
  if (engine === 'managed') return path.join(env.enginesDir, botId, 'state.db');
  return null;
}

/** Searches and page reads a bot made since the start of this month (its Hermes history, read-only). */
function monthUse(file: string | null, since: number): { searches: number; reads: number } | null {
  if (!file || !fs.existsSync(file)) return null;
  let h: Database.Database | null = null;
  try {
    h = new Database(file, { readonly: true, fileMustExist: true });
    h.pragma('busy_timeout = 500');
    const rows = h.prepare("SELECT tool_name AS t, COUNT(*) AS n FROM messages WHERE tool_name IN ('web_search','web_extract') AND timestamp >= ? GROUP BY tool_name").all(since) as { t: string; n: number }[];
    const n = (t: string) => rows.find((r) => r.t === t)?.n ?? 0;
    return { searches: n('web_search'), reads: n('web_extract') };
  } catch {
    return null;
  } finally {
    h?.close();
  }
}

export interface WebSearchBot { id: string; name: string; on: boolean; ownSetup: boolean; searches: number | null; reads: number | null }
export interface WebSearchStatus {
  service: string; keySet: boolean; extract: string; fallback: string | null; cacheMinutes: number;
  monthStart: number; bots: WebSearchBot[];
}

/** Settings > Connections > Web search. The owner sees every bot; anyone else only their own. */
export function webSearchStatus(userId: string, owner: boolean): WebSearchStatus {
  const d = new Date();
  const monthStart = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
  const rows = db.prepare(`SELECT id, name, engine, web_search FROM bots
    WHERE COALESCE(kind,'agent') <> 'room' AND side_of IS NULL AND COALESCE(hidden,0) = 0 ${owner ? '' : 'AND user_id = ?'}
    ORDER BY created_at`).all(...(owner ? [] : [userId])) as { id: string; name: string; engine: string | null; web_search: number | null }[];
  const bots = rows
    // A bot with no engine here (Sheldon, who lives in ChatGPT behind the Slack link) has no web tools from this app.
    .filter((r) => r.engine === 'primary' || r.engine === 'managed')
    .map((r) => {
      const use = monthUse(stateDb(r.id, r.engine), monthStart);
      return { id: r.id, name: r.name, on: r.web_search !== 0, ownSetup: r.engine === 'primary', searches: use?.searches ?? null, reads: use?.reads ?? null };
    });
  const s = serviceInfo();
  return { service: s.service, keySet: s.keySet, extract: s.extract, fallback: s.fallback, cacheMinutes: CACHE_MINUTES, monthStart, bots };
}
