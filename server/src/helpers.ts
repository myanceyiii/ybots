import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import YAML from 'yaml';
import { EFFORTS, TIERS, type Effort, type Tier } from './model-router.js';

/**
 * Helpers: the sub-agents a bot's Hermes can start with `delegate_task` (docs/helpers.md).
 *
 * Hermes runs them; this module only reads and writes the owner's choices in the bot's own Hermes
 * config.yaml, and lists recent runs from its state.db. What the owner can set:
 *
 *  - on/off (`agent.disabled_toolsets` gets or loses "delegation"),
 *  - how many at once (`delegation.max_concurrent_children`, 1-10) and steps per helper
 *    (`delegation.max_iterations`, 10-250),
 *  - which models a helper may run on: up to three routes (fast, standard, deep = the app's light,
 *    standard and heavy tiers), each one model of the bot's own provider that the bot's Hermes lists
 *    for its signed-in account, capped by a highest tier,
 *  - which route a helper takes when the bot names none.
 *
 * Some things are never the owner's to loosen from here, so every write sets them again: helpers
 * cannot start helpers (`max_spawn_depth: 1`), a helper's risky commands are refused, never
 * auto-approved (`subagent_auto_approve: false`), and nothing resumes by itself (`auto_resume: false`).
 * None of this touches approval policies: `delegate_task` and every tool a helper uses still go
 * through Hermes' own rules and the app's gate, and nothing a bot or helper says is an approval.
 *
 * Per-job route choice needs the official advanced-delegation plugin in that Hermes home. Without it,
 * every helper runs on the default route (`delegation.model`), so the cap still holds.
 */

export const ROUTE_NAME: Record<Tier, string> = { light: 'fast', standard: 'standard', heavy: 'deep' };
const TIER_OF: Record<string, Tier> = { fast: 'light', standard: 'standard', deep: 'heavy' };
const ROUTE_TEXT: Record<Tier, string> = {
  light: 'Cheap and quick: lookups, status checks, summaries, simple edits.',
  standard: 'Most jobs: multi-step checks, investigations, ordinary fixes.',
  heavy: 'Slow and careful: hard debugging, risky changes, design work. Use only when a cheaper route failed or the job clearly needs it.',
};
export const LIMITS = { maxAtOnce: [1, 10], stepLimit: [10, 250] } as const;
const PLUGIN = 'advanced-delegation';

export interface HelperRoute { model: string; effort: Effort | null }
export interface HelperSettings {
  enabled: boolean;
  maxAtOnce: number;
  stepLimit: number;
  /** The highest tier a helper may run on. Routes above it are not written to Hermes. */
  maxTier: Tier;
  /** The route for a job that names none. */
  defaultTier: Tier;
  routes: Partial<Record<Tier, HelperRoute>>;
}
export interface HelpersView extends HelperSettings {
  /** The provider every helper route uses: the bot's own. */
  provider: string | null;
  /** advanced-delegation is installed and enabled, so the bot can pick a route per job. */
  perJobChoice: boolean;
  /** No route configured: helpers run on the bot's own main model. */
  inheritsMainModel: boolean;
}

const rank = (t: Tier) => TIERS.indexOf(t);
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const effortOf = (v: unknown): Effort | null => (EFFORTS as string[]).includes(String(v)) ? (v as Effort) : null;

/** Read the helper settings out of a parsed config.yaml. Pure. */
export function readHelpers(cfg: any): Omit<HelpersView, 'provider' | 'perJobChoice'> {
  const d = obj(cfg?.delegation);
  const disabled = Array.isArray(cfg?.agent?.disabled_toolsets) ? cfg.agent.disabled_toolsets.map(String) : [];
  const routes: Partial<Record<Tier, HelperRoute>> = {};
  const mm = obj(obj(d.backends).model_map);
  let def: Tier | null = null;
  if (d.backend === 'model_map' && Array.isArray(mm.options)) {
    for (const o of mm.options) {
      const t = TIER_OF[String(o?.name ?? '')];
      if (t && typeof o.model === 'string' && o.model) routes[t] = { model: o.model, effort: effortOf(o.reasoning_effort) };
    }
    def = TIER_OF[String(mm.default ?? '')] ?? null;
  }
  if (!Object.keys(routes).length && typeof d.model === 'string' && d.model) {
    routes.standard = { model: d.model, effort: effortOf(d.reasoning_effort) };
    def = 'standard';
  }
  const present = TIERS.filter((t) => routes[t]);
  const int = (v: unknown, dflt: number) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : dflt);
  return {
    enabled: !disabled.includes('delegation'),
    maxAtOnce: int(d.max_concurrent_children, 10),
    stepLimit: int(d.max_iterations, 250),
    maxTier: present.length ? present[present.length - 1] : 'heavy',
    defaultTier: def && routes[def] ? def : present[0] ?? 'standard',
    routes,
    inheritsMainModel: !present.length,
  };
}

