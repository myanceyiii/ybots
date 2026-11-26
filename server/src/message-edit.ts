import { getRow, updateRow } from './store.js';
import { editChanged, plainText } from './message-text.js';
import type { MessageBody } from './types.js';

/**
 * Editing a message you sent.
 *
 * An edit never changes history the Bot has already seen: the new words go out as a new message (a new
 * turn, like anything you type), and the old message stays in the chat marked "Edited" with a pointer to
 * the new one. The Bot is told the new message replaces the earlier one.
 *
 * Only a person's own typed messages can be edited: not a Bot's message, a routine's, a voice call's, a
 * script's, or any approval or question card (those are not message rows). An edit is an ordinary new
 * message, so like any new message it expires a waiting approval and never approves anything.
 */

export type EditCheck = { ok: true; original: MessageBody } | { ok: false; status: 400 | 404 | 409; error: string };

/** Checks that message `seq` in chat `chatId` is one of the person's own messages that can be edited into `words`. */
export function checkEdit(chatId: string, seq: unknown, words: string): EditCheck {
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return { ok: false, status: 400, error: 'Which message to edit is missing.' };
  const row = getRow(chatId, seq);
  if (!row || row.body.type !== 'message') return { ok: false, status: 404, error: 'That message is no longer in this chat.' };
  const b = row.body as MessageBody;
  if (b.role !== 'user' || b.from) return { ok: false, status: 400, error: 'Only messages you typed yourself can be edited.' };
  if (b.editedTo) return { ok: false, status: 409, error: 'That message was already edited. Edit the newer version instead.' };
  if (!editChanged(b.text, words)) return { ok: false, status: 400, error: 'Nothing was changed.' };
  return { ok: true, original: b };
}

/** Marks the earlier message as edited, pointing at its new version. */
export function markEdited(chatId: string, seq: number, original: MessageBody, newSeq: number) {
  updateRow(chatId, seq, { ...original, editedTo: newSeq });
}

const short = (text: string) => {
  // No @names in the note, so a group's @mentions are read from the new words only.
  const one = plainText(text).replace(/\s+/g, ' ').replace(/@/g, '').trim();
  return one.length > 200 ? `${one.slice(0, 199)}…` : one;
};

/** The line put before the new words for the Bot. */
export function editNote(original: MessageBody): string {
  return `[The person edited their earlier message "${short(original.text)}". This new version replaces it; answer this one.]`;
}
