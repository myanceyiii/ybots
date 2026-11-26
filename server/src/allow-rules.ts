import crypto from 'node:crypto';
import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { appInfo, findAppTool } from './local-apps.js';

/**
 * "Always allow": standing rules the owner makes from an approval card.
 *
 * A rule lets ONE bot use ONE tool without a card from then on. It is made only by a signed-in person
 * pressing "Always allow" on a card for their own bot (routes.ts → agent/loop.ts resolveApproval), on
 * the web, in the Windows app or in the phone app with the card's digest. Nothing a bot can reach
 * (/mcp, the gate) creates, changes or removes a rule, and a plugin approval stage can still make a
 * call ask or refuse it (plugins/policy.ts): a rule only ever turns the default "ask" into "allow".
 * Fixed rules (apps.json `ask`/`block`, an app's read-only mode, a stored "Don't allow") always win.
 *
 * Every card that lists its tools offers it, whatever the tool: what is risky enough to keep asking is
 * the owner's call, not the app's (Alex, 2026-11-23). Tools in a risky class (shell and code, file
 * writes, deleting, sending messages or mail, money, host or PC administration, installing things,
 * browser clicks and typing, computer control, scheduling) get a plain warning on the card instead
 * (`alwaysAllowFor`), and the card carries `risk` so other parts (notifications) can treat them with care.
 *
 * Helpers a bot starts run in the bot's own Hermes and are checked with the bot's id, so they get the
 * bot's rules and nothing more. Every time a rule lets a call through, a line goes into
 * allow_rule_log; the settings screens show the rules with who made them, when, and how often they were used.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS allow_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  tool TEXT NOT NULL COLLATE NOCASE,
  label TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_via TEXT NOT NULL,
  approval_id TEXT,
  created_at INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  UNIQUE (bot_id, tool)
);
CREATE TABLE IF NOT EXISTS allow_rule_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_sha TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS allow_rule_log_bot ON allow_rule_log(bot_id, at);
`);

// ---------------------------------------------------------------------------
// Which tools may have a standing rule

const WHY = {
  shell: 'This can run commands or code.',
  files: 'This can write or change files.',
  delete: 'This can delete things.',
  message: 'This can send messages or mail for you.',
  money: 'This can move money or change your budget.',
  host: 'This can change a server or PC.',
  install: 'This can install software.',
  browser: 'This can click and type on websites, which can submit forms or buy things.',
  computer: 'This can control a computer.',
  schedule: 'This can set up work that runs later without asking.',
} as const;
export type RiskClass = keyof typeof WHY;

/** Hermes' own tools that never get a rule. */
const HERMES_RISKY: Record<string, RiskClass> = {
  terminal: 'shell', execute_code: 'shell', process_manage: 'shell', close_terminal: 'shell',
  write_file: 'files', patch: 'files', computer_use: 'computer', cronjob_manage: 'schedule',
  send_message: 'message',
};
/** Browser tools that only look are fine; anything that acts on a page is not. */
const BROWSER_LOOKS = /^browser_(navigate|navigate_back|back|forward|snapshot|screenshot|take_screenshot|get_images|get_text|read|console|console_messages|network_requests|tabs|wait|wait_for|scroll|find|vision)$/;

/** Words in a tool's name that mark it as one of the risky classes. */
const WORDS: [RiskClass, RegExp][] = [
  ['shell', /^(shell|exec|execute|command|commands|cmd|run|terminal|script|powershell|pwsh|bash|sh|sudo|ssh|process|processes|kill|service|services|systemctl|reboot|restart|shutdown|eval|evaluate)$/],
  ['delete', /^(delete|remove|rm|trash|purge|destroy|drop|wipe|erase|unlink|rmdir)$/],
  ['message', /^(send|reply|forward|post|publish|share|invite|notify|broadcast|tweet|sms|dm|email|mail|respond)$/],
  ['money', /^(pay|payment|payments|transfer|transfers|charge|refund|purchase|buy|sell|order|orders|trade|withdraw|deposit|invoice|checkout|payout|instruction)$/],
  ['install', /^(install|uninstall|plugin|plugins|extension|upgrade)$/],
];
/** A file-ish name: writing, moving or creating with one of these counts as a file write. */
const FILE_NOUN = /^(file|files|fs|dir|directory|folder|path)$/;
const FILE_VERB = /^(write|edit|move|rename|upload|create|replace|mkdir|append|copy|patch|save|put)$/;
/** Apps where every call that asks counts (their reads never ask in the first place). */
const APP_CLASSES: [RiskClass, RegExp][] = [
  ['money', /actual|budget|bank|plaid|finance|webull|broker|stripe|paypal|venmo|trading|crypto/],
  ['host', /host.?admin|native.?host|server.?admin|ssh|shell|remote.?pc|machines|coder\d/],
];

