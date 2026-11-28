/**
 * Kinds of action (from OpenBot's docs/approvals.md, MIT, CopilotKit; the design is
 * borrowed, no code was copied): deleting, sending to other people, sharing, posting, paying and changing a
 * password or other credential. They are recognised by what the action is CALLED, never by what it carries:
 *
 *  - an app tool by its first verb (`delete_message` deletes; `mark_as_spam`, `list_archived`,
 *    `cancel_scheduled_send` do not, because their first verb is something else), or by its server's
 *    destructiveHint;
 *  - a browser button by how its label starts ("Send", "Yes, delete", "Move to trash"), and Ctrl/Cmd+Enter or
 *    Enter in a box for writing a message (browser-guard-page.ts holds those presses).
 *
 * What a kind changes:
 *  - its card says plainly what the action does, and offers Allow once, Allow for this conversation
 *    (conversation-allows.ts), Always allow and Don't allow;
 *  - an allow reaches a kind only when it was given on that kind's card. "Always allow" on a bot's browser
 *    clicks does not let it press a site's Send or Delete button: those are held in the page until the person
 *    allows that kind on that site (browser_kind__<kind>__<site>);
 *  - a server's read-only hint never lets a kind through without a card;
 *  - changing a password or security setting on a website is handed to the person ("I did it myself" /
 *    "Don't do it"): only they have it, so no answer can stand in for it.
 *
 * Unchanged: digest-bound cards answered once by a person, the full-email send card, purchase cards (paying in
 * the browser keeps its own hold, browser-guard.ts), and the owner's own apps.json `allow` lists.
 *
 * Pure: shared by the server and the web app (@shared/action-kinds). The page guard gets the button patterns
 * as regex source (KIND_BUTTON_SOURCE) so the two cannot drift.
 */

export type ActionKind = 'delete' | 'send' | 'share' | 'post' | 'pay' | 'credentials';
export const ACTION_KINDS: ActionKind[] = ['delete', 'send', 'share', 'post', 'pay', 'credentials'];

/** What the card says the action does. */
export const KIND_SAYS: Record<ActionKind, string> = {
  delete: 'This deletes something.',
  send: 'This sends something to other people.',
  share: 'This shares something with other people.',
  post: 'This posts or publishes something.',
  pay: 'This pays, buys or moves money.',
  credentials: 'This changes a password, a credential or a security setting.',
};

/** A short name, for the card's chip and the "allowed here" line. */
export const KIND_NAME: Record<ActionKind, string> = {
  delete: 'Delete', send: 'Send', share: 'Share', post: 'Post', pay: 'Pay', credentials: 'Password or security change',
};

const words = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Verbs that start a tool name. The first one found is the tool's action; only some of them are kinds. */
const VERBS = new Set([
  // not kinds
  'get', 'list', 'read', 'fetch', 'search', 'find', 'query', 'lookup', 'show', 'view', 'describe', 'count', 'check', 'download', 'export', 'preview',
  'create', 'add', 'new', 'make', 'insert', 'update', 'edit', 'modify', 'patch', 'set', 'put', 'save', 'write', 'rename', 'move', 'copy', 'upload', 'import',
  'mark', 'label', 'unlabel', 'tag', 'untag', 'star', 'unstar', 'flag', 'unflag', 'pin', 'unpin', 'like', 'unlike', 'bookmark', 'snooze', 'mute', 'unmute',
  'cancel', 'stop', 'pause', 'resume', 'start', 'run', 'sync', 'refresh', 'merge', 'split', 'restore', 'unarchive', 'untrash', 'undelete', 'draft', 'schedule', 'reschedule',
  'open', 'close', 'reopen', 'complete', 'accept', 'decline', 'approve', 'reject', 'assign', 'unassign', 'link', 'unlink', 'attach', 'detach', 'enable', 'disable',
  'login', 'logout', 'connect', 'disconnect', 'convert', 'calculate', 'generate', 'summarize', 'translate', 'transcribe', 'analyze', 'validate', 'verify', 'test',
  // kinds
  'delete', 'del', 'remove', 'rm', 'trash', 'destroy', 'erase', 'purge', 'wipe', 'discard', 'archive', 'drop', 'clear', 'empty', 'revoke',
  'send', 'reply', 'forward', 'respond', 'notify', 'broadcast', 'invite', 'comment', 'email', 'mail', 'sms', 'text', 'dm', 'message', 'call',
  'share', 'unshare', 'grant',
  'post', 'publish', 'tweet', 'retweet', 'repost', 'release', 'unpublish',
  'pay', 'transfer', 'payout', 'withdraw', 'deposit', 'charge', 'refund', 'purchase', 'buy', 'sell', 'trade', 'order', 'place', 'checkout', 'subscribe', 'upgrade', 'downgrade',
  'reset', 'rotate', 'regenerate', 'change',
]);

