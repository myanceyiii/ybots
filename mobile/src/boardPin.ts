/**
 * Pinned boards: a bot's progress or checklist view that stays in reach above the message box until it is
 * no longer useful, on web, Windows and Android (the apps draw the dock; this decides what is pinned).
 *
 * The pin lives on the card itself (`pin` on the view card row), so every device sees the same thing, it
 * survives a restart, and the original card stays in the chat where it was. Pure functions, no database.
 *
 * - Pins itself when a view tracks work: a progress bar the bot marked live or that counts steps, or any
 *   progress bar or unticked checklist the bot moves with update_view.
 * - The bot can pin any view with `pin: true`. `pin: false` unpins or keeps out any view except a job (a live
 *   or step-counting bar that is not full): a job always pins and lets go when it is done or stopped. A person pins or unpins from the
 *   card or the dock (POST /bots/:id/cards/:seq/pin); a person's unpin sticks until the person or the bot pins it again.
 * - `doneAt` is set once every bar is full and every item is ticked; the apps let it go 10 minutes later.
 *   The apps also show "Paused" after an hour with no update and let it go after a day (see BOARD_TIMES).
 * - A bar marked stopped when its turn ended (view-stall.ts) shows "Stopped" and is let go after an hour,
 *   unless the bot moves it again (which clears the stop).
 * - boardLine is what the one-line strip says: whole-phrase summaries, never a title or step cut mid-word.
 */

export type Pin = { on: boolean; by: 'auto' | 'bot' | 'person'; at: number; doneAt?: number };

type Block = { id?: string; type: string; label?: string; value?: number; max?: number; note?: string; live?: boolean; items?: { done?: boolean }[]; stopped?: { at: number; reason: string; step?: string } };

/** How long the apps keep a finished board, when a quiet one shows "Paused", and when it is let go. */
export const BOARD_TIMES = { doneMs: 10 * 60_000, pausedMs: 60 * 60_000, stoppedMs: 60 * 60_000, expireMs: 24 * 60 * 60_000 } as const;

const STEP = /\bstep\s+\d+\s*(?:of|\/)\s*\d+/i;

/**
 * A bar that tracks work in progress, as opposed to a gauge ("$600 of $1,000 spent") that is meant to sit
 * part-full: the bot marked it live, its note counts steps, or the bot moved it with update_view.
 */
export const isWorkBar = (b: Block, moved: boolean) => !!b.live || STEP.test(`${b.note ?? ''} ${b.label ?? ''}`) || moved;

/** A view that tracks work worth keeping in reach. */
export function tracksWork(blocks: Block[], moved: boolean): boolean {
  return blocks.some((b) => (b.type === 'progress' && isWorkBar(b, moved) && (b.value ?? 0) < (b.max ?? 100))
    || (moved && b.type === 'checklist' && (b.items ?? []).some((i) => !i.done)));
}

/** Every bar full and every item ticked (and there is at least one of them). */
export function isComplete(blocks: Block[]): boolean {
  const tracked = blocks.filter((b) => b.type === 'progress' || b.type === 'checklist');
  if (!tracked.length) return false;
  return tracked.every((b) => (b.type === 'progress' ? (b.value ?? 0) >= (b.max ?? 100) : (b.items ?? []).every((i) => i.done)));
}

/**
 * The card's pin after a change. `moved`: the bot changed it with update_view. `bot`: the bot's own pin
 * flag, if it passed one. `person`: a person pressed pin or unpin. Returns undefined when it was never pinned.
 */
