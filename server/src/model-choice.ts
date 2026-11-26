import { db, now } from './db.js';
import {
  cleanEffort, cleanTiers, lockViolation, parseState, route, type ModelPolicy, type Route, type TurnFacts,
} from './model-router.js';
import { isMaintainer } from './maintainer-guard.js';
import type { ModelRouteInfo, ModelUsageSummary } from './types.js';

/** A bot row's model settings as the router sees them. */
export function policyOf(bot: any): ModelPolicy {
  return {
    mode: bot.model_mode === 'auto' ? 'auto' : 'manual',
    provider: bot.provider ?? null,
    model: bot.model ?? null,
    effort: cleanEffort(bot.effort),
    tiers: cleanTiers(bot.model_tiers),
    providerLock: bot.provider_lock ?? null,
  };
}

/** How many user turns the current conversation has had (the router's stickiness reads it). */
function priorTurns(botId: string, generation: number): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM rows WHERE bot_id=? AND generation=? AND kind='message' AND body LIKE '%\"role\":\"user\"%'").get(botId, generation) as any;
  return Number(r?.n ?? 0);
}

export class ProviderLockError extends Error {}

/**
 * The model for this turn. Throws ProviderLockError when the result would break the bot's provider
 * lock, so the turn stops before anything is sent.
 */
export function chooseModel(bot: any, facts: Omit<TurnFacts, 'priorTurns'>): Route {
  const policy = policyOf(bot);
  const state = parseState(bot.auto_state, bot.generation);
  // The maintainer (Howard) gets the strongest tier for anything the owner asks: a job given in his
  // chat should run like it does in the Hermes dashboard (2026-11-25: 50 of 54 app turns had run on the
  // standard or light tier and he stopped early). Routines, notices and teammates' messages still route.
  const minTier = facts.source === 'user' && isMaintainer(bot.side_of ?? bot.id) ? 'heavy' as const : undefined;
  const r = route(policy, { ...facts, minTier, priorTurns: priorTurns(bot.id, bot.generation) }, state);
  const bad = lockViolation(policy, r.provider);
  if (bad) throw new ProviderLockError(bad);
  if (r.state) db.prepare('UPDATE bots SET auto_state=? WHERE id=?').run(JSON.stringify(r.state), bot.id);
  return r;
}

/**
 * Failures a stronger model would not fix: sign-in, credentials, quota, network. Escalating on these
 * only makes the retry dearer (seen on Host2: a missing ChatGPT sign-in sent the next turn to Opus).
 */
const NOT_THE_MODEL = /credential|auth|sign[- ]?in|log ?in|api[_ ]?key|unauthori[sz]ed|forbidden|\b(401|403|429|5\d\d)\b|rate.?limit|quota|insufficient|billing|timed? ?out|timeout|ECONN|ENOTFOUND|network|not answering|no .*agent/i;

export function failureEscalates(error: string | null | undefined): boolean {
  return !!error && !NOT_THE_MODEL.test(error);
}

/** Records how the turn went: the usage view reads it, and a model-shaped failure makes the next auto turn escalate. */
export function recordTurn(bot: any, r: Route, ok: boolean, usage: { input_tokens?: number; output_tokens?: number } | null, error: string | null = null) {
  db.prepare('INSERT INTO model_turns (bot_id, at, mode, tier, provider, model, reason, ok, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?)')
    // A side chat's turns count as its bot's (side-chats.ts): the usage view is per bot.
    .run(bot.side_of ?? bot.id, now(), r.mode, r.tier, r.provider, r.model, (ok || !error ? r.reason : `${r.reason}; failed: ${error}`).slice(0, 300), ok ? 1 : 0,
      Number.isFinite(usage?.input_tokens) ? usage!.input_tokens : null, Number.isFinite(usage?.output_tokens) ? usage!.output_tokens : null);
  if (r.state && !ok && failureEscalates(error)) {
    db.prepare('UPDATE bots SET auto_state=? WHERE id=?').run(JSON.stringify({ ...r.state, lastFailed: true }), bot.id);
  }
  // Keep about 90 days.
  db.prepare('DELETE FROM model_turns WHERE bot_id=? AND at < ?').run(bot.id, now() - 90 * 86_400_000);
}

export function lastRoute(botId: string): ModelRouteInfo | null {
  const r = db.prepare('SELECT * FROM model_turns WHERE bot_id=? ORDER BY id DESC LIMIT 1').get(botId) as any;
  return r ? { at: r.at, mode: r.mode, tier: r.tier, provider: r.provider, model: r.model, reason: r.reason, ok: !!r.ok } : null;
}

export function usageSummary(botId: string, days: number): ModelUsageSummary {
  const since = now() - days * 86_400_000;
  const rows = db.prepare(`SELECT COALESCE(tier,'manual') AS tier, model, COUNT(*) AS turns,
      COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens
    FROM model_turns WHERE bot_id=? AND at>=? GROUP BY COALESCE(tier,'manual'), model ORDER BY turns DESC`).all(botId, since) as any[];
  return {
    days,
    rows: rows.map((r) => ({ tier: r.tier, model: r.model, turns: r.turns, inputTokens: r.input_tokens, outputTokens: r.output_tokens })),
  };
}