export class HelpersError extends Error {}

/**
 * The models a bot's helpers may run on: only the bot's own models (its manual model, its Auto
 * tiers, and the main model in its Hermes config), narrowed to what its Hermes lists for the
 * signed-in account when it lists anything. A helper can never be put on a model its bot isn't
 * allowed to use. Pure.
 */
export function helperModels(bot: { model?: string | null; model_mode?: string | null; model_tiers?: unknown }, mainModel: string | null, listed: string[]): string[] {
  const own = new Set<string>();
  const add = (m: unknown) => { if (typeof m === 'string' && m.trim()) own.add(m.trim()); };
  add(bot.model);
  add(mainModel);
  if (bot.model_mode === 'auto') {
    let t: unknown = bot.model_tiers;
    if (typeof t === 'string') { try { t = JSON.parse(t); } catch { t = null; } }
    for (const tier of TIERS) add(obj(obj(t)[tier]).model);
  }
  return listed.length ? listed.filter((m) => own.has(m)) : [...own];
}

/**
 * Check what the owner sent. `models` is the bot's live model list for its provider; when Hermes
 * reports none, only models already in the config are accepted, so nothing is invented. Pure.
 */
export function cleanHelpers(p: any, models: string[], current: Omit<HelpersView, 'provider' | 'perJobChoice'>): HelperSettings {
  const num = (v: unknown, [lo, hi]: readonly [number, number], name: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new HelpersError(`${name} must be a whole number from ${lo} to ${hi}.`);
    return n;
  };
  const tier = (v: unknown, name: string): Tier => {
    if (!(TIERS as string[]).includes(String(v))) throw new HelpersError(`${name} must be light, standard or heavy.`);
    return v as Tier;
  };
  const maxTier = tier(p?.maxTier, 'maxTier');
  const known = new Set(models.length ? models : Object.values(current.routes).map((r) => r!.model));
  const routes: Partial<Record<Tier, HelperRoute>> = {};
  for (const t of TIERS) {
    const r = obj(p?.routes)[t];
    if (!r || !r.model || rank(t) > rank(maxTier)) continue;
    const model = String(r.model).trim();
    if (!/^[A-Za-z0-9._:/@-]{1,120}$/.test(model)) throw new HelpersError(`Bad model name for ${t}.`);
    if (!known.has(model)) throw new HelpersError(`${model} is not in this bot's model list, so it can't be a helper model.`);
    const effort = r.effort == null || r.effort === '' ? null : effortOf(r.effort);
    if (r.effort != null && r.effort !== '' && !effort) throw new HelpersError(`Thinking level for ${t} must be low, medium, high or xhigh.`);
    routes[t] = { model, effort };
  }
  const enabled = p?.enabled === true;
  if (enabled && !Object.keys(routes).length) throw new HelpersError('Pick a model for at least one helper tier at or below the highest tier.');
  let defaultTier = (TIERS as string[]).includes(String(p?.defaultTier)) ? (p.defaultTier as Tier) : 'standard';
  if (!routes[defaultTier]) defaultTier = TIERS.filter((t) => routes[t] && rank(t) <= rank(defaultTier)).pop() ?? TIERS.find((t) => routes[t]) ?? 'standard';
  return {
    enabled,
    maxAtOnce: num(p?.maxAtOnce, LIMITS.maxAtOnce, 'Helpers at once'),
    stepLimit: num(p?.stepLimit, LIMITS.stepLimit, 'Steps per helper'),
    maxTier,
    defaultTier,
    routes,
  };
}

/**
 * Write checked settings into a config.yaml Document (comments and other keys are kept). Pure apart
 * from the document. With no routes (helpers off and nothing picked) the routes are left as they are.
 */
