/**
 * The running side of the shared provider catalog (provider-catalog.ts):
 *  - Check: one real, tiny request from a bot's own agent to one provider and model, recorded as
 *    "verified" (or the error it gave). It goes through the same gateway, credentials and plugins the
 *    bot's chat turns use, with every tool refused and nothing stored in the bot's conversations.
 *  - Refresh: a managed bot's agent started with an older provider setup (a shared key that changed,
 *    the subscription switched, a new plugin, or the move of the Anthropic key out of its environment)
 *    is restarted once it is idle, so the setup it runs with is the one settings show.
 */
import { db, now } from './db.js';
import { engineFor, engineKind, primaryBotId, providerFingerprint, restartEngine, startedProviderFingerprint } from './engine.js';
import { restartPrimaryIfPending } from './primary-providers.js';
import { withToolsOff } from './list-summary.js';
import { isAnyChatBusy } from './agent/loop.js';
import { refreshBlocker } from './mcp.js';
import { answeredBy, catalogEntry, SUBSCRIPTION } from './provider-catalog.js';
import type { ProviderCheckResult } from './types.js';

export class CheckError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 502 = 400) { super(message); }
}

const CHECK_INSTRUCTIONS = 'This is a connection check from the app. Reply with exactly the two letters OK and nothing else. Do not use any tools.';

/** Error text without anything that looks like a key or token. */
export function scrub(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-…')
    .replace(/(bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1…')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export type CheckResult = ProviderCheckResult;

/** Make one check request and record it. Throws CheckError when it cannot be made at all. */
export async function checkProvider(bot: any, provider: string, model: string): Promise<CheckResult> {
  const kind = engineKind(bot.id);
  if (kind !== 'managed' && kind !== 'primary') throw new CheckError(`${bot.name}'s agent is not run by this app, so it cannot be checked from here.`, 409);
  if (provider === SUBSCRIPTION && !bot.claude_subscription) {
    throw new CheckError(`The Claude subscription route is switched off for ${bot.name}. Switch it on first.`, 409);
  }
  if (isAnyChatBusy(bot.id)) throw new CheckError(`${bot.name} is working on something. Check again when it has finished.`, 409);
  const engine = await engineFor(bot.id);
  const t0 = Date.now();
  let ok = false;
  let detail = '';
  let returned: string | null = null;
  let usage: { input_tokens?: number; output_tokens?: number } | null = null;
  try {
    const raw = await withToolsOff(bot.id, async () => {
      const res = await fetch(`${engine.url}/v1/responses`, {
        method: 'POST',
        signal: AbortSignal.timeout(120_000),
        headers: { 'content-type': 'application/json', ...(engine.key ? { authorization: `Bearer ${engine.key}` } : {}) },
        body: JSON.stringify({ model, provider, instructions: CHECK_INSTRUCTIONS, input: 'Connection check: reply OK.', stream: false, store: false, model_options: { reasoning_effort: 'low' } }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`the agent answered ${res.status}: ${text.slice(0, 400)}`);
      return text;
    });
    const data = JSON.parse(raw);
    usage = data?.usage ?? null;
    const parts: string[] = [];
    if (typeof data?.output_text === 'string') parts.push(data.output_text);
    for (const item of data?.output ?? []) if (item?.type === 'message') for (const c of item.content ?? []) if (typeof c?.text === 'string') parts.push(c.text);
    const text = parts.join(' ').trim();
    const by = answeredBy(model, data?.model);
    returned = by.returned;
    if (data?.status === 'failed' || data?.error) detail = scrub(String(data?.error?.message ?? data?.error ?? 'the request failed'));
    else if (!text) detail = 'The agent returned an empty answer.';
    else if (!by.same) detail = `Answered by ${by.returned}, not ${model}: probably a fallback, so this route is not verified.`;
    else { ok = true; detail = `Answered "${text.slice(0, 40)}"${by.returned ? ` from ${by.returned}` : ''}.`; }
  } catch (e: any) {
    detail = scrub(String(e?.message ?? e));
  }
  const ms = Date.now() - t0;
  const at = now();
  db.prepare(`INSERT INTO provider_checks (bot_id, provider, model, at, ok, detail, ms, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(bot_id, provider, model) DO UPDATE SET at=excluded.at, ok=excluded.ok, detail=excluded.detail, ms=excluded.ms, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens`)
    .run(bot.id, provider, model, at, ok ? 1 : 0, detail, ms, Number.isFinite(usage?.input_tokens) ? usage!.input_tokens : null, Number.isFinite(usage?.output_tokens) ? usage!.output_tokens : null);
  console.log(`[providers] check ${bot.name} ${provider}/${model}: ${ok ? 'ok' : 'failed'} in ${ms} ms${ok ? '' : ` (${detail})`}`);
  return { ok, provider, model, answeredBy: returned, detail, ms, at };
}

/** A provider id the catalog or the bot's agent knows: the only ones a check or a setting may name. */
export function knownProvider(id: string, listed: { id: string }[]): boolean {
  return !!catalogEntry(id) || listed.some((p) => p.id === id);
}

// ---------- refresh ----------

const lastRestart = new Map<string, number>();
const COOLDOWN_MS = 10 * 60_000;

/** One pass: restart each idle managed bot whose agent runs an older provider setup. Returns who was restarted. */
export async function refreshProviderSetups(restart: (botId: string) => Promise<void> = restartEngine): Promise<string[]> {
  const done: string[] = [];
  for (const b of db.prepare("SELECT id, name FROM bots WHERE engine='managed'").all() as { id: string; name: string }[]) {
    if (startedProviderFingerprint(b.id) === providerFingerprint(b.id)) continue;
    if (Date.now() - (lastRestart.get(b.id) ?? 0) < COOLDOWN_MS) continue;
    if (refreshBlocker(b.id)) continue;
    lastRestart.set(b.id, Date.now());
    console.log(`[providers] ${b.name}'s agent runs an older provider setup; restarting it now that it is idle`);
    try { await restart(b.id); done.push(b.id); } catch (e: any) { console.warn(`[providers] restart of ${b.name}'s agent failed: ${e?.message ?? e}`); }
  }
  return done;
}

/**
 * The owner's own agent, after a provider change it only picks up on start: restarted with
 * PRIMARY_RESTART_COMMAND once no app turn is running, no approval card waits, and its own session
 * store (Telegram, the dashboard, ...) has been quiet for a few minutes (primary-providers.ts).
 */
export function primaryRefreshBlocker(): string | null {
  const id = primaryBotId();
  if (!id) return 'no primary bot';
  if (isAnyChatBusy(id)) return 'a turn is running';
  const waiting = db.prepare("SELECT count(*) n FROM approvals WHERE bot_id=? AND status='pending'").get(id) as { n: number };
  if (waiting.n) return 'an approval card is waiting';
  return null;
}

let timer: NodeJS.Timeout | null = null;
export function startProviderRefresh() {
  if (timer) return;
  const tick = () => {
    refreshProviderSetups().catch((e) => console.warn('[providers] refresh pass failed', e));
    restartPrimaryIfPending(primaryRefreshBlocker()).catch((e) => console.warn('[providers] primary restart pass failed', e));
  };
  setTimeout(tick, 120_000).unref();
  timer = setInterval(tick, 60_000);
  timer.unref();
}