const DELETE_V = /^(delete|del|remove|rm|trash|destroy|erase|purge|wipe|discard|archive|drop|empty)$/;
const SEND_V = /^(send|reply|forward|respond|notify|broadcast|invite|comment|email|mail|sms|dm)$/;
const SHARE_V = /^(share|unshare|grant)$/;
const POST_V = /^(post|publish|tweet|retweet|repost|release)$/;
const PAY_V = /^(pay|transfer|payout|withdraw|charge|refund|purchase|buy|sell|trade|checkout|subscribe|upgrade|downgrade)$/;
const SHARE_N = /^(share|sharing|shared|permission|permissions|collaborator|collaborators|acl|access|members?)$/;
const CRED_N = /^(password|passwords|passwd|passcode|pin|2fa|mfa|totp|otp|credential|credentials|secret|secrets|apikey|key|keys|token|tokens|passkey|passkeys|security)$/;
const POST_N = /^(post|posts|tweet|tweets|thread|story|stories|reel|reels|status|update|release|releases)$/;
const PAY_N = /^(order|orders|instruction|instructions|payment|payments|invoice|invoices|payroll|subscription|plan)$/;

/**
 * The kind of an app or MCP tool, from its name (the part after `<app>__`) and its server's destructiveHint.
 * Null for everything else: reads and ordinary changes (drafting, editing, labelling, creating for yourself).
 */
export function toolKind(tool: string, opts: { destructive?: boolean } = {}): ActionKind | null {
  const name = tool.includes('__') ? tool.split('__').slice(1).join('__') : tool;
  const w = words(name);
  const at = w.findIndex((x) => VERBS.has(x));
  const verb = at >= 0 ? w[at] : '';
  const rest = at >= 0 ? w.slice(at + 1) : w;
  const has = (re: RegExp) => rest.some((x) => re.test(x));
  let kind: ActionKind | null = null;
  // An HTTP method in a generated name (STRIPE_POST_V1_PLANS_OVERVIEW) is not posting anything.
  if (/^(post|put|patch|delete|get)$/.test(verb) && /^v\d+$/.test(rest[0] ?? '')) return opts.destructive ? 'delete' : null;
  // Credentials first: "delete_api_key", "reset_password", "update_2fa", "rotate_token".
  if (/^(reset|rotate|regenerate|change|update|set|create|delete|revoke|remove|add|disable|enable)$/.test(verb) && has(CRED_N) && !has(/^(budget|category|categories|cache|filter)$/)) kind = 'credentials';
  // Sharing: "share_file", "grant_access", "add_collaborator", "update_permissions", "remove_member".
  else if (SHARE_V.test(verb) || (/^(add|create|insert|update|set|remove|delete|invite)$/.test(verb) && has(SHARE_N) && !has(/^(list|get)$/))) kind = 'share';
  else if (DELETE_V.test(verb) || (verb === 'clear' && has(/^(all|history|everything|inbox|calendar)$/))) kind = 'delete';
  else if (SEND_V.test(verb) || (verb === 'message' && rest.length > 0) || (verb === 'text' && has(/^(message|person|contact|number)$/))) kind = 'send';
  else if (POST_V.test(verb) || (/^(create|new|make|add)$/.test(verb) && has(POST_N) && !has(/^(draft|drafts)$/))) kind = 'post';
  else if (PAY_V.test(verb) || ((verb === 'place' || verb === 'create' || verb === 'submit') && has(PAY_N)) || (verb === 'order' && rest.length === 0)) kind = 'pay';
  // Moving money between budget categories is bookkeeping, not paying anyone.
  if (kind === 'pay' && w.some((x) => /^(budget|budgets|category|categories|envelope|envelopes)$/.test(x))) kind = null;
  if (!kind && opts.destructive) kind = 'delete';
  return kind;
}

