import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { redact } from './lib/redact.js';
import { allAppConfigs, appConfig, appLog, appRule, appsStatus, appTools, checkAppEntry, configPath, invalidateApps, reconnectApp, type AppConfig } from './local-apps.js';
import { audit, botsWith, enabledFor, setEnabled } from './plugins/registry.js';
import { googleLog, googleSetup, restartServer } from './google-accounts.js';
import type { Policy } from './agent/tools.js';

/**
 * Connected-app admin for the admin bot (Howard), asked for by Alex on 2026-11-23:
 *
 *  - read (no card): how each connected app is set up (its MCP server, the tools it exports, the
 *    OAuth scopes it asks for and was granted, which bots have it) and its recent log lines;
 *  - change (one approval card per change): turn an app on or off for one bot, edit or add an
 *    apps.json entry, remove one, restart one so the bots get its new tools, or roll back an earlier
 *    change. The card shows exactly what changes. Nothing changes until a person allows that card
 *    (a bot's message never answers a card, and a script sign-in can't either: agent/loop.ts); the
 *    card offers no "Always allow", so each change gets its own card.
 *
 * What the system enforces here (not just the bot's instructions):
 *  - no key, token, password or client secret is ever returned: env values, headers, header files,
 *    OAuth token files and Google credentials are shown as "hidden", and a change may not set or edit
 *    any of those fields, nor use `${VAR}` (which would pull a key out of the server's environment);
 *  - sign-ins and consent screens stay with the person: a missing Google scope is reported, and only
 *    Connect Google (a person's own sign-in) can add it;
 *  - firm apps (the work apps in FIRM_IDS, and any connector marked
 *    firm) can be changed only through a card that says so, for that one change;
 *  - every change is stored with what it was before and after, who allowed it and when
 *    (connector_admin_changes, and plugin_audit), and can be rolled back, itself through a card.
 *
 * The admin bots are the primary bot (Howard) and any named in CONNECTOR_ADMIN_BOTS.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS connector_admin_changes (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL,
  before TEXT,
  after TEXT,
  status TEXT NOT NULL,
  approval_id TEXT,
  approved_by TEXT,
  approved_via TEXT,
  result TEXT,
  rolls_back TEXT,
  rolled_back_by TEXT,
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);
`);

export class AdminError extends Error {}

const FIRM_IDS = new Set(['m365', 'files', 'cms']);
const SECRET_FIELDS = ['env', 'headers', 'headersFile', 'oauth', 'remote'] as const;
/** Fields a change may set on an apps.json entry. */
const EDITABLE = ['name', 'description', 'logo', 'enabled', 'command', 'args', 'cwd', 'url', 'allow', 'ask', 'block', 'trustReadOnlyHints', 'readOnly', 'timeoutMs', 'bots', 'onlyBots', 'exclusive'] as const;

const botRow = (id: string) => db.prepare('SELECT id, name, user_id, engine FROM bots WHERE id=?').get(id) as { id: string; name: string; user_id: string; engine: string } | undefined;
const botByName = (name: string) => db.prepare('SELECT id, name, user_id FROM bots WHERE id=? OR lower(name)=lower(?) ORDER BY created_at LIMIT 1').get(name, name) as { id: string; name: string; user_id: string } | undefined;