export function nextPin(card: { blocks: Block[]; pin?: Pin; quick?: boolean }, o: { moved?: boolean; bot?: boolean; person?: boolean; now: number }): Pin | undefined {
  if (card.quick) return card.pin;
  const prev = card.pin;
  let pin: Pin | undefined;
  // A job (a live or step-counting bar that is not full; a gauge the bot moves is not one) pins itself and
  // stays pinned until it is done or stopped: the bot's pin: false is ignored for it, and an older bot unpin
  // ends when the bot moves the job. Only a person's unpin sticks.
  const job = tracksWork(card.blocks, false);
  if (o.person !== undefined) pin = { on: o.person, by: 'person', at: o.now };
  else if (o.bot === true) pin = { on: true, by: 'bot', at: o.now };
  else if (o.bot === false) pin = !job ? { on: false, by: 'bot', at: o.now } : prev?.on ? prev : { on: true, by: 'auto', at: o.now };
  else if (prev && !(prev.by === 'bot' && !prev.on && job && o.moved)) pin = prev;
  else if (tracksWork(card.blocks, !!o.moved)) pin = { on: true, by: 'auto', at: o.now };
  if (!pin) return undefined;
  const out: Pin = { on: pin.on, by: pin.by, at: pin.at };
  if (pin.on && isComplete(card.blocks)) out.doneAt = prev?.doneAt ?? o.now;
  return out;
}

/** Apply nextPin to a card, dropping the field when there is no pin. */
export function withPin<T extends { blocks: Block[]; pin?: Pin; quick?: boolean }>(card: T, o: Parameters<typeof nextPin>[1]): T {
  const pin = nextPin(card, o);
  const { pin: _old, ...rest } = card;
  return (pin ? { ...rest, pin } : rest) as T;
}

/** A bar the bot left unfinished when its turn ended (view-stall.ts), if any. */
export function stoppedBar(blocks: Block[] | undefined): Block | undefined {
  return (blocks ?? []).find((b) => b.type === 'progress' && b.stopped && (b.value ?? 0) < (b.max ?? 100));
}

export type BoardState = 'live' | 'paused' | 'stopped' | 'done';

/**
 * Whether the apps show a pinned card in the dock now, and how: 'live', 'paused' (no update for an hour),
 * 'stopped' (its turn ended before it finished; shown for an hour), 'done' (finished, still inside its
 * 10 minutes), or null (not shown). Shared by web and Android (mobile/src/boardPin.ts is a verbatim copy,
 * checked by tests/board-pin.mjs).
 */
export function boardState(card: { pin?: Pin; updatedAt?: number; blocks?: Block[] }, createdAt: number, now: number): BoardState | null {
  const p = card.pin;
  if (!p?.on) return null;
  if (p.doneAt) return now - p.doneAt < BOARD_TIMES.doneMs ? 'done' : null;
  const stop = stoppedBar(card.blocks);
  if (stop) return now - Math.max(stop.stopped!.at, p.at) < BOARD_TIMES.stoppedMs ? 'stopped' : null;
  const last = Math.max(card.updatedAt ?? 0, createdAt, p.at);
  if (now - last >= BOARD_TIMES.expireMs) return null;
  return now - last >= BOARD_TIMES.pausedMs ? 'paused' : 'live';
}

const SMALL = /^(?:a|an|the|and|or|but|of|to|for|with|in|on|at|by|from|as|is|are|was|were|be|its|their|your|my)$/i;
const CLAUSE = /\s*(?:[;:]\s|\s[—–-]\s|\s·\s|\.\s)\s*/;
const PHRASE = /,\s|\s(?:and|then|while|but|so|because|with|for|from|into|against|using|via|before|after|until|on|in)\s/i;

/**
 * A short form of `text` that ends on a whole phrase: the text itself when it fits, else without
 * parentheses, else its first clause, else its first phrase ("Copying every receipt from the drive into…"
 * becomes "Copying every receipt"). Whole words with "…" only when nothing shorter makes sense.
 */