export function applyHelpers(doc: YAML.Document, s: HelperSettings, provider: string, perJobChoice: boolean) {
  const disabled = doc.getIn(['agent', 'disabled_toolsets']);
  const list = (YAML.isSeq(disabled) ? (disabled.toJSON() as unknown[]) : []).map(String).filter((t) => t !== 'delegation');
  if (!s.enabled) list.push('delegation');
  doc.setIn(['agent', 'disabled_toolsets'], doc.createNode(list));
  const set = (k: string, v: unknown) => doc.setIn(['delegation', k], v);
  set('max_concurrent_children', s.maxAtOnce);
  set('max_iterations', s.stepLimit);
  // Never loosened from the app.
  set('max_spawn_depth', 1);
  set('subagent_auto_approve', false);
  set('auto_resume', false);
  const chosen = TIERS.filter((t) => s.routes[t]);
  if (!chosen.length) return;
  const def = s.routes[s.defaultTier] ?? s.routes[chosen[0]]!;
  // The default route also fills delegation.model, so the cap holds even without the plugin.
  set('model', def.model);
  set('provider', provider);
  set('reasoning_effort', def.effort ?? '');
  if (perJobChoice) {
    const options = chosen.map((t) => ({ name: ROUTE_NAME[t], description: ROUTE_TEXT[t], provider, model: s.routes[t]!.model, ...(s.routes[t]!.effort ? { reasoning_effort: s.routes[t]!.effort } : {}) }));
    doc.setIn(['delegation', 'backends', 'model_map', 'options'], doc.createNode(options));
    doc.setIn(['delegation', 'backends', 'model_map', 'default'], ROUTE_NAME[s.routes[s.defaultTier] ? s.defaultTier : chosen[0]]);
    set('backend', 'model_map');
  } else if (doc.getIn(['delegation', 'backend']) !== undefined) {
    // A model_map or profile_routes backend without its plugin would refuse every helper.
    set('backend', 'default');
  }
}

/** The plugin is in this Hermes home and listed in plugins.enabled. */
export function pluginReady(home: string, cfg: any): boolean {
  const enabled = Array.isArray(cfg?.plugins?.enabled) ? cfg.plugins.enabled.map(String) : [];
  return enabled.includes(PLUGIN) && fs.existsSync(path.join(home, 'plugins', PLUGIN));
}

export function loadHelpers(home: string, provider: string | null): HelpersView {
  const cfg = YAML.parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')) ?? {};
  return { ...readHelpers(cfg), provider, perJobChoice: pluginReady(home, cfg) };
}

/** Write the settings into <home>/config.yaml, keeping its owner and mode, with a .bak beside it. */
export function saveHelpers(home: string, s: HelperSettings, provider: string): HelpersView {
  const file = path.join(home, 'config.yaml');
  const text = fs.readFileSync(file, 'utf8');
  const st = fs.statSync(file);
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new HelpersError(`This bot's config.yaml does not parse (${doc.errors[0].message}); not changing it.`);
  applyHelpers(doc, s, provider, pluginReady(home, doc.toJSON()));
  const out = doc.toString();
  if (out !== text) {
    fs.writeFileSync(`${file}.cleft-helpers.bak`, text, { mode: 0o600 });
    const tmp = `${file}.cleft-helpers.tmp`;
    fs.writeFileSync(tmp, out, { mode: st.mode & 0o777 });
    try { fs.chownSync(tmp, st.uid, st.gid); } catch { /* not root: the file is already ours */ }
    fs.renameSync(tmp, file);
  }
  return loadHelpers(home, provider);
}

export interface HelperRun {
  id: string;
  state: string;
  startedAt: number;
  endedAt: number | null;
  goals: string[];
  models: string[];
  summary: string | null;
}

/** Every string value under `key` anywhere in a JSON value (first `max`). */
function pick(v: unknown, key: string, max: number, out: string[] = []): string[] {
  if (out.length >= max || v == null || typeof v !== 'object') return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (out.length >= max) break;
    if (k === key && typeof x === 'string' && x.trim()) out.push(x.trim());
    else pick(x, key, max, out);
  }
  return out;
}

/** Recent helper runs from Hermes' state.db (read only). Empty when there is none or it can't be read. */
export function helperRuns(home: string, limit = 20): HelperRun[] {
  const file = path.join(home, 'state.db');
  if (!fs.existsSync(file)) return [];
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT delegation_id, state, dispatched_at, completed_at, task_json, result_json FROM async_delegations ORDER BY dispatched_at DESC LIMIT ?').all(Math.min(50, Math.max(1, limit))) as any[];
    const parse = (s: unknown) => { try { return s ? JSON.parse(String(s)) : null; } catch { return null; } };
    return rows.map((r) => {
      const task = parse(r.task_json);
      const result = parse(r.result_json);
      const summary = pick(result, 'summary', 1)[0] ?? null;
      return {
        id: String(r.delegation_id),
        state: String(r.state),
        startedAt: Math.round(Number(r.dispatched_at) * 1000),
        endedAt: r.completed_at ? Math.round(Number(r.completed_at) * 1000) : null,
        goals: pick(task, 'goal', 3).map((g) => g.slice(0, 200)),
        models: [...new Set(pick(result, 'model', 6))],
        summary: summary ? summary.slice(0, 400) : null,
      };
    });
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
