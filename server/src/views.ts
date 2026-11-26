import { findRoomFor } from './agent/rooms.js';
import { db, now } from './db.js';
import { blockContent, type BlockType } from './pages.js';
import { chartData } from './page-chart.js';
import { safeUrl } from './plugins/ui-schema.js';
import { isOutside } from './outside.js';
import { isSilo } from './silo.js';
import { appendRow, getBotRow, getRow, updateRow } from './store.js';
import { runCalc, type CalcInput } from './calc.js';
import { calcBlock, calcMessage, calcValues, cleanCalcValues, inputText } from './calc-block.js';
import crypto from 'node:crypto';
import { withPin } from './board-pin.js';
import type { CardBody, ViewBlock } from './types.js';

/**
 * Answer views: a small set of interactive pieces a bot puts straight into its reply (a table, a chart,
 * a pick-one, a form, a checklist, key numbers), the way ChatGPT's answers mix text and visuals.
 *
 * A view is data, never code. It uses the Page block vocabulary (pages.ts) so the apps draw it with the same
 * components, plus three display-only kinds (stats, progress, link). The rules match Pages:
 *  - ticking, picking and typing only change the card's saved state;
 *  - Send on a choice, a form or a button posts an ordinary chat message as the person who pressed it, so
 *    the bot acts on it like anything they type and every action still goes through approval cards;
 *  - a view can never approve anything: it holds no approval ids or digests, and bots cannot press it
 *    (the route is for signed-in people only).
 */

export const VIEW_TYPES = ['heading', 'text', 'callout', 'table', 'chart', 'stats', 'progress', 'checklist', 'choice', 'form', 'button', 'link', 'code', 'divider', 'calc'] as const;
export type ViewType = (typeof VIEW_TYPES)[number];
const PAGE_KINDS = new Set<string>(['heading', 'text', 'callout', 'table', 'chart', 'checklist', 'choice', 'form', 'button', 'code', 'divider']);

export const VIEW_LIMITS = { blocks: 30, rows: 50, columns: 8, items: 40, options: 12, fields: 12, stats: 8, labels: 60, series: 6, text: 4000, calcInputs: 10, calcOutputs: 8 } as const;

type Card = Extract<CardBody, { card: 'view' }>;
const s = (v: unknown, max: number) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
const ID = /^[\w-]{1,40}$/;