/** Whether this bot may use the admin tools. */
export function isConnectorAdmin(botId: string | null | undefined): boolean {
  if (!botId) return false;
  const b = botRow(botId);
  if (!b) return false;
  const named = (process.env.CONNECTOR_ADMIN_BOTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (named.length) return named.includes(b.id.toLowerCase()) || named.includes(b.name.toLowerCase());
  return b.engine === 'primary';
}

function connectorRow(id: string): { source: string; firm: number; name: string } | undefined {
  try { return db.prepare('SELECT source, firm, name FROM connectors WHERE id=?').get(id) as any; } catch { return undefined; }
}

export function isFirmApp(id: string): boolean {
  return FIRM_IDS.has(id) || connectorRow(id)?.firm === 1;
}

const hasVar = (v: unknown): boolean => JSON.stringify(v ?? null).includes('${');

/** Where an app's server is, with every key left out. */
function where(c: AppConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.url) {
    out.transport = 'http';
    out.url = hasVar(c.url) ? '(address built from a hidden setting)' : c.url;
  } else {
    out.transport = 'stdio';
    out.command = hasVar(c.command) ? '(hidden)' : c.command;
    out.args = (c.args ?? []).map((a) => (hasVar(a) ? '(hidden)' : redact(a)));
    if (c.cwd) out.cwd = c.cwd;
  }
  if (c.env && Object.keys(c.env).length) out.env = Object.fromEntries(Object.keys(c.env).map((k) => [k, '(hidden)']));
  if (c.headers && Object.keys(c.headers).length) out.headers = Object.fromEntries(Object.keys(c.headers).map((k) => [k, '(hidden)']));
  if (c.headersFile) out.keyFile = '(hidden: a key file on the server)';
  if (c.oauth) {
    let host = '';
    try { host = new URL(c.oauth.tokenUrl).host; } catch { /* shown as unknown */ }
    out.signIn = `OAuth through ${host || 'its sign-in server'}; the token is hidden and refreshed by the server. Its scopes are set by that sign-in server.`;
  }
  return out;
}

function sourceOf(c: AppConfig): string {
  const row = connectorRow(c.id);
  if (row?.source === 'google') return 'google';
  if (c.origin === 'catalog') return row?.source === 'custom' ? 'connector added by address' : 'connector from the catalog';
  return c.origin ?? 'apps.json';
}

const decisionOf = (t: { appId: string; tool: string; readOnly: boolean }) => {
  const r = appRule(t);
  return r.decision === 'allow' ? 'runs' : r.decision === 'block' ? 'blocked' : 'asks on a card';
};

/** Everything about every connected app that is safe to show (no keys). */
export async function overview(appId?: string): Promise<unknown> {
  const status = await appsStatus();
  const apps = allAppConfigs().filter((c) => !appId || c.id === appId);
  if (appId && !apps.length) throw new AdminError(`No connected app called ${appId}. Call connected_apps_overview without an app to see them all.`);
  return {
    configFile: configPath(),
    ...(status.error ? { configError: status.error } : {}),
    apps: apps.map((c) => {
      const s = status.apps.find((a) => a.id === c.id);
      const tools = appTools(c.id);
      const g = sourceOf(c) === 'google' ? googleSetup(c.id) : null;
      return {
        id: c.id,
        name: c.name ?? c.id,
        source: sourceOf(c),
        firm: isFirmApp(c.id),
        status: s?.status ?? 'stopped',
        ...(s?.error ? { error: redact(s.error) } : {}),
        server: where(c),
        rules: { readOnly: c.readOnly === true, allow: c.allow ?? [], ask: c.ask ?? [], block: c.block ?? [] },
        bots: { have: botsWith(c.id).map((b) => b.name), default: c.bots ?? '(every bot, as an apps.json entry)', onlyBots: c.onlyBots ?? null, exclusive: c.exclusive === true },
        tools: appId ? tools.map((t) => ({ name: t.tool, botName: t.name, readOnly: t.readOnly, when: decisionOf(t) })) : tools.map((t) => t.tool),
        ...(g ? { google: { account: g.email, changesAllowed: g.write, scopesAsked: g.wanted, scopesGranted: g.granted, scopesMissing: g.missing, serverPermissions: g.permissions, howToAddMissing: g.missing.length ? 'Only the person can add scopes: they open Settings > Connections, tap Connect Google for this account (tick Allow changes if it had it), and tick every box on Google\'s page.' : undefined } } : {}),
        editable: c.origin === 'apps.json' ? 'apps.json entry: edit_app, remove_app, set_bot' : 'set_bot and restart only (its setup is managed by the app)',
      };
    }),
  };
}

export function logs(appId: string, lines = 80): string[] {
  if (!appConfig(appId)) throw new AdminError(`No connected app called ${appId}.`);
  const n = Math.max(1, Math.min(200, Math.floor(Number(lines) || 80)));
  const all = sourceOf(appConfig(appId)!) === 'google' ? [...googleLog(appId), ...appLog(appId)].sort() : appLog(appId);
  return all.slice(-n);
}

export function history(limit = 20): unknown[] {
  const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
  return (db.prepare('SELECT * FROM connector_admin_changes ORDER BY created_at DESC, rowid DESC LIMIT ?').all(n) as any[]).map(view);
}

