/**
 * The line above the message box that says what this conversation allows (conversation-allows.ts), with Turn
 * off. Worked out from the chat's own rows, the same way on every app: each approval card answered "Allow for
 * this conversation" that has not been turned off. The rows are the current conversation's, so a new
 * conversation starts with none. Pure; the Android app keeps a verbatim copy (mobile/src/allowedHere.ts,
 * checked by tests/conversation-allows.mjs).
 */

type RowLike = { seq: number; body: any };

export interface AllowedHere { approvalId: string; seq: number; label: string }

/** "Allow Leonard to delete a message?" → "delete a message"; a card's ruleLabel wins when it has one. */
export function allowedLabel(body: { title?: string; ruleLabel?: string }): string {
  if (typeof body.ruleLabel === 'string' && body.ruleLabel) return body.ruleLabel;
  const t = String(body.title ?? '').trim();
  const m = /^Allow .+? to (.+?)\??$/.exec(t);
  return (m ? m[1] : t.replace(/\?$/, '')) || 'an action';
}

/** What is allowed for this conversation, oldest first. */
export function allowedHere(rows: RowLike[]): AllowedHere[] {
  const out: AllowedHere[] = [];
  for (const r of rows) {
    const b = r.body;
    if (!b || b.type !== 'card' || b.card !== 'approval' || b.status !== 'conversation' || b.convOff) continue;
    out.push({ approvalId: String(b.approvalId), seq: r.seq, label: allowedLabel(b) });
  }
  return out;
}

/** The line's words: "Allowed in this conversation: X, Y and 2 more". */
export function allowedHereLine(list: AllowedHere[], max = 2): string {
  if (!list.length) return '';
  const names = [...new Set(list.map((a) => a.label))];
  const shown = names.slice(0, max).join(', ');
  return `Allowed in this conversation: ${shown}${names.length > max ? ` and ${names.length - max} more` : ''}`;
}