/** One block from a bot's loose input, checked and clipped. Unknown kinds are reported, not guessed. */
function oneBlock(raw: any, id: string): ViewBlock | string {
  const type = String(raw?.type ?? '') as ViewType;
  if (!(VIEW_TYPES as readonly string[]).includes(type)) return `unknown block type "${s(raw?.type, 30)}"`;
  if (PAGE_KINDS.has(type)) {
    const c: any = blockContent(type as BlockType, raw);
    if (type === 'text' || type === 'callout') c.md = s(c.md, VIEW_LIMITS.text);
    if (type === 'table') {
      c.columns = c.columns.slice(0, VIEW_LIMITS.columns);
      c.rows = c.rows.slice(0, VIEW_LIMITS.rows).map((r: string[]) => r.slice(0, VIEW_LIMITS.columns).map((x) => s(x, 300)));
      if (!c.columns.length && !c.rows.length) return 'a table needs columns or rows';
    }
    if (type === 'chart') {
      c.labels = c.labels.slice(0, VIEW_LIMITS.labels);
      c.series = c.series.slice(0, VIEW_LIMITS.series).map((x: any) => ({ ...x, values: x.values.slice(0, VIEW_LIMITS.labels) }));
    }
    if (type === 'checklist') { c.items = c.items.slice(0, VIEW_LIMITS.items); if (!c.items.length) return 'a checklist needs items'; }
    if (type === 'choice') {
      c.options = c.options.slice(0, VIEW_LIMITS.options);
      c.picked = c.picked.filter((n: number) => n < c.options.length);
      // One option is enough when an "Other" box gives the second way to answer (choice buttons for
      // 'Reply "approve all" or tell me which to change', choices.ts).
      if (raw?.other === true && !c.multi && c.options.length === 1) c.other = true;
      if ((c.options.length < 2 && !c.other) || !c.options.length || !c.question) return 'a choice needs a question and at least two options';
    }
    if (type === 'form') {
      c.fields = c.fields.slice(0, VIEW_LIMITS.fields).map((f: any) => ({ ...f, value: s(f.value, 2000) }));
      if (!c.fields.length) return 'a form needs fields';
      delete c.submittedAt;
    }
    if (type === 'button' && !c.message) c.message = c.label;
    return { id, type, ...c };
  }
  switch (type) {
    case 'stats': {
      const items = (Array.isArray(raw?.items) ? raw.items : []).slice(0, VIEW_LIMITS.stats)
        .map((x: any) => ({ label: s(x?.label, 80), value: s(x?.value, 40), ...(x?.note ? { note: s(x.note, 120) } : {}), ...(['good', 'warn', 'bad'].includes(x?.tone) ? { tone: x.tone } : {}) }))
        .filter((x: any) => x.label || x.value);
      return items.length ? { id, type, title: raw?.title ? s(raw.title, 120) : undefined, items } : 'stats need items with a label and value';
    }
    case 'progress': {
      const max = Number(raw?.max) > 0 ? Number(raw.max) : 100;
      const value = Math.max(0, Math.min(max, Number(raw?.value) || 0));
      // A bar marked stopped when a turn ended (view-stall.ts) loses that note once the bot moves it again.
      const note = raw?.stopped && typeof raw?.note === 'string' && raw.note.startsWith('Stopped') ? '' : raw?.note;
      return { id, type, label: s(raw?.label, 120), value, max, ...(note ? { note: s(note, 120) } : {}), ...(raw?.live === true ? { live: true } : {}) };
    }
    case 'calc': return calcBlock(raw, id);
    case 'link': {
      const url = safeUrl(raw?.url);
      return url ? { id, type, label: s(raw?.label, 80) || url, url } : 'a link needs an https url';
    }
  }
  return `unknown block type "${type}"`;
}


/** A bot's view, checked. Bad blocks are dropped and reported back to the bot so it can fix them. */
export function makeView(title: unknown, rawBlocks: unknown): { card: Card; problems: string[] } {
  const list = Array.isArray(rawBlocks) ? rawBlocks : [];
  const problems: string[] = [];
  if (list.length > VIEW_LIMITS.blocks) problems.push(`only the first ${VIEW_LIMITS.blocks} blocks are shown`);
  const used = new Set<string>();
  const blocks: ViewBlock[] = [];
  list.slice(0, VIEW_LIMITS.blocks).forEach((raw: any, i) => {
    let id = typeof raw?.id === 'string' && ID.test(raw.id) ? raw.id : `v${i + 1}`;
    while (used.has(id)) id = `${id}_${i + 1}`;
    const b = oneBlock(raw, id);
    if (typeof b === 'string') problems.push(`block ${i + 1}: ${b}`);
    else { used.add(id); blocks.push(b); }
  });
  const t = s(title, 120).trim();
  const card: Card = { type: 'card', card: 'view', title: t, blocks, text: '' };
  card.text = viewText(card);
  return { card, problems };
}