/** bot_id of a change a person made in Connections (not a bot): no card, the person's own press. */
export const PERSON = 'person';

function view(r: any) {
  return {
    id: r.id, app: r.app_id, action: r.action, summary: r.summary, status: r.status,
    bot: r.bot_id === PERSON ? (r.approved_by ?? 'You') : botRow(r.bot_id)?.name ?? r.bot_id, byPerson: r.bot_id === PERSON, at: new Date(r.created_at).toISOString(),
    ...(r.applied_at ? { appliedAt: new Date(r.applied_at).toISOString() } : {}),
    ...(r.approved_by ? { approvedBy: r.approved_by, via: r.approved_via } : {}),
    ...(r.rolls_back ? { rollsBack: r.rolls_back } : {}),
    ...(r.rolled_back_by ? { rolledBackBy: r.rolled_back_by } : {}),
    canRollBack: r.status === 'applied' && !r.rolled_back_by && r.action !== 'restart',
  };
}

// ---------- apps.json ----------

function readAppsFile(): { raw: any; list: AppConfig[] } {
  const file = configPath();
  let raw: any = [];
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new AdminError(`apps.json could not be read: ${(e as Error).message}`);
  }
  const list: AppConfig[] = Array.isArray(raw) ? raw : Array.isArray(raw?.apps) ? raw.apps : [];
  return { raw, list };
}