const words = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The risky class a tool falls in (its card warns about it), or null. `key` is the stored name (`hermes__x`, `<app>__<tool>`). */
export function alwaysAllowRisk(key: string): RiskClass | null {
  if (/^pc__/i.test(key)) return 'host';
  const [app, ...rest] = key.split('__');
  const tool = rest.length ? rest.join('__') : key;
  if (rest.length && app.toLowerCase() === 'hermes') {
    const t = tool.toLowerCase();
    if (HERMES_RISKY[t]) return HERMES_RISKY[t];
    if (t.startsWith('browser_') && !BROWSER_LOOKS.test(t)) return 'browser';
  }
  if (rest.length) {
    const found = findAppTool(key);
    const appId = (found?.appId ?? app).toLowerCase();
    const appName = (appInfo(found?.appId ?? app)?.name ?? '').toLowerCase();
    for (const [cls, re] of APP_CLASSES) if (re.test(appId) || re.test(appName)) return cls;
  }
  const w = words(tool);
  for (const [cls, re] of WORDS) if (w.some((x) => re.test(x))) return cls;
  if (w.some((x) => FILE_NOUN.test(x)) && w.some((x) => FILE_VERB.test(x))) return 'files';
  return null;
}

/**
 * A tool that sends email (Gmail's send_gmail_message, a "send mail" tool of any mail app). Alex,
 * 2026-11-23: bots may send mail, but every send shows the whole email on a card that a person reads and
 * presses Send on, in the bot's chat. So these never run on a rule or an "allow", never offer "Always
 * allow", and cannot be answered from a notification (loop.ts, tools.ts).
 */
export function isMailSend(key: string): boolean {
  const tool = (key.includes('__') ? key.split('__').slice(1).join('__') : key);
  const w = words(tool);
  const acts = w.some((x) => /^(send|reply|forward)$/.test(x));
  const mail = w.some((x) => /^(gmail|email|mail|e-mail|outlook)$/.test(x));
  if (acts && mail) return true;
  // Sending a saved draft ("send_draft") sends mail too.
  if (acts && w.some((x) => /^drafts?$/.test(x))) return true;
  // "send_message" of a mail app (Gmail, Outlook, Microsoft 365).
  // On a mail app, any send, reply or forward that is not about the calendar or chat sends mail.
  if (acts && !w.some((x) => /^(calendar|event|invite|invitation|chat|space|sms|text)$/.test(x))) {
    const app = (findAppTool(key)?.appId ?? key.split('__')[0]).toLowerCase();
    const name = (appInfo(findAppTool(key)?.appId ?? app)?.name ?? '').toLowerCase();
    return /gmail|google|mail|outlook|m365|microsoft/.test(app) || /gmail|google|mail|outlook/.test(name);
  }
  return false;
}

/** The warning a card shows next to "Always allow" for a risky tool. */
export const alwaysAllowNote = (cls: RiskClass) => `${WHY[cls]} If you choose Always allow, it won't ask again.`;

/**
 * For a card listing `tools`: "Always allow" is offered whenever the card lists what it covers. A risky
 * tool adds `risk` and a one-line warning; `lowRisk` is true only when none is risky.
 */
export function alwaysAllowFor(tools: string[]): { canAlways: boolean; lowRisk: boolean; risk?: RiskClass; alwaysNote?: string } {
  if (!tools.length) return { canAlways: false, lowRisk: false };
  for (const t of tools) {
    const cls = alwaysAllowRisk(t);
    if (cls) return { canAlways: true, lowRisk: false, risk: cls, alwaysNote: alwaysAllowNote(cls) };
  }
  return { canAlways: true, lowRisk: true };
}

// ---------------------------------------------------------------------------
// Rules

export interface AllowRule {
  id: string;
  botId: string;
  botName: string;
  tool: string;
  label: string;
  createdBy: string;
  createdVia: string;
  createdAt: number;
  uses: number;
  lastUsedAt: number | null;
  /** The tool's risky class, if any, so the settings list can say so. */
  risk: RiskClass | null;
}