/** The view as plain markdown: for previews, notifications, voice, Slack, other bots and older apps. */
export function viewText(v: { title: string; blocks: ViewBlock[] }): string {
  const out: string[] = [];
  if (v.title) out.push(`**${v.title}**`);
  for (const b of v.blocks as any[]) {
    switch (b.type) {
      case 'heading': out.push(`**${b.text}**`); break;
      case 'text': out.push(b.md); break;
      case 'callout': out.push(`> ${String(b.md).replace(/\n/g, '\n> ')}`); break;
      case 'table': {
        const w = Math.max(b.columns.length, ...b.rows.map((r: string[]) => r.length), 1);
        const row = (r: string[]) => `| ${Array.from({ length: w }, (_, i) => String(r[i] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`;
        out.push([...(b.title ? [`**${b.title}**`, ''] : []), row(b.columns), `|${' --- |'.repeat(w)}`, ...b.rows.map(row)].join('\n'));
        break;
      }
      case 'chart': {
        const d = chartData(b, v);
        out.push(`${b.title ? `**${b.title}**: ` : ''}${d.labels.map((l, i) => `${l} ${d.series.map((x) => x.values[i] ?? '').join('/')}`).join(', ')}`);
        break;
      }
      case 'stats': out.push(b.items.map((x: any) => `- **${x.label}:** ${x.value}${x.note ? ` (${x.note})` : ''}`).join('\n')); break;
      case 'progress': out.push(`${b.label}: ${b.value} of ${b.max}`); break;
      case 'checklist': out.push([...(b.title ? [`**${b.title}**`] : []), ...b.items.map((it: any) => `- [${it.done ? 'x' : ' '}] ${it.text}`)].join('\n')); break;
      case 'choice': out.push(`${b.question}\n${b.options.map((o: string, i: number) => `- ${b.picked.includes(i) ? '(picked) ' : ''}${o}`).join('\n')}${b.otherText ? `\n- (answered) ${b.otherText}` : ''}`); break;
      case 'form': out.push(`${b.title ?? 'Form'}: ${b.fields.map((f: any) => f.label).join(', ')}`); break;
      case 'link': out.push(`[${b.label}](${b.url})`); break;
      case 'calc': {
        const vals = calcValues(b);
        const res = runCalc(b.inputs, b.outputs, vals);
        out.push([...(b.title ? [`**${b.title}**`] : []), ...b.inputs.map((i: CalcInput) => `- ${i.label}: ${inputText(i, vals[i.id])}`), ...res.map((r) => `- **${r.label}: ${r.text}**`)].join('\n'));
        break;
      }
      case 'code': out.push(`\`\`\`${b.lang ?? ''}\n${b.code}\n\`\`\``); break;
    }
  }
  return out.filter(Boolean).join('\n\n').slice(0, 20_000);
}

export class ViewError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

/**
 * A person's change to a view: tick, pick, type, or send. Returns the new card and, for a send, the chat
 * message to post as that person. Only the parts a person may change are touched; the bot's content is not.
 */
export function applyViewOp(card: Card, op: any, by?: string): { card: Card; message?: string; context?: string } {
  const blocks = card.blocks.map((b) => ({ ...b })) as any[];
  const b = blocks.find((x) => x.id === op?.block);
  if (!b) throw new ViewError('That part of the view is gone.');
  const where = card.title ? ` ("${card.title}")` : '';
  let message: string | undefined;
  let context: string | undefined;
  switch (op.op) {
    case 'check': {
      if (b.type !== 'checklist') throw new ViewError('check works on checklists');
      b.items = b.items.map((it: any) => (it.id === op.item ? { ...it, done: !!op.done } : it));
      break;
    }
    case 'pick': {
      if (b.type !== 'choice') throw new ViewError('pick works on choices');
      if (b.sentAt) throw new ViewError('Already sent.', 409);
      const picked = (Array.isArray(op.picked) ? op.picked : []).filter((n: any) => Number.isInteger(n) && n >= 0 && n < b.options.length);
      // Choice buttons (choices.ts) with "Other": the person's own words instead of an option.
      const other = b.other && !b.multi && typeof op.text === 'string' ? op.text.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
      if (b.other && typeof op.text === 'string' && !other) throw new ViewError('Type your answer first.');
      b.picked = other ? [] : b.multi ? [...new Set<number>(picked)].sort((x, y) => x - y) : picked.slice(0, 1);
      if (other) b.otherText = other;
      // A single pick is the answer itself, so it is sent straight away.
      if (!b.multi && (b.picked.length || other)) {
        b.sentAt = now();
        if (by) b.pickedBy = s(by, 80);
        const answer = other || b.options[b.picked[0]];
        // Choice buttons read like a typed reply ("Yes"); the bot is told which question it answers.
        if (card.quick) { message = answer; context = `[Answer to "${b.question}"] ${answer}`; }
        else message = `${b.question} ${answer}`;
      }
      break;
    }
    case 'field': {
      if (b.type !== 'form') throw new ViewError('field works on forms');
      if (b.sentAt) throw new ViewError('Already sent.', 409);
      b.fields = b.fields.map((f: any) => (f.id === op.field ? { ...f, value: s(op.value, 2000) } : f));
      break;
    }
    case 'calc': {
      if (b.type !== 'calc') throw new ViewError('calc works on calculators');
      b.values = cleanCalcValues(b, op.values);
      break;
    }
    case 'send': {
      if (b.type === 'calc') {
        // A calculator can be sent again after more changes: the bot gets the numbers as they are now.
        if (op.values && typeof op.values === 'object') b.values = cleanCalcValues(b, op.values);
        b.sentAt = now();
        message = calcMessage(b, where);
      } else if (b.type === 'choice') {
        if (b.sentAt) throw new ViewError('Already sent.', 409);
        if (!b.picked.length) throw new ViewError('Pick at least one first.');
        b.sentAt = now();
        message = `${b.question} ${b.picked.map((i: number) => b.options[i]).join(', ')}`;
      } else if (b.type === 'form') {
        if (b.sentAt) throw new ViewError('Already sent.', 409);
        // The app sends what is in the boxes with Send, so nothing typed is lost to a save still on its way.
        if (op.values && typeof op.values === 'object') b.fields = b.fields.map((f: any) => (typeof op.values[f.id] === 'string' ? { ...f, value: s(op.values[f.id], 2000) } : f));
        b.sentAt = now();
        message = `${b.title ? `${b.title}${where}` : `Form${where}`}:\n${b.fields.map((f: any) => `- ${f.label}: ${f.value || '(blank)'}`).join('\n')}`;
      } else if (b.type === 'button') {
        b.sentAt = now();
        message = b.message || b.label;
      } else throw new ViewError('Nothing to send there.');
      break;
    }
    default: throw new ViewError('unknown change');
  }
  // A tick can finish a pinned board (board-pin.ts), so its pin is worked out again.
  const next: Card = withPin({ ...card, blocks }, { now: now() });
  next.text = viewText(next);
  return { card: next, ...(message ? { message } : {}), ...(context ? { context } : {}) };
}

