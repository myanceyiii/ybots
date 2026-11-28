import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { ruleFor } from './allow-rules.js';

/**
 * "Allow for this conversation" (from OpenBot's docs/approvals.md): the bot does it now,
 * and does the same action again in this conversation without asking. The same chat, the same bot, the same
 * tool (for a browser kind: the same kind on the same site). It doesn't reach another chat, another
 * conversation of this chat, another bot or another tool.
 *
 * A conversation is a chat (a bot's main chat or one of its side chats) and its generation: "New
 * conversation" bumps the generation, so everything allowed here ends with it. The person can also turn
 * them off from the line above the message box (POST /api/bots/:id/allowed-here/off), and deleting the chat
 * removes them. Made only from a signed-in person's card answer (agent/loop.ts resolveApproval), exactly like
 * an "Always allow" rule; nothing a bot can reach makes, changes or removes one.
 *
 * Every call one lets through is written to allow_rule_log under `conv:<id>` (allow-rules.ts noteRuleUse), so the Permissions screens
 * show it as "allowed for this conversation".
 */

db.exec(`
CREATE TABLE IF NOT EXISTS conversation_allows (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  bot_id TEXT NOT NULL,
  tool TEXT NOT NULL COLLATE NOCASE,
  label TEXT NOT NULL,
  approval_id TEXT,
  created_by TEXT NOT NULL,
  created_via TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  UNIQUE (chat_id, generation, tool)
);
CREATE INDEX IF NOT EXISTS conversation_allows_bot ON conversation_allows(bot_id);
`);

const generationOf = (chatId: string) => (db.prepare('SELECT generation FROM bots WHERE id=?').get(chatId) as { generation?: number } | undefined)?.generation;

/** The conversation answer that lets this chat's bot use this tool unasked right now, if any. */
export function conversationAllowFor(chatId: string | undefined, tool: string): string | null {
  if (!chatId) return null;
  const gen = generationOf(chatId);
  if (gen === undefined) return null;
  const r = db.prepare('SELECT id FROM conversation_allows WHERE chat_id=? AND generation=? AND tool=? COLLATE NOCASE').get(chatId, gen, tool) as { id: string } | undefined;
  return r?.id ?? null;
}

/**
 * A standing answer for this call: the bot's "Always allow" rule, else this conversation's answer. The id is
 * what noteStandingUse logs (`conv:` marks a conversation answer).
 */
export function standingAllow(botId: string | undefined, chatId: string | undefined, tool: string): string | null {
  const rule = ruleFor(botId, tool);
  if (rule) return rule;
  const conv = conversationAllowFor(chatId, tool);
  return conv ? `conv:${conv}` : null;
}

/** Make (or keep) a conversation answer for each tool on a card. Called only from resolveApproval. */
export function createConversationAllows(o: { userId: string; chatId: string; botId: string; tools: string[]; labelOf: (tool: string) => string; createdBy: string; createdVia: string; approvalId: string }): void {
  const gen = generationOf(o.chatId);
  if (gen === undefined) return;
  const ins = db.prepare(`INSERT INTO conversation_allows(id,user_id,chat_id,generation,bot_id,tool,label,approval_id,created_by,created_via,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id,generation,tool) DO NOTHING`);
  db.transaction(() => {
    // Answers from earlier conversations of this chat can never apply again.
    db.prepare('DELETE FROM conversation_allows WHERE chat_id=? AND generation<>?').run(o.chatId, gen);
    for (const t of o.tools) ins.run(newId('cva'), o.userId, o.chatId, gen, o.botId, t, o.labelOf(t).slice(0, 200), o.approvalId, o.createdBy.slice(0, 200), o.createdVia, now());
  })();
}

export interface ConversationAllow { id: string; tool: string; label: string; createdBy: string; createdVia: string; createdAt: number; uses: number }

/** What is allowed in this chat's current conversation, oldest first. */
export function listConversationAllows(chatId: string): ConversationAllow[] {
  const gen = generationOf(chatId);
  if (gen === undefined) return [];
  return (db.prepare('SELECT * FROM conversation_allows WHERE chat_id=? AND generation=? ORDER BY created_at').all(chatId, gen) as any[])
    .map((r) => ({ id: r.id, tool: r.tool, label: r.label, createdBy: r.created_by, createdVia: r.created_via, createdAt: r.created_at, uses: r.uses }));
}

/** The browser kinds allowed in this chat's current conversation (rule keys browser_kind__*). */
export function conversationKindKeys(chatId: string | undefined): string[] {
  if (!chatId) return [];
  const gen = generationOf(chatId);
  if (gen === undefined) return [];
  return (db.prepare("SELECT tool FROM conversation_allows WHERE chat_id=? AND generation=? AND tool LIKE 'browser_kind__%'").all(chatId, gen) as { tool: string }[]).map((r) => r.tool);
}

/**
 * Turn off what is allowed in this chat's current conversation: one answer (`id`) or all of them. Returns the
 * approval ids whose cards should say so.
 */
export function turnOffConversation(userId: string, chatId: string, id?: string): string[] {
  const gen = generationOf(chatId);
  if (gen === undefined) return [];
  const rows = (id
    ? db.prepare('SELECT id, approval_id FROM conversation_allows WHERE user_id=? AND chat_id=? AND generation=? AND id=?').all(userId, chatId, gen, id)
    : db.prepare('SELECT id, approval_id FROM conversation_allows WHERE user_id=? AND chat_id=? AND generation=?').all(userId, chatId, gen)) as { id: string; approval_id: string | null }[];
  const del = db.prepare('DELETE FROM conversation_allows WHERE id=?');
  db.transaction(() => { for (const r of rows) del.run(r.id); })();
  const left = db.prepare('SELECT 1 FROM conversation_allows WHERE approval_id=? LIMIT 1');
  return [...new Set(rows.map((r) => r.approval_id).filter((x): x is string => !!x))].filter((a) => !left.get(a));
}