const toRule = (r: any): AllowRule => ({
  id: r.id, botId: r.bot_id, botName: r.bot_name ?? '', tool: r.tool, label: r.label, createdBy: r.created_by,
  createdVia: r.created_via, createdAt: r.created_at, uses: r.uses, lastUsedAt: r.last_used_at ?? null,
  risk: alwaysAllowRisk(r.tool),
});

/** The rule that lets this bot use this tool unasked, if there is one. */
export function ruleFor(botId: string | undefined, tool: string): string | null {
  if (!botId) return null;
  const r = db.prepare('SELECT id FROM allow_rules WHERE bot_id=? AND tool=? COLLATE NOCASE').get(botId, tool) as { id: string } | undefined;
  return r?.id ?? null;
}

/**
 * Make (or keep) the rule for each tool on a card. Called only from resolveApproval, i.e. a signed-in
 * person's answer.
 */
export function createRules(o: { userId: string; botId: string; tools: string[]; labelOf: (tool: string) => string; createdBy: string; createdVia: string; approvalId: string }): void {
  const ins = db.prepare(`INSERT INTO allow_rules(id,user_id,bot_id,tool,label,created_by,created_via,approval_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(bot_id,tool) DO NOTHING`);
  db.transaction(() => { for (const t of o.tools) ins.run(newId('alw'), o.userId, o.botId, t, o.labelOf(t).slice(0, 200), o.createdBy.slice(0, 200), o.createdVia, o.approvalId, now()); })();
}

/** Note that a rule let a call through: counted on the rule and written to the log. */
export function noteRuleUse(ruleId: string, botId: string, tool: string, args: unknown, detail?: string): void {
  let json = '';
  try { json = JSON.stringify(args ?? {}); } catch { json = String(args); }
  const t = now();
  db.prepare('UPDATE allow_rules SET uses=uses+1, last_used_at=? WHERE id=?').run(t, ruleId);
  db.prepare('INSERT INTO allow_rule_log(rule_id,bot_id,tool,args_sha,detail,at) VALUES (?,?,?,?,?,?)')
    .run(ruleId, botId, tool, crypto.createHash('sha256').update(json).digest('hex'), detail ? detail.slice(0, 300) : null, t);
  // Keep the log to the last 2000 entries per bot.
  db.prepare('DELETE FROM allow_rule_log WHERE bot_id=? AND id NOT IN (SELECT id FROM allow_rule_log WHERE bot_id=? ORDER BY id DESC LIMIT 2000)').run(botId, botId);
}

/** The owner's rules, optionally for one bot. */
export function listRules(userId: string, botId?: string): AllowRule[] {
  const rows = db.prepare(`SELECT r.*, b.name AS bot_name FROM allow_rules r JOIN bots b ON b.id=r.bot_id
    WHERE r.user_id=? AND b.user_id=? ${botId ? 'AND r.bot_id=?' : ''} ORDER BY b.name COLLATE NOCASE, r.created_at`)
    .all(...(botId ? [userId, userId, botId] : [userId, userId])) as any[];
  return rows.map(toRule);
}

/** Recent calls a rule let through, newest first. */
export function ruleLog(userId: string, botId?: string, limit = 30) {
  const rows = db.prepare(`SELECT l.*, r.label, b.name AS bot_name FROM allow_rule_log l JOIN bots b ON b.id=l.bot_id
    LEFT JOIN allow_rules r ON r.id=l.rule_id WHERE b.user_id=? ${botId ? 'AND l.bot_id=?' : ''} ORDER BY l.id DESC LIMIT ?`)
    .all(...(botId ? [userId, botId, limit] : [userId, limit])) as any[];
  // `free:terminal` rows are the maintainer's free-run commands (maintainer-guard.ts), detail = the command, redacted.
  // `app:<id>` rows are changes an app's settings allow without a card (tools.ts policyFor): no rule row, so
  // they are named by the tool's title.
  return rows.map((r) => ({ id: r.id, ruleId: r.rule_id, botId: r.bot_id, botName: r.bot_name, tool: r.tool, label: r.label ?? (String(r.rule_id).startsWith('app:') && r.detail ? `${r.detail} (allowed in app settings)` : r.rule_id === 'free:terminal' ? `Ran: ${String(r.detail ?? '').slice(0, 160)}` : r.tool), detail: r.detail ?? '', at: r.at }));
}

/** Remove one of the owner's rules. False when there is no such rule of theirs. */
export function deleteRule(userId: string, id: string): boolean {
  return db.prepare('DELETE FROM allow_rules WHERE id=? AND user_id=?').run(id, userId).changes > 0;
}
