/**
 * Which model a bot's turn runs on.
 *
 * Manual mode: the bot's own provider and model, exactly as chosen in settings (what the app always did).
 * Auto mode: the same provider, but one of three tiers (light, standard, heavy) picked per turn from how
 * hard the turn looks, so short and routine turns stop paying for the strongest model.
 *
 * The difficulty check is local and costs no tokens: it reads the turn's text and a little history.
 * It is a heuristic, so it errs toward "standard" when unsure, escalates after a failed turn, and is
 * sticky within a conversation, because Hermes' prompt cache is keyed to the model: every switch makes
 * the next request re-read the whole conversation at the uncached price (Hermes docs,
 * website/docs/user-guide/configuring-models.md, v0.22.7). Going up is immediate; going down needs two
 * lighter turns in a row (three once a conversation is long).
 *
 * Auto never changes provider. A provider lock (for Sheldon: the firm's ChatGPT sign-in) is checked
 * for manual and auto turns alike, and a turn that would break it does not run.
 *
 * Pure module: no database, so tests can load it on its own.
 */

export type Tier = 'light' | 'standard' | 'heavy';
export const TIERS: Tier[] = ['light', 'standard', 'heavy'];
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh'];

export interface TierChoice { model: string; effort: Effort }
export type TierMap = Record<Tier, TierChoice>;

export interface ModelPolicy {
  mode: 'manual' | 'auto';
  /** Used in manual mode, and as the provider for every tier in auto mode. */
  provider: string | null;
  model: string | null;
  effort: Effort;
  /** Auto mode's three models, all on `provider`. Missing tiers fall back to `model`. */
  tiers: Partial<TierMap> | null;
  /** When set, no turn may run on any other provider. */
  providerLock: string | null;
}

/** What the router remembers between turns of one conversation. */
export interface AutoState { generation: number; tier: Tier | null; lowerStreak: number; lastFailed: boolean }

export interface TurnFacts {
  text: string;
  /** user | routine | bot | system */
  source: 'user' | 'routine' | 'bot' | 'system';
  /** How many user turns this conversation already has. */
  priorTurns: number;
  /** The lowest tier this turn may use (the maintainer's own requests run heavy, like the Hermes dashboard). */
  minTier?: Tier;
}

export interface Classification { tier: Tier; score: number; reasons: string[] }

export interface Route {
  provider: string | null;
  model: string | null;
  effort: Effort;
  mode: 'manual' | 'auto';
  tier: Tier | null;
  reason: string;
  state: AutoState | null;
}

/**
 * Candidates for the "Use suggested tiers" button, best first per tier. These are only candidates:
 * a tier is suggested only when Hermes reports that exact id for the bot's signed-in account
 * (see suggestTiers). Nothing here is assumed to exist, so a stale id simply drops out.
 */