/**
 * Where a bot's view goes: its own chat, or a group it belongs to (group_name). Returns the target id or
 * a reason it cannot post there.
 */
export function viewTarget(botId: string, groupName?: string): { id: string } | { error: string } {
  if (!groupName?.trim()) return { id: botId };
  const found = findRoomFor(botId, groupName);
  return 'error' in found ? found : { id: found.room.id };
}

db.exec(`CREATE TABLE IF NOT EXISTS view_cards (
  view_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  bot_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);

/** Post a bot's checked view as a card row (and count it unread in a group). Returns the row and the view's id. */
export function postView(targetId: string, card: Card, from: { id: string; name: string }, isGroup: boolean, pin?: boolean) {
  const viewId = `vw_${crypto.randomBytes(5).toString('hex')}`;
  const row = appendRow(targetId, 'card', withPin({ ...card, viewId, ...(isGroup ? { from } : {}) }, { bot: pin, now: now() }));
  db.prepare('INSERT INTO view_cards(view_id,target_id,seq,bot_id,created_at) VALUES (?,?,?,?,?)').run(viewId, targetId, row.seq, from.id, now());
  if (isGroup) db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(targetId);
  return { row, viewId };
}

/**
 * What a person already did on a block (ticks, picks, typing, calculator values, a Send), carried over when
 * the bot redraws that block with the same id and type. The bot changes its content, never the person's part.
 */
function carryState(old: any, next: any): any {
  if (!old || old.type !== next.type) return next;
  const out = { ...next };
  if (old.sentAt) out.sentAt = old.sentAt;
  switch (next.type) {
    case 'checklist': {
      const done = new Map<string, boolean>(old.items.map((i: any) => [i.text, i.done]));
      out.items = next.items.map((i: any) => (done.has(i.text) ? { ...i, done: done.get(i.text) } : i));
      break;
    }
    case 'choice':
      if (JSON.stringify(old.options) === JSON.stringify(next.options)) out.picked = old.picked;
      else delete out.sentAt;
      break;
    case 'form': {
      const vals = new Map<string, string>(old.fields.map((f: any) => [f.id, f.value]));
      out.fields = next.fields.map((f: any) => (vals.get(f.id) ? { ...f, value: vals.get(f.id) } : f));
      break;
    }
    case 'calc':
      if (old.values) out.values = cleanCalcValues(next, old.values);
      break;
  }
  return out;
}

/**
 * A bot changes a view it showed: a new title, whole new blocks, or some blocks changed by id (a progress
 * bar moving, fresh numbers). Only the bot that made the view can change it, and only while it is still in
 * the chat. What the person already ticked, picked or typed stays.
 */
export function updateView(botId: string, viewId: string, a: { title?: unknown; blocks?: unknown; changes?: unknown; pin?: unknown }): { ok: true; problems: string[]; blocks: { id: string; type: string }[] } | { ok: false; error: string } {
  const rec = db.prepare('SELECT * FROM view_cards WHERE view_id=?').get(String(viewId ?? '').trim()) as any;
  if (!rec || rec.bot_id !== botId) return { ok: false, error: `No view of yours with id "${viewId}".` };
  if (!getBotRow(rec.target_id)) return { ok: false, error: 'That chat is gone.' };
  const row = getRow(rec.target_id, rec.seq);
  if (!row || row.body.type !== 'card' || row.body.card !== 'view' || row.body.viewId !== rec.view_id) return { ok: false, error: 'That view is no longer in the chat (it was cleared).' };
  const card = row.body as Card;
  const problems: string[] = [];
  let blocks = card.blocks as any[];
  if (a.blocks !== undefined) {
    const made = makeView(card.title, a.blocks);
    problems.push(...made.problems);
    if (!made.card.blocks.length) return { ok: false, error: `Nothing to show: ${problems.join('; ') || 'no blocks'}.` };
    const before = new Map(blocks.map((b) => [b.id, b]));
    blocks = made.card.blocks.map((b) => carryState(before.get(b.id), b));
  }
  if (a.changes !== undefined) {
    const list = Array.isArray(a.changes) ? a.changes : [];
    for (const [i, ch] of list.slice(0, VIEW_LIMITS.blocks).entries()) {
      const at = blocks.findIndex((b) => b.id === ch?.id);
      if (at < 0) { problems.push(`change ${i + 1}: no block with id "${s(ch?.id, 40)}"`); continue; }
      const { id: _id, type: _type, ...fields } = ch as any;
      const merged = oneBlock({ ...blocks[at], ...fields, type: blocks[at].type }, blocks[at].id);
      if (typeof merged === 'string') { problems.push(`change ${i + 1}: ${merged}`); continue; }
      blocks = blocks.map((b, j) => (j === at ? carryState(b, merged) : b));
    }
  }
  const title = a.title !== undefined ? s(a.title, 120).trim() : card.title;
  let next: Card = { ...card, title, blocks, updatedAt: now() };
  next.text = viewText(next);
  next = withPin(next, { moved: true, bot: typeof a.pin === 'boolean' ? a.pin : undefined, now: now() });
  updateRow(rec.target_id, rec.seq, next);
  return { ok: true, problems, blocks: blocks.map((b) => ({ id: b.id, type: b.type })) };
}

/**
 * A view as Page blocks (Open as Page): the same content in blocks a Page has, with what the person did kept.
 * Stats and calculators become tables, progress and links become text, and a chart gets its numbers inline
 * (a Page chart's `from` would name a Page block id).
 */
export function viewToPageBlocks(card: Card): any[] {
  const out: any[] = [];
  for (const b of card.blocks as any[]) {
    switch (b.type) {
      case 'chart': { const d = chartData(b, card); out.push({ type: 'chart', chart: b.chart, title: b.title, labels: d.labels, series: d.series }); break; }
      case 'stats': out.push({ type: 'table', title: b.title, columns: ['', 'Value', 'Note'], rows: b.items.map((x: any) => [x.label, x.value, x.note ?? '']) }); break;
      case 'progress': out.push({ type: 'text', md: `**${b.label}:** ${b.value} of ${b.max} (${Math.round((b.value / b.max) * 100)}%)${b.note ? `. ${b.note}` : ''}` }); break;
      case 'link': out.push({ type: 'text', md: `[${b.label}](${b.url})` }); break;
      // A calculator stays a calculator on the Page, with the person's numbers, so it keeps working there.
      case 'calc': { const { id: _id, sentAt: _s, ...rest } = b; out.push({ ...rest, values: calcValues(b) }); break; }
      default: { const { id: _id, sentAt: _s, ...rest } = b; out.push(rest); }
    }
  }
  return out;
}
