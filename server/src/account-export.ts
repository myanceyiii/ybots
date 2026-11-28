import { Hono } from 'hono';
import { db, now } from './db.js';
import { requireUser, displayName, currentSession, type AuthVars } from './lib/auth.js';
import { inScope } from './lib/scope.js';
import { conversationMarkdown } from './chat-extras.js';
import { listConversations, listRoutines } from './store.js';

/**
 * Settings > Account > Download my data: everything the account has said and set up, as one file a person
 * can read or keep. Each bot and group with its settings, its routines, and every conversation (the open
 * one and the earlier ones) as text, side chats included.
 *
 * What is left out: sign-ins, keys and connections (secrets), files in the bots' folders (they have their
 * own Download), and tool steps. Only a person can ask for it, and a person who sees only some bots gets
 * only those.
 */

export interface AccountExport {
  format: 'yanceybot-account-export'; version: 1; exportedAt: string;
  account: { email: string; name: string };
  bots: {
    name: string; kind: 'bot' | 'group' | 'side chat'; of?: string; label: string | null; description: string | null; instructions: string | null; createdAt: string;
    routines: { name: string; schedule: string; description: string; enabled: boolean; prompt: string }[];
    conversations: { title: string; current: boolean; messages: number; startedAt: string; lastAt: string; markdown: string }[];
  }[];
  counts: { bots: number; conversations: number; messages: number };
}

const iso = (t: number | null | undefined) => new Date(t ?? 0).toISOString();

export function accountExport(user: { id: string; email: string; name: string }, you: string, allowed: (botId: string) => boolean): AccountExport {
  const rows = (db.prepare('SELECT * FROM bots WHERE user_id=? ORDER BY side_of IS NOT NULL, is_primary DESC, created_at').all(user.id) as any[]).filter((b) => allowed(b.id));
  const nameOf = new Map(rows.map((b) => [b.id as string, b.name as string]));
  let conversations = 0;
  let messages = 0;
  const bots = rows.map((b) => {
    const kind = b.side_of ? 'side chat' as const : b.kind === 'room' ? 'group' as const : 'bot' as const;
    const label = b.side_of ? `${b.name}: ${b.chat_title || 'Side chat'}` : b.name;
    const convs = listConversations(b.id).map((cv) => {
      conversations++; messages += cv.messages;
      return {
        title: cv.title, current: cv.current, messages: cv.messages, startedAt: iso(cv.startedAt), lastAt: iso(cv.lastAt),
        markdown: conversationMarkdown(b.id, cv.generation, `${kind === 'group' ? 'Group chat' : 'Chat with'} ${label}`, b.name, you),
      };
    });
    const routines = b.side_of ? [] : listRoutines(b.id).map((r) => ({ name: r.name, schedule: r.schedule, description: r.description, enabled: r.enabled, prompt: r.prompt }));
    return {
      name: label, kind, ...(b.side_of ? { of: nameOf.get(b.side_of) ?? '' } : {}),
      label: b.label ?? null, description: b.description ?? null, instructions: b.side_of ? null : b.instructions ?? null, createdAt: iso(b.created_at),
      routines, conversations: convs,
    };
  });
  return { format: 'yanceybot-account-export', version: 1, exportedAt: iso(now()), account: { email: user.email, name: user.name }, bots, counts: { bots: bots.filter((b) => b.kind !== 'side chat').length, conversations, messages } };
}

export const accountExportApi = new Hono<AuthVars>();
accountExportApi.use('/export/*', requireUser);

let lastAt = 0;
accountExportApi.get('/export/account', (c) => {
  const user = c.get('user');
  if (c.get('agent')) return c.json({ error: 'Only a person can download the account. This sign-in belongs to a helper program.', code: 'agent_session' }, 403);
  // Reading every conversation is the heaviest thing the server does in one go: not twice in a few seconds.
  if (Date.now() - lastAt < 5000) return c.json({ error: 'A download was made a moment ago. Try again in a few seconds.' }, 429);
  lastAt = Date.now();
  const scope = c.get('scope');
  const data = accountExport(user, displayName(user, currentSession(c)?.person ?? null) || 'You', (id) => inScope(scope, id));
  console.log(`[export] account ${user.id} downloaded the account: ${data.counts.bots} bot(s), ${data.counts.conversations} conversation(s), ${data.counts.messages} message(s)`);
  return c.json(data, 200, { 'Content-Disposition': `attachment; filename="ybots-${data.exportedAt.slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
});