export const TIER_CANDIDATES: Record<string, { label: string; tiers: Record<Tier, string[]> }> = {
  anthropic: {
    label: 'Claude',
    tiers: {
      light: ['claude-haiku-5-5', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
      standard: ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6'],
      heavy: ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8'],
    },
  },
  // The bots' own Claude login (provider-catalog.ts SUBSCRIPTION). Hermes lists its models with a
  // "[1m]" suffix for the long-context variants; plain ids work too, so both are candidates.
  'claude-subscription-directsdk-experimental': {
    label: 'Claude subscription',
    tiers: {
      light: ['claude-haiku-5-5[1m]', 'claude-haiku-5-5', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
      standard: ['claude-sonnet-5-5[1m]', 'claude-sonnet-5-5', 'claude-sonnet-5[1m]', 'claude-sonnet-5'],
      heavy: ['claude-opus-5-5[1m]', 'claude-opus-5-5', 'claude-opus-5[1m]', 'claude-opus-5', 'claude-opus-4-8[1m]'],
    },
  },
  openrouter: {
    label: 'OpenRouter',
    tiers: {
      light: ['anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-4.5', 'openai/gpt-6-luna'],
      standard: ['anthropic/claude-sonnet-5.5', 'anthropic/claude-sonnet-5', 'openai/gpt-6.1-terra'],
      heavy: ['anthropic/claude-opus-5.5', 'anthropic/claude-opus-5', 'openai/gpt-6.2-sol'],
    },
  },
  'openai-codex': {
    label: 'ChatGPT',
    tiers: {
      light: ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.4-mini'],
      standard: ['gpt-6.1-terra', 'gpt-5.6-terra', 'gpt-5.5'],
      heavy: ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol'],
    },
  },
};

const PRESET_EFFORT: Record<Tier, Effort> = { light: 'low', standard: 'medium', heavy: 'high' };

/**
 * Suggested tiers for each signed-in provider, built only from the models Hermes reports for that
 * account. A tier with no reported candidate is left out; a provider with none is left out. When
 * Hermes gave no list (not answering, not signed in) the result is empty: show nothing, never guess.
 */
export function suggestTiers(available: { id: string; connected: boolean; models: string[] }[]): Record<string, { label: string; tiers: Partial<TierMap> }> {
  const out: Record<string, { label: string; tiers: Partial<TierMap> }> = {};
  for (const p of available) {
    const c = TIER_CANDIDATES[p.id];
    if (!c || !p.connected || !p.models.length) continue;
    const have = new Set(p.models);
    const tiers: Partial<TierMap> = {};
    for (const t of TIERS) {
      const model = c.tiers[t].find((m) => have.has(m));
      if (model) tiers[t] = { model, effort: PRESET_EFFORT[t] };
    }
    if (Object.keys(tiers).length) out[p.id] = { label: c.label, tiers };
  }
  return out;
}

// ---------- difficulty ----------

const HEAVY_WORK: [RegExp, string][] = [
  [/\b(plan|design|architect\w*|strateg\w*|roadmap)\b/i, 'planning'],
  [/\b(analy[sz]\w*|compare|evaluate|assess|investigat\w*|research|root cause|diagnos\w*|why (does|did|is|are)n?'?t?)\b/i, 'analysis'],
  [/\b(debug|refactor|implement|migrat\w*|code|script|function|regex|sql|stack ?trace|exception|compile)\b/i, 'code'],
  [/\b(contract|clause|brief|motion|pleading|statute|case law|deposition|discovery|negotiat\w*|legal)\b/i, 'legal'],
  [/\b(budget|tax(es)?|forecast|reconcil\w*|invest(ment|ments|ing|or|ors)?|mortgage|amortiz\w*|spreadsheet|financ\w*)\b/i, 'finance'],
  [/\b(write|draft|rewrite|edit|prepare)\b[^.?!\n]{0,40}\b(report|proposal|memo|letter|essay|plan|doc(ument)?|summary|article|email)\b/i, 'writing'],
  [/\b(step[- ]by[- ]step|in detail|thorough(ly)?|carefully|deep dive|prove|derive|calculate|estimate)\b/i, 'depth'],
];

const FORCE_HEAVY = /\b(think (hard|harder|carefully)|use (your|the) (best|strongest|smartest) model|take your time|be thorough)\b/i;
const FORCE_LIGHT = /\b(quick(ly)?|briefly|tl;?dr|one[- ]liner|short answer)\b/i;

const SMALL_TALK = /^\s*(hi|hey|hello|yo|thanks?( you)?|thank you|thx|ok(ay)?|k|cool|great|nice|perfect|got it|sounds good|yes|yep|yeah|no|nope|sure|good (morning|night|evening|afternoon)|lol|👍|🙏)\b[\s!.?]*$/i;
const SIMPLE_ASK = /\b(what time|what('s| is) the (time|date|weather)|weather|remind me|set (a|an) (timer|alarm|reminder)|add\b.{0,40}\bto (my |the )?(list|calendar|cart|groceries)|turn (on|off)|play|pause|what('s| is) on my (calendar|schedule)|how do you spell|define)\b/i;

/** How hard this turn looks. Errs toward standard; the caller adds stickiness and escalation. */
export function classify(f: TurnFacts, lastFailed = false): Classification {
  const text = f.text ?? '';
  const reasons: string[] = [];
  let score = 0;

  if (FORCE_HEAVY.test(text)) return { tier: 'heavy', score: 9, reasons: ['asked for careful work'] };

  // One kind of hard work is standard; two or more kinds, or one plus length or code, is heavy.
  const hits = HEAVY_WORK.filter(([re]) => re.test(text)).map(([, why]) => why);
  if (hits.length) { score += Math.min(4, hits.length * 2); reasons.push(hits.join(', ')); }

  const len = text.trim().length;
  if (len > 2000) { score += 2; reasons.push('long request'); }
  else if (len > 500) { score += 1; reasons.push('longer request'); }
  else if (len < 60 && !hits.length) { score -= 1; reasons.push('short'); }

  if (/```|^\s{4}\S|Traceback \(most recent|at \S+ \(\S+:\d+:\d+\)/m.test(text)) { score += 2; reasons.push('code or error output'); }
  const parts = (text.match(/^\s*(\d+[.)]|[-*•])\s+/gm) ?? []).length + Math.max(0, (text.match(/\?/g) ?? []).length - 1);
  if (parts >= 3) { score += 1; reasons.push('several parts'); }

  if (SMALL_TALK.test(text)) { score -= 3; reasons.push('small talk'); }
  else if (SIMPLE_ASK.test(text) && !hits.length) { score -= 2; reasons.push('simple ask'); }
  if (FORCE_LIGHT.test(text) && !hits.includes('code')) { score -= 1; reasons.push('asked for brief'); }

  if (f.source === 'system') { score -= 2; reasons.push('system notice'); }
  if (f.source === 'bot') { score -= 1; reasons.push('teammate message'); }

  let tier: Tier = score <= -1 ? 'light' : score >= 3 ? 'heavy' : 'standard';
  // After a failed turn, one tier up.
  if (lastFailed && tier !== 'heavy') { tier = TIERS[TIERS.indexOf(tier) + 1]; reasons.push('last turn failed'); }
  if (f.minTier && TIERS.indexOf(tier) < TIERS.indexOf(f.minTier)) { tier = f.minTier; reasons.push(`${f.minTier} for maintainer work`); }
  if (!reasons.length) reasons.push('ordinary request');
  return { tier, score, reasons };
}

// ---------- policy helpers ----------

const rank = (t: Tier) => TIERS.indexOf(t);

export function cleanEffort(v: unknown, dflt: Effort = 'medium'): Effort {
  return EFFORTS.includes(v as Effort) ? (v as Effort) : dflt;
}

/** Parses stored or posted tiers; drops anything malformed. */
export function cleanTiers(raw: unknown): Partial<TierMap> | null {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== 'object') return null;
  const out: Partial<TierMap> = {};
  for (const t of TIERS) {
    const c = (v as any)[t];
    const model = typeof c?.model === 'string' ? c.model.trim().slice(0, 120) : '';
    // Square brackets are part of real ids: the Claude subscription lists "claude-sonnet-5-5[1m]".
    if (model && /^[\w./:@+[\]-]+$/.test(model)) out[t] = { model, effort: cleanEffort(c.effort, t === 'light' ? 'low' : t === 'heavy' ? 'high' : 'medium') };
  }
  return Object.keys(out).length ? out : null;
}

export function freshState(generation: number): AutoState {
  return { generation, tier: null, lowerStreak: 0, lastFailed: false };
}

export function parseState(raw: unknown, generation: number): AutoState {
  try {
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (s && s.generation === generation && (s.tier === null || TIERS.includes(s.tier))) {
      return { generation, tier: s.tier, lowerStreak: Number(s.lowerStreak) || 0, lastFailed: !!s.lastFailed };
    }
  } catch { /* fall through */ }
  return freshState(generation);
}

/** Why a provider would break the lock, or null when it is fine. */
export function lockViolation(policy: Pick<ModelPolicy, 'providerLock'>, provider: string | null): string | null {
  if (!policy.providerLock) return null;
  if (provider === policy.providerLock) return null;
  return `This bot is locked to the ${policy.providerLock} provider, so it will not run on ${provider ?? 'the engine default'}.`;
}

/**
 * The model for one turn. `state` is this conversation's auto state; the returned route carries the
 * next state to store (null in manual mode).
 */
export function route(policy: ModelPolicy, facts: TurnFacts, state: AutoState): Route {
  if (policy.mode !== 'auto') {
    return { provider: policy.provider, model: policy.model, effort: policy.effort, mode: 'manual', tier: null, reason: 'manual choice', state: null };
  }
  const c = classify(facts, state.lastFailed);
  let tier = c.tier;
  let streak = 0;
  let why = c.reasons.join('; ');
  if (state.tier && rank(tier) < rank(state.tier)) {
    // Going down costs a cache re-read, so only after two lighter turns in a row.
    // In a long conversation the re-read costs more, so it waits one turn longer.
    streak = state.lowerStreak + 1;
    if (streak < (facts.priorTurns >= 20 ? 3 : 2)) { tier = state.tier; why = `staying on ${tier} (${why})`; }
    else streak = 0;
  }
  // A tier without its own model uses the next one up that has one, then the manual model.
  const order: Tier[] = tier === 'light' ? ['light', 'standard', 'heavy'] : tier === 'standard' ? ['standard', 'heavy'] : ['heavy'];
  const found = order.map((t) => ({ t, c: policy.tiers?.[t] })).find((x) => x.c);
  const pick = found?.c ?? null;
  return {
    provider: policy.provider,
    model: pick?.model ?? policy.model,
    effort: pick?.effort ?? policy.effort,
    mode: 'auto',
    tier,
    reason: found && found.t !== tier ? `${why}; no ${tier} model set, using ${found.t}` : pick ? why : `${why}; no tier models set, using the manual model`,
    state: { generation: state.generation, tier, lowerStreak: streak, lastFailed: false },
  };
}