/** Write apps.json with one entry replaced, added (entry, no old) or removed (null). A copy of the old file is kept next to it. */
function writeAppsEntry(id: string, entry: AppConfig | null) {
  const file = configPath();
  const { raw, list } = readAppsFile();
  const next = list.filter((c) => c?.id !== id);
  if (entry) {
    const at = list.findIndex((c) => c?.id === id);
    if (at >= 0) next.splice(at, 0, entry); else next.push(entry);
  }
  const out = Array.isArray(raw) || !raw || typeof raw !== 'object' ? next : { ...raw, apps: next };
  if (fs.existsSync(file)) {
    const bak = path.join(path.dirname(file), 'data', 'apps-json-backups');
    fs.mkdirSync(bak, { recursive: true, mode: 0o700 });
    fs.copyFileSync(file, path.join(bak, `apps-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  invalidateApps();
}

function fileEntry(id: string): AppConfig | undefined {
  return readAppsFile().list.find((c) => c?.id === id);
}

// ---------- proposing a change ----------

export interface ChangeInput {
  action: 'set_bot' | 'edit_app' | 'add_app' | 'remove_app' | 'restart' | 'rollback';
  app?: string;
  bot?: string;
  on?: boolean;
  set?: Record<string, unknown>;
  unset?: string[];
  entry?: Record<string, unknown>;
  change?: string;
  why?: string;
}

interface Planned {
  appId: string;
  action: ChangeInput['action'];
  summary: string;
  lines: string[];
  before: unknown;
  after: unknown;
  /** Turns something off or removes it (said on the card). */
  removes: boolean;
  apply: (userId: string) => Promise<unknown>;
  rollsBack?: string;
}

const show = (v: unknown) => (v === undefined ? '(not set)' : JSON.stringify(v));

function checkFields(o: Record<string, unknown>, what: string) {
  for (const k of Object.keys(o)) {
    if ((SECRET_FIELDS as readonly string[]).includes(k)) throw new AdminError(`${what}: "${k}" holds or leads to a key, so a bot may not set it. Ask the person to change it on the server.`);
    if (!(EDITABLE as readonly string[]).includes(k) && k !== 'id') throw new AdminError(`${what}: "${k}" is not a field a bot may set. Allowed: ${EDITABLE.join(', ')}.`);
  }
  if (hasVar(o)) throw new AdminError(`${what}: \${...} would read a setting from the server's environment, so a bot may not use it.`);
}

function plan(input: ChangeInput): Planned {
  const action = input.action;
  if (action === 'rollback') return planRollback(String(input.change ?? ''));
  const appId = String(input.app ?? '').trim();
  if (!appId) throw new AdminError('Say which app ("app": its id from connected_apps_overview).');

  if (action === 'set_bot') {
    const cfg = appConfig(appId);
    if (!cfg) throw new AdminError(`No connected app called ${appId}.`);
    const bot = botByName(String(input.bot ?? ''));
    if (!bot) throw new AdminError(`No bot called ${input.bot}.`);
    if (typeof input.on !== 'boolean') throw new AdminError('Say "on": true or false.');
    const sw = db.prepare('SELECT enabled FROM plugin_bots WHERE plugin_id=? AND bot_id=?').get(appId, bot.id) as { enabled: number } | undefined;
    const was = enabledFor(appId, bot.id);
    if (was === input.on) throw new AdminError(`${bot.name} already ${was ? 'has' : 'does not have'} ${cfg.name ?? appId}. Nothing to change.`);
    const on = input.on;
    return {
      appId, action, removes: !on,
      summary: `${on ? 'Give' : 'Take'} ${cfg.name ?? appId} ${on ? 'to' : 'away from'} ${bot.name}`,
      lines: [`${bot.name}: ${was ? 'has it' : 'does not have it'} → ${on ? 'has it' : 'does not have it'}`, `Tools ${bot.name} ${on ? 'gets' : 'loses'}: ${appTools(appId).length}`],
      before: { bot: bot.id, switch: sw ? sw.enabled === 1 : null },
      after: { bot: bot.id, switch: on },
      apply: async (userId) => setEnabled(userId, appId, bot.id, on),
    };
  }

  if (action === 'restart') {
    const cfg = appConfig(appId);
    if (!cfg) throw new AdminError(`No connected app called ${appId}.`);
    const google = sourceOf(cfg) === 'google';
    return {
      appId, action, removes: false,
      summary: `Restart ${cfg.name ?? appId} so the bots get its current tools`,
      lines: [google ? 'Stops and starts its Google server, then lists its tools again.' : 'Drops the connection to its server and lists its tools again. The server itself keeps running unless Cleft starts it (a command).', `Tools now: ${appTools(appId).length}`],
      before: null, after: null,
      apply: async () => {
        if (google) { await restartServer(appId); await new Promise((r) => setTimeout(r, 4000)); }
        return reconnectApp(appId);
      },
    };
  }

  if (action === 'add_app') {
    const entry = { ...(input.entry ?? {}) } as Record<string, unknown>;
    entry.id = appId;
    checkFields(entry, 'add_app');
    if (appConfig(appId) || fileEntry(appId)) throw new AdminError(`An app called ${appId} already exists. Use edit_app.`);
    const why = checkAppEntry(entry as unknown as AppConfig);
    if (why) throw new AdminError(`That entry would be skipped: ${why}.`);
    const after = entry as unknown as AppConfig;
    return {
      appId, action, removes: false,
      summary: `Add ${String(entry.name ?? appId)} to apps.json`,
      lines: [...Object.entries(entry).map(([k, v]) => `${k}: ${show(v)}`), ...(after.command ? ['This starts that command on the server, as the app\'s own user.'] : [])],
      before: null, after,
      apply: async () => { writeAppsEntry(appId, after); return reconnectApp(appId); },
    };
  }

  // edit_app and remove_app work on apps.json entries only.
  const old = fileEntry(appId);
  if (!old) {
    const cfg = appConfig(appId);
    throw new AdminError(cfg ? `${cfg.name ?? appId} is not an apps.json entry (it is a ${sourceOf(cfg)}); its setup is managed in the app. A bot can only turn it on or off for a bot (set_bot) or restart it.` : `No connected app called ${appId}.`);
  }

  if (action === 'remove_app') {
    return {
      appId, action, removes: true,
      summary: `Remove ${old.name ?? appId} from apps.json`,
      lines: ['Every bot loses its tools. The entry is kept with this change, so a rollback puts it back exactly.', `Tools it has now: ${appTools(appId).length}`],
      before: old, after: null,
      apply: async () => { writeAppsEntry(appId, null); return { removed: appId }; },
    };
  }

  if (action === 'edit_app') {
    const set = { ...(input.set ?? {}) };
    const unset = (input.unset ?? []).map(String);
    if ('id' in set) throw new AdminError('An app\'s id cannot be changed; add a new one and remove the old one instead.');
    checkFields(set, 'edit_app');
    for (const k of unset) {
      if ((SECRET_FIELDS as readonly string[]).includes(k)) throw new AdminError(`"${k}" holds or leads to a key, so a bot may not remove it either.`);
      if (!(EDITABLE as readonly string[]).includes(k)) throw new AdminError(`"${k}" is not a field a bot may change.`);
    }
    const next: Record<string, unknown> = { ...old, ...set };
    for (const k of unset) delete next[k];
    const changed = [...new Set([...Object.keys(set), ...unset])].filter((k) => JSON.stringify((old as any)[k]) !== JSON.stringify(next[k]));
    if (!changed.length) throw new AdminError('That changes nothing.');
    const why = checkAppEntry(next as unknown as AppConfig);
    if (why) throw new AdminError(`The app would stop working: ${why}.`);
    const removes = changed.some((k) => (k === 'enabled' && next.enabled === false) || (k === 'block' && ((next.block as string[] | undefined)?.length ?? 0) > ((old.block?.length) ?? 0)) || (k === 'readOnly' && next.readOnly === true) || k === 'onlyBots' || k === 'bots');
    return {
      appId, action, removes,
      summary: `Change ${old.name ?? appId} in apps.json (${changed.join(', ')})`,
      lines: [...changed.map((k) => `${k}: ${show((old as any)[k])} → ${show(next[k])}`), 'Then its tools are listed again.'],
      before: old, after: next,
      apply: async () => { writeAppsEntry(appId, next as unknown as AppConfig); return reconnectApp(appId); },
    };
  }
  throw new AdminError(`Unknown action ${action}. Use set_bot, edit_app, add_app, remove_app, restart or rollback.`);
}

function planRollback(changeId: string): Planned {
  const r = db.prepare('SELECT * FROM connector_admin_changes WHERE id=?').get(changeId) as any;
  if (!r) throw new AdminError(`No change called ${changeId}. connected_app_history lists them.`);
  if (r.status !== 'applied') throw new AdminError(`That change was not applied (${r.status}).`);
  if (r.rolled_back_by) throw new AdminError(`That change was already rolled back by ${r.rolled_back_by}.`);
  if (r.action === 'restart') throw new AdminError('A restart has nothing to roll back.');
  const before = r.before ? JSON.parse(r.before) : null;
  const after = r.after ? JSON.parse(r.after) : null;
  const appId = r.app_id as string;
  let apply: Planned['apply'];
  let lines: string[];
  if (r.action === 'set_bot') {
    const bot = botRow(before.bot);
    if (!bot) throw new AdminError('That bot no longer exists.');
    lines = [`${bot.name}: back to ${before.switch === null ? 'the app\'s default' : before.switch ? 'has it' : 'does not have it'}`];
    apply = async (userId) => {
      if (before.switch === null) { db.prepare('DELETE FROM plugin_bots WHERE plugin_id=? AND bot_id=?').run(appId, bot.id); audit(userId, 'default', appId, bot.id, { via: 'rollback' }); return { botId: bot.id, enabled: enabledFor(appId, bot.id) }; }
      return setEnabled(userId, appId, bot.id, before.switch);
    };
  } else {
    // An apps.json change: the entry goes back to exactly what it was (or away, if it was added).
    const now_ = fileEntry(appId) ?? null;
    if (JSON.stringify(now_) !== JSON.stringify(after)) throw new AdminError(`${appId} has changed since (${now_ ? 'its entry is different now' : 'it is gone'}), so rolling back would undo more than this change. Propose an edit_app instead.`);
    lines = before ? Object.keys({ ...before, ...(after ?? {}) }).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after?.[k])).map((k) => `${k}: ${show(after?.[k])} → ${show(before[k])}`) : ['The entry is removed again.'];
    apply = async () => { writeAppsEntry(appId, before); return before ? reconnectApp(appId) : { removed: appId }; };
  }
  return {
    appId, action: 'rollback', removes: r.action !== 'remove_app',
    summary: `Undo: ${r.summary}`,
    lines: [`Rolls back the change of ${new Date(r.applied_at ?? r.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC, allowed by ${r.approved_by ?? 'someone'}.`, ...lines],
    before: after, after: before, rollsBack: changeId, apply,
  };
}

/** The card's text: what changes, line by line. */
function cardText(p: Planned, why: string | undefined): string {
  const firm = isFirmApp(p.appId);
  return [
    ...(firm ? ['⚠ Work (firm) app. Allowing approves this one change only.', ''] : []),
    p.summary,
    ...p.lines.map((l) => `• ${l}`),
    ...(p.removes ? ['', 'This turns something off or removes it.'] : []),
    ...(why ? ['', `Why: ${String(why).slice(0, 300)}`] : []),
    '',
    'Logged with who allowed it, and can be rolled back.',
  ].join('\n').slice(0, 3500);
}

type Ask = (pol: Policy, args: unknown, meta: { approvalId?: string; answeredBy?: string; answeredVia?: string }) => Promise<'allow' | 'deny' | string>;

/**
 * Plan a change, put it on one approval card, and apply it only if a person allows that card.
 * Returns what was done, read back.
 */
export async function proposeAndApply(botId: string, input: ChangeInput, ask: Ask): Promise<{ id: string; status: string; summary: string; result?: unknown }> {
  if (!isConnectorAdmin(botId)) throw new AdminError('Only the admin bot can change connected apps.');
  const bot = botRow(botId)!;
  const p = plan(input);
  const id = newId('cac');
  const detail = cardText(p, input.why);
  db.prepare(`INSERT INTO connector_admin_changes(id,bot_id,user_id,app_id,action,summary,detail,before,after,status,rolls_back,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, botId, bot.user_id, p.appId, p.action, p.summary, detail, p.before === null ? null : JSON.stringify(p.before), p.after === null ? null : JSON.stringify(p.after), 'pending', p.rollsBack ?? null, now());
  const pol: Policy = { decision: 'ask', key: 'connected_app_change', title: `Connected apps: ${p.summary.charAt(0).toLowerCase()}${p.summary.slice(1)}`, asks: [], detail };
  const meta: { approvalId?: string; answeredBy?: string; answeredVia?: string } = {};
  const answer = await ask(pol, { change: id, app: p.appId, action: p.action }, meta);
  const mark = (status: string, extra: Record<string, unknown> = {}) => {
    db.prepare('UPDATE connector_admin_changes SET status=?, approval_id=?, approved_by=?, approved_via=?, result=?, applied_at=? WHERE id=?')
      .run(status, meta.approvalId ?? null, meta.answeredBy ?? null, meta.answeredVia ?? null, extra.result === undefined ? null : JSON.stringify(extra.result), status === 'applied' || status === 'failed' ? now() : null, id);
  };
  if (answer !== 'allow') { mark(answer === 'deny' ? 'declined' : 'skipped'); return { id, status: answer === 'deny' ? 'declined' : 'not answered', summary: p.summary }; }
  try {
    const result = await p.apply(bot.user_id);
    mark('applied', { result });
    if (p.rollsBack) db.prepare('UPDATE connector_admin_changes SET rolled_back_by=? WHERE id=?').run(id, p.rollsBack);
    audit(bot.user_id, `admin:${p.action}`, p.appId, botId, { change: id, approvedBy: meta.answeredBy ?? null, via: meta.answeredVia ?? null });
    logLine(`${bot.name} ${p.action} ${p.appId} change=${id} approved_by=${meta.answeredBy ?? '?'} via=${meta.answeredVia ?? '?'}: ${p.summary}`);
    return { id, status: 'applied', summary: p.summary, result };
  } catch (e) {
    const msg = redact((e as Error).message);
    mark('failed', { result: { error: msg } });
    return { id, status: 'failed', summary: p.summary, result: { error: msg } };
  }
}

/** One line in the maintainer's audit log, when this server may write it. */
function logLine(text: string) {
  try { fs.appendFileSync(process.env.CLEFT_MAINTAINER_LOG || '/var/log/cleft-maintainer.log', `${new Date().toISOString()} connector-admin ${text.replace(/\s+/g, ' ')}\n`); } catch { /* not writable here (tests, or not root) */ }
}

/**
 * Undo pressed by a person in the app (Settings > Connections > Changes by bots). The press is the
 * person's own decision, so no card: the route only lets a signed-in person (not a script) who owns
 * the server do it. Recorded like any other change, with that person as the one who allowed it.
 */
export async function undoAsPerson(userId: string, changeId: string, via: string): Promise<unknown> {
  const orig = db.prepare('SELECT bot_id FROM connector_admin_changes WHERE id=?').get(changeId) as { bot_id: string } | undefined;
  if (!orig) throw new AdminError('No such change.');
  const p = planRollback(changeId);
  const who = (db.prepare('SELECT name, email FROM users WHERE id=?').get(userId) as { name?: string; email?: string } | undefined);
  const by = who?.name || who?.email || 'the owner';
  const id = newId('cac');
  const t = now();
  const result = await p.apply(userId);
  db.prepare(`INSERT INTO connector_admin_changes(id,bot_id,user_id,app_id,action,summary,detail,before,after,status,approved_by,approved_via,result,rolls_back,created_at,applied_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, orig.bot_id, userId, p.appId, 'rollback', p.summary, cardText(p, undefined), p.before === null ? null : JSON.stringify(p.before), p.after === null ? null : JSON.stringify(p.after), 'applied', by, via, JSON.stringify(result ?? null), changeId, t, t);
  db.prepare('UPDATE connector_admin_changes SET rolled_back_by=? WHERE id=?').run(id, changeId);
  audit(userId, 'admin:rollback', p.appId, null, { change: id, undoes: changeId, via });
  logLine(`${by} undo ${p.appId} change=${id} undoes=${changeId} via=${via}`);
  return { id, summary: p.summary, result };
}

// ---------- the same changes, made by a person in Connections ----------

const sha = (x: string) => crypto.createHash('sha256').update(x).digest('hex');
const digestOf = (p: Planned) => sha(JSON.stringify([p.action, p.appId, p.summary, p.lines, p.before, p.after]));
const personName = (userId: string) => {
  const who = db.prepare('SELECT name, email FROM users WHERE id=?').get(userId) as { name?: string; email?: string } | undefined;
  return who?.name || who?.email || 'the owner';
};

/** What a change would do, for the confirm box in Connections: its summary, line by line, and the digest the app sends back. */
export function previewForPerson(input: ChangeInput): { appId: string; summary: string; lines: string[]; removes: boolean; firm: boolean; digest: string } {
  if (input.action === 'rollback') throw new AdminError('Use Undo in Recent changes.');
  const p = plan(input);
  return { appId: p.appId, summary: p.summary, lines: p.lines, removes: p.removes, firm: isFirmApp(p.appId), digest: digestOf(p) };
}

/**
 * A person's change from Connections (Turn off, Turn on, Remove, a per-bot move). The person's own
 * press of Confirm is the approval, so no card; the route lets only a signed-in person (not a script)
 * who owns the server do it, and only with the digest the app was shown: if anything changed since,
 * the plan no longer matches and nothing is done. Stored like the admin bot's changes, so Recent
 * changes shows it with Undo.
 */
export async function applyAsPerson(userId: string, input: ChangeInput, digest: string | null, via: string, summary?: string): Promise<{ id: string; summary: string; result: unknown }> {
  if (input.action === 'rollback') throw new AdminError('Use Undo in Recent changes.');
  const p = plan(input);
  if (digest !== null && digestOf(p) !== digest) throw new AdminError('That connection changed after you were shown this; nothing was done. Look again and confirm.');
  const by = personName(userId);
  const id = newId('cac');
  const t = now();
  const result = await p.apply(userId);
  // The person's own words for it (Turn off Actual), not the file-level summary a bot is shown.
  if (summary) p.summary = summary;
  db.prepare(`INSERT INTO connector_admin_changes(id,bot_id,user_id,app_id,action,summary,detail,before,after,status,approved_by,approved_via,result,created_at,applied_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, PERSON, userId, p.appId, p.action, p.summary, cardText(p, undefined), p.before === null ? null : JSON.stringify(p.before), p.after === null ? null : JSON.stringify(p.after), 'applied', by, via, JSON.stringify(result ?? null), t, t);
  audit(userId, `person:${p.action}`, p.appId, null, { change: id, via });
  logLine(`${by} ${p.action} ${p.appId} change=${id} via=${via}: ${p.summary}`);
  return { id, summary: p.summary, result };
}
