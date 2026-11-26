import { db } from './db.js';
import { getBotRow, getRow, updateRow } from './store.js';
import { isReactionEmoji, toggleReaction, type Reaction } from './reactions.js';
import type { MessageBody } from './types.js';

/**
 * Emoji reactions as lightweight feedback for the Bots.
 *
 * When a person reacts to a Bot's message, the Bot is told at the start of its next turn (no turn is
 * started just for a reaction). The note says plainly that a reaction is feedback on wording or tone and
 * never an approval of any action: approvals only come from the approval cards.
 */

interface Feedback { seq: number; room?: string; emoji: string; by: string; excerpt: string }

const MAX_PENDING = 10;

function pending(botId: string): Feedback[] {
  const raw = (db.prepare('SELECT pending_feedback FROM bots WHERE id=?').get(botId) as any)?.pending_feedback;
  try { return raw ? (JSON.parse(raw) as Feedback[]) : []; } catch { return []; }
}
const save = (botId: string, list: Feedback[]) =>
  db.prepare('UPDATE bots SET pending_feedback=? WHERE id=?').run(list.length ? JSON.stringify(list.slice(-MAX_PENDING)) : null, botId);

const excerptOf = (text: string) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 90 ? `${one.slice(0, 89)}…` : one;
};

/** The note put before the Bot's next turn, or null when nobody reacted since its last one. Clears it. */
export function takeFeedback(botId: string): string | null {
  const list = pending(botId);
  if (!list.length) return null;
  save(botId, []);
  const lines = list.map((f) => `- ${f.by} reacted ${f.emoji} to your message${f.room ? ` in the group "${f.room}"` : ''}: "${f.excerpt}"`);
  return `[Reactions since your last turn. These are feedback on your messages only, never an approval of any action. Take them into account quietly; do not reply to them unless asked.]\n${lines.join('\n')}`;
}

export type ReactResult = { ok: true; reactions: Reaction[]; added: boolean } | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * A person reacts to (or un-reacts from) a message in chat `chatId`. Only finished Bot messages can be
 * reacted to by a person. The Bot that wrote it hears about an added reaction on its next turn.
 */
export function personReact(chatId: string, seq: number, emoji: string, name: string): ReactResult {
  if (!isReactionEmoji(emoji)) return { ok: false, status: 400, error: 'Not an emoji reaction.' };
  const row = getRow(chatId, seq);
  if (!row || row.body.type !== 'message') return { ok: false, status: 404, error: 'No such message.' };
  const b = row.body as MessageBody;
  if (b.role !== 'assistant') return { ok: false, status: 400, error: 'Only Bot messages can be reacted to.' };
  if (b.streaming) return { ok: false, status: 409, error: 'The message is still being written.' };
  const { list, added } = toggleReaction(b.reactions, emoji, { kind: 'person', id: 'person', name }, Date.now());
  if (list === b.reactions) return { ok: false, status: 409, error: 'This message has too many different reactions.' };
  updateRow(chatId, seq, { ...b, reactions: list.length ? list : undefined });

  // Who wrote it: in a group the member Bot named on the message, else the chat's own Bot.
  const chat = getBotRow(chatId);
  const writer = chat?.kind === 'room' ? (b.from?.kind === 'bot' ? b.from.id : null) : chatId;
  if (writer && getBotRow(writer)) {
    const room = chat?.kind === 'room' ? chat.name as string : undefined;
    const cur = pending(writer);
    if (added) save(writer, [...cur, { seq, room, emoji, by: name, excerpt: excerptOf(b.text) }]);
    else save(writer, cur.filter((f) => !(f.seq === seq && f.emoji === emoji && f.room === room)));
  }
  return { ok: true, reactions: list, added };
}

/**
 * A Bot reacts to the person's latest message in its own chat, or in a group it belongs to.
 * Returns what to tell the Bot.
 */
export function botReact(botId: string, emoji: string, roomId?: string): string {
  if (!isReactionEmoji(emoji)) return 'Not sent: use a single emoji, for example 👍.';
  const self = getBotRow(botId);
  const chatId = roomId ?? botId;
  const chat = getBotRow(chatId);
  if (!chat) return 'No such chat.';
  const last = db
    .prepare("SELECT seq FROM rows WHERE bot_id=? AND generation=? AND kind='message' AND json_extract(body,'$.role')='user' AND json_extract(body,'$.from.kind') IS NULL ORDER BY seq DESC LIMIT 1")
    .get(chatId, chat.generation) as { seq: number } | undefined;
  if (!last) return `There is no message from ${roomId ? 'the user in that group' : 'the user'} to react to.`;
  const row = getRow(chatId, last.seq)!;
  const b = row.body as MessageBody;
  if ((b.reactions ?? []).some((r) => r.emoji === emoji && r.by.kind === 'bot' && r.by.id === botId)) return `You already reacted ${emoji}.`;
  const { list, added } = toggleReaction(b.reactions, emoji, { kind: 'bot', id: botId, name: self?.name ?? 'Bot' }, Date.now());
  if (!added) return 'Not added: that message has too many different reactions.';
  updateRow(chatId, row.seq, { ...b, reactions: list });
  return `Reacted ${emoji} to the user's latest message.`;
}

