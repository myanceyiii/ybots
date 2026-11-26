import { db, now } from './db.js';
import { getBotRow, getRow, updateRow } from './store.js';
import { isWorkBar, shortText } from './board-pin.js';

/**
 * A progress bar that can never move again says so.
 *
 * A bot shows a view with a progress block, then moves it with update_view as it works. If the turn ends
 * first (a tool failed, the bot gave up, the user pressed Stop, the server restarted), nothing is left to
 * move the bar and the card would sit at "Step 1 of 3" for good. So when a turn ends, every work bar
 * (see isWorkBar; a gauge meant to sit part-full is left alone) the bot showed or moved during that turn
 * that is not full gets a "Stopped" note, kept beside its last step. The bot can still move it later with update_view; the note goes away when it does (views.ts drops
 * unknown fields and the bot's new note replaces this one).
 *
 * Only the note changes, a field every app already draws, so web, Windows and Android all show it.
 */

type Block = { id: string; type: string; label?: string; value?: number; max?: number; note?: string; live?: boolean; stopped?: { at: number; reason: string; step?: string } };

const STOPPED = /^Stopped\b/;
// A bar that tracks work (live, counts steps, or moved this turn), as opposed to a gauge meant to sit part-full.
// Shared with pinned boards (board-pin.ts).

function stallBlocks(blocks: Block[], reason: string, moved: boolean): Block[] | null {
  let changed = false;
  const out = blocks.map((b) => {
    if (b.type !== 'progress' || b.stopped || !isWorkBar(b, moved)) return b;
    const max = Number(b.max) > 0 ? Number(b.max) : 100;
    if ((Number(b.value) || 0) >= max) return b;
    changed = true;
    const last = b.note && !STOPPED.test(b.note) ? b.note : '';
    // The note says it in whole words (never cut mid-word); the full last step is kept on `stopped.step`.
    const note = `Stopped: ${reason}${last ? ` (last step: ${shortText(last, Math.max(30, 110 - reason.length - 22))})` : ''}`;
    return { ...b, note, stopped: { at: now(), reason, ...(last ? { step: last } : {}) } };
  });
  return changed ? out : null;
}

/** Mark one view card's unfinished bars stopped; true when it changed. */
function stallCard(targetId: string, seq: number, reason: string, movedSince: number): boolean {
  const row = getRow(targetId, seq);
  const body = row?.body as any;
  if (!body || body.type !== 'card' || body.card !== 'view' || !Array.isArray(body.blocks)) return false;
  const blocks = stallBlocks(body.blocks, reason, Number(body.updatedAt) >= movedSince);
  if (!blocks) return false;
  updateRow(targetId, seq, { ...body, blocks, updatedAt: now() });
  return true;
}

/**
 * At the end of a turn in `chatId` (a bot's main chat, a side chat, or a group the bot was answering):
 * views by `botId` in that chat that were shown or moved since `since` and still have a bar short of full.
 */
export function stallTurnViews(botId: string, chatIds: string[], since: number, reason: string): number {
  const targets = [...new Set(chatIds.filter(Boolean))];
  if (!targets.length) return 0;
  const recs = db.prepare(`SELECT view_id, target_id, seq, created_at FROM view_cards WHERE bot_id=? AND target_id IN (${targets.map(() => '?').join(',')}) AND created_at >= ?`)
    .all(botId, ...targets, since - 24 * 3600_000) as { view_id: string; target_id: string; seq: number; created_at: number }[];
  let n = 0;
  for (const r of recs) {
    const body = getRow(r.target_id, r.seq)?.body as any;
    const touched = Math.max(r.created_at, Number(body?.updatedAt) || 0);
    if (touched < since) continue;
    if (stallCard(r.target_id, r.seq, reason, since)) n++;
  }
  return n;
}

/**
 * After a server restart no turn is running, so any bar short of full from the last day can never move.
 * Views the bot moved in the last minute are left alone (a turn may be starting up again right now).
 */
export function stallViewsAfterRestart(): number {
  const since = now() - 24 * 3600_000;
  const recs = db.prepare('SELECT view_id, target_id, seq, bot_id FROM view_cards WHERE created_at >= ?').all(since) as { view_id: string; target_id: string; seq: number; bot_id: string }[];
  let n = 0;
  for (const r of recs) {
    if (!getBotRow(r.target_id)) continue;
    const body = getRow(r.target_id, r.seq)?.body as any;
    if (Number(body?.updatedAt) > now() - 60_000) continue;
    if (stallCard(r.target_id, r.seq, 'the app restarted before it finished', now() - 30 * 60_000)) n++;
  }
  return n;
}
