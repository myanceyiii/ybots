import { Hono } from 'hono';
import { db, now } from './db.js';
import { requireUser, type AuthVars } from './lib/auth.js';

/**
 * Settings > Usage: how much every bot has been used, from the record each turn already leaves
 * (model_turns, kept 90 days): turns and tokens per day, per bot and per model, and how many turns failed.
 *
 * Only counts are given. No prices: the app does not know what each provider charges, and a made-up
 * figure would be worse than none.
 */

export interface UsageDay { day: string; turns: number; failed: number; inputTokens: number; outputTokens: number }
export interface UsageBot { botId: string; name: string; turns: number; failed: number; inputTokens: number; outputTokens: number; lastAt: number | null; topModel: string | null }
export interface UsageModel { provider: string | null; model: string; turns: number; failed: number; inputTokens: number; outputTokens: number }
export interface UsageReport { days: number; since: number; totals: { turns: number; failed: number; inputTokens: number; outputTokens: number }; byDay: UsageDay[]; byBot: UsageBot[]; byModel: UsageModel[] }

const DAY = 86_400_000;
const SUMS = 'COUNT(*) AS turns, SUM(CASE WHEN t.ok=0 THEN 1 ELSE 0 END) AS failed, COALESCE(SUM(t.input_tokens),0) AS input_tokens, COALESCE(SUM(t.output_tokens),0) AS output_tokens';
const shape = (r: any) => ({ turns: r.turns ?? 0, failed: r.failed ?? 0, inputTokens: r.input_tokens ?? 0, outputTokens: r.output_tokens ?? 0 });

/**
 * `tzOffsetMin` is what the app's clock is ahead of UTC by, in minutes (JavaScript's getTimezoneOffset,
 * negated), so a day here is the reader's day and not UTC's.
 */
export function usageReport(userId: string, days: number, tzOffsetMin: number): UsageReport {
  const shift = tzOffsetMin * 60_000;
  // Whole days: from the reader's midnight, `days - 1` days back, until now.
  const today = Math.floor((now() + shift) / DAY);
  const since = (today - (days - 1)) * DAY - shift;
  // A side chat or a helper is a hidden bot row of its own: its turns count for the bot it belongs to.
  const FROM = "FROM model_turns t JOIN bots b ON b.id=t.bot_id JOIN bots o ON o.id=COALESCE(b.side_of, b.id) WHERE b.user_id=? AND t.at>=?";
  const totals = shape(db.prepare(`SELECT ${SUMS} ${FROM}`).get(userId, since));
  const dayRows = db.prepare(`SELECT CAST((t.at + ?) / ${DAY} AS INTEGER) AS d, ${SUMS} ${FROM} GROUP BY d`).all(shift, userId, since) as any[];
  const byD = new Map<number, any>(dayRows.map((r) => [r.d, r]));
  const byDay: UsageDay[] = [];
  for (let d = today - (days - 1); d <= today; d++) byDay.push({ day: new Date(d * DAY).toISOString().slice(0, 10), ...shape(byD.get(d) ?? {}) });
  const botRows = db.prepare(`SELECT o.id AS bot_id, o.name AS name, MAX(t.at) AS last_at, ${SUMS} ${FROM} GROUP BY o.id ORDER BY turns DESC`).all(userId, since) as any[];
  const top = db.prepare(`SELECT o.id AS bot_id, t.model AS model, COUNT(*) AS n ${FROM} AND t.model IS NOT NULL GROUP BY o.id, t.model ORDER BY n DESC`).all(userId, since) as any[];
  const topOf = new Map<string, string>();
  for (const r of top) if (!topOf.has(r.bot_id)) topOf.set(r.bot_id, r.model);
  const modelRows = db.prepare(`SELECT t.provider AS provider, COALESCE(t.model, 'not recorded') AS model, ${SUMS} ${FROM} GROUP BY t.provider, COALESCE(t.model, 'not recorded') ORDER BY turns DESC LIMIT 30`).all(userId, since) as any[];
  return {
    days, since, totals, byDay,
    byBot: botRows.map((r) => ({ botId: r.bot_id, name: r.name, lastAt: r.last_at ?? null, topModel: topOf.get(r.bot_id) ?? null, ...shape(r) })),
    byModel: modelRows.map((r) => ({ provider: r.provider ?? null, model: r.model, ...shape(r) })),
  };
}

export const usageApi = new Hono<AuthVars>();
usageApi.use('/usage', requireUser);

usageApi.get('/usage', (c) => {
  const days = Math.min(90, Math.max(1, Math.floor(Number(c.req.query('days')) || 14)));
  const tz = Number(c.req.query('tz'));
  // Clocks run from UTC-12 to UTC+14; anything else is not a clock.
  const tzOffsetMin = Number.isFinite(tz) && tz >= -720 && tz <= 840 ? Math.round(tz) : 0;
  return c.json(usageReport(c.get('user').id, days, tzOffsetMin));
});