export function shortText(text: string | undefined, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const bare = t.replace(/\s*\([^)]*(?:\)|$)/g, '').trim() || t;
  if (bare.length <= max) return bare;
  const tidy = (x: string) => x.replace(/[.,;:·]+$/, '').trim();
  const clause = tidy(bare.split(CLAUSE)[0]) || bare;
  if (clause.length <= max) return clause;
  // The longest run of leading phrases that fits, as long as it is more than one word.
  const parts = clause.split(new RegExp(`(${PHRASE.source})`, 'i'));
  let best = '';
  for (let i = 0, acc = ''; i < parts.length; i += 2) {
    acc += (i ? parts[i - 1] : '') + parts[i];
    const c = tidy(acc);
    if (c.length > max) break;
    if (c.includes(' ')) best = c;
  }
  if (best) return best;
  const words = clause.split(' ');
  const out: string[] = [];
  for (const w of words) {
    if ([...out, w].join(' ').length > max - 1) break;
    out.push(w);
  }
  while (out.length > 1 && SMALL.test(out[out.length - 1])) out.pop();
  if (!out.length) return `${words[0].slice(0, Math.max(1, max - 1))}…`;
  return `${tidy(out.join(' '))}…`;
}

const STEP_LEAD = /^(step\s+\d+\s*(?:of|\/)\s*\d+)\s*(?:[:·\-–—]|,)\s*(.+)$/i;

/** A step note in whole words: "Step 2 of 4 · Writing the unit file" keeps the count and the gist. */
function shortStep(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const m = STEP_LEAD.exec(t);
  if (m) { const rest = shortText(m[2], max - m[1].length - 3); return rest ? `${m[1]} · ${rest[0].toUpperCase()}${rest.slice(1)}` : m[1]; }
  return shortText(t, max);
}

/** The step a stopped bar had reached, from the stop record or its "(last step: …)" note. */
function lastStep(b: Block): string {
  if (b.stopped?.step) return b.stopped.step;
  const m = /\(last step: (.*?)(\))?$/.exec(b.note ?? '');
  if (!m) return '';
  // Older notes were cut at 120 characters, mid-word: keep only the whole clauses before the cut.
  if (!m[2]) { const whole = m[1].split(CLAUSE); return whole.length > 1 ? whole.slice(0, -1).join('; ') : m[1]; }
  return m[1];
}

/**
 * What the strip says for a board: a title and a step summarized to whole phrases (the full words are in
 * `fullTitle` / `fullStep` for a tooltip and in the open board), and how far along it is (0 to 100).
 */
export function boardLine(card: { title?: string; blocks?: Block[] }, o: { title?: number; step?: number } = {}): { title: string; fullTitle: string; step: string; fullStep: string; pct: number | null; stopped: boolean } {
  const blocks = card.blocks ?? [];
  const fullTitle = (card.title ?? '').trim() || 'Progress';
  const title = shortText(fullTitle, o.title ?? 90);
  const max = o.step ?? 64;
  const bar = blocks.find((b) => b.type === 'progress');
  const list = blocks.find((b) => b.type === 'checklist');
  const ticked = list ? (list.items ?? []).filter((i) => i.done).length : 0;
  const count = list ? `${ticked} of ${(list.items ?? []).length} done` : '';
  const stop = stoppedBar(blocks);
  if (stop) {
    const step = lastStep(stop);
    const pct = Math.round((Math.min(stop.value ?? 0, stop.max ?? 100) / (stop.max ?? 100)) * 100);
    return { title, fullTitle, step: step ? `Stopped after: ${shortStep(step, max - 15)}` : 'Stopped before it finished', fullStep: stop.note ?? '', pct, stopped: true };
  }
  if (bar) {
    const full = bar.note || bar.label || count;
    const pct = Math.round((Math.min(bar.value ?? 0, bar.max ?? 100) / (bar.max ?? 100)) * 100);
    return { title, fullTitle, step: shortStep(full ?? '', max), fullStep: full ?? '', pct, stopped: false };
  }
  if (list) return { title, fullTitle, step: count, fullStep: count, pct: (list.items ?? []).length ? Math.round((ticked / (list.items ?? []).length) * 100) : 0, stopped: false };
  return { title, fullTitle, step: '', fullStep: '', pct: null, stopped: false };
}