// ---------------------------------------------------------------------------
// Browser buttons (used by browser-guard-page.ts, as regex source)

/**
 * A button label that STARTS with the action, per kind. Opening a folder called Sent, a tab called Posts or a
 * list called Shared with me is browsing; "Remove filter" and "Remove formatting" are editing (only an exact
 * "Remove" counts). Paying keeps the purchase hold's own, stricter list (browser-guard-page.ts PAY).
 */
export const KIND_BUTTONS: Record<Exclude<ActionKind, 'pay'>, string> = {
  delete: String.raw`^(?:yes,?\s+)?(?:delete|move to (?:the )?(?:trash|bin)|empty (?:the )?(?:trash|bin)|discard|erase|destroy)\b|^(?:yes,?\s+)?remove(?: permanently| forever| for everyone)?$`,
  send: String.raw`^(?:send|send now|send message|send email|send reply|send invite|send invitation|send it)\b(?!\s*(?:money|payment|[$€£¥]))|^(?:comment|reply|reply all|post comment|post reply)$`,
  share: String.raw`^(?:share|invite|add people|add collaborators?|grant access|give access)\b`,
  post: String.raw`^(?:post|publish|tweet|repost|retweet|go live)\b`,
  credentials: String.raw`^(?:change|update|reset|set|save|create)\s+(?:(?:your|my|the|new|a)\s+)*(?:password|passcode|pin|2fa|two.factor|two.step|security key|passkey|recovery (?:email|phone|codes?)|authenticator)\b|^(?:turn (?:on|off)|enable|disable|remove)\s+(?:two.factor|two.step|2fa|passkey|security key)\b`,
};

/** "Comment" and "Reply" alone often open a box rather than send one: they count only when text is written nearby. */
export const NEEDS_TEXT = String.raw`^(?:comment|reply|reply all)$`;

/** The kind a button label starts with, or null. (The page guard runs the same patterns.) */
export function buttonKind(label: string): Exclude<ActionKind, 'pay'> | null {
  const l = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (!l) return null;
  // Credentials before send/share: "Change password" starts with neither, but check the most specific first.
  for (const k of ['credentials', 'delete', 'share', 'post', 'send'] as const) if (new RegExp(KIND_BUTTONS[k], 'i').test(l)) return k;
  return null;
}

/** The regex sources the page guard is built with. */
export const KIND_BUTTON_SOURCE = JSON.stringify({ ...KIND_BUTTONS, needsText: NEEDS_TEXT });

// ---------------------------------------------------------------------------
// Standing answers for a browser kind

/** The rule key for a kind on a site: one bot, one kind, one site (www. dropped). */
export const browserKindKey = (kind: ActionKind, site: string) => `browser_kind__${kind}__${siteOf(site)}`;
export const siteOf = (hostOrOrigin: string) => {
  let h = String(hostOrOrigin ?? '').trim().toLowerCase();
  try { if (/^[a-z]+:\/\//.test(h)) h = new URL(h).hostname; } catch { /* keep */ }
  return h.replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '').slice(0, 120);
};
/** browser_kind__send__mail.google.com → { kind: 'send', site: 'mail.google.com' }. */
export function parseBrowserKindKey(key: string): { kind: ActionKind; site: string } | null {
  const m = /^browser_kind__([a-z]+)__(.+)$/i.exec(key);
  if (!m || !ACTION_KINDS.includes(m[1].toLowerCase() as ActionKind)) return null;
  return { kind: m[1].toLowerCase() as ActionKind, site: m[2].toLowerCase() };
}
const VERB_ON: Record<ActionKind, string> = {
  delete: 'Delete things', send: 'Send messages', share: 'Share things', post: 'Post', pay: 'Pay', credentials: 'Change passwords',
};
/** "Send messages on mail.google.com (browser)". */
export const browserKindLabel = (kind: ActionKind, site: string) => `${VERB_ON[kind]} on ${site} (browser)`;
