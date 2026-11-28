import crypto from 'node:crypto';
import { db, now } from './db.js';
import { newId } from './lib/ids.js';
import { redact } from './lib/redact.js';
import { allAppConfigs, appBaseRule, appConfig, appRule, appsStatus, appTools, invalidateApps, reconnectApp, setToolOverrides, type AppConfig, type AppStatus, type ToolOverride } from './local-apps.js';
import { isOwner } from './plugins/owner.js';
import { audit, botsWith, pluginOverview, setEnabled } from './plugins/registry.js';
import { installedPlugin, pluginHistory, pluginSettings } from './plugins/store.js';
import { publicValues } from './plugins/ui-schema.js';
import { cancelChange, confirmChange, proposeChange } from './plugins/changes.js';
import { markPluginDeleted } from './plugins/builder.js';
import { AdminError, applyAsPerson, isFirmApp, previewForPerson, type ChangeInput } from './connector-admin.js';
import { cancelConnector, confirmConnector, ConnectorError, listConnectors, proposeConnector, type ConnectorView } from './connectors.js';
import { deleteCustom, restartSignIn, signedIn } from './connectors-custom.js';
import { account, googleSetup, onGoogleReplaced, startGoogle } from './google-accounts.js';

/**
 * Settings › Connections, the same on web, Windows and Android: simple, editable, and the same on
 * every platform.
 *
 * The server words everything here, so every app shows the same thing: one row per connection with
 * a status (Connected, Needs reconnect, Not working, Off), a one-line summary in plain words, which
 * Bots use it, and what the owner can do: Reconnect, Turn off or on, Remove, per-Bot switches (the
 * existing /api/plugins/switch, with Undo) and, per tool, whether it runs on its own, asks first or
 * is off. Where it runs, how it was set up and its fingerprint are details for an Advanced fold.
 *
 * Every connection is editable in the app, wherever it was set up:
 *  - one in the server's apps.json: Turn off / Turn on / Remove edit that file through the same
 *    planned, logged, undoable changes the admin bot uses (connector-admin.ts), with the person's
 *    press as the approval. The file is copied before each write; Recent changes has Undo.
 *  - one added in the app (a Google account, a server by address, a catalog entry): Remove from Bots,
 *    Delete (its key or sign-in), Reconnect (sign in again; for Google on the same account).
 *  - a plugin installed in the app: Remove, Delete, Restore, its settings (plugins/changes.ts).
 *  - one set in the server's environment (EXTRA_MCP_SERVERS): per-Bot switches and per-tool rules.
 *
 * What stays as it was: changes are proposed and confirmed with the digest the app was shown (every
 * client sends it back), only a signed-in person who owns the server can make them (a program signed
 * in to the account, a bot or a plugin cannot reach these routes), a connection or plugin can never
 * answer an approval card, keys are never shown, and tools that must always ask (sending mail, the
 * Hermes connector's risky tools) or are blocked stay so whatever is chosen per tool.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS app_tool_rules (
  app_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  rule TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (app_id, tool)
);
`);

const OVERRIDE: Record<string, ToolOverride> = { runs: 'allow', asks: 'ask', off: 'block' };
const RULE_OF: Record<ToolOverride, ToolRule> = { allow: 'runs', ask: 'asks', block: 'off' };
let rulesCache: Map<string, ToolOverride> | null = null;
const loadRules = () => {
  if (!rulesCache) rulesCache = new Map((db.prepare('SELECT app_id, tool, rule FROM app_tool_rules').all() as { app_id: string; tool: string; rule: ToolOverride }[]).map((r) => [`${r.app_id}\u0000${r.tool}`, r.rule]));
  return rulesCache;
};
setToolOverrides((appId, tool) => loadRules().get(`${appId}\u0000${tool}`));

export class ConnectionError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) { super(message); }
}

export type ConnState = 'connected' | 'needs_reconnect' | 'not_working' | 'off';
export type ToolRule = 'runs' | 'asks' | 'off';
const STATE_TEXT: Record<ConnState, string> = { connected: 'Connected', needs_reconnect: 'Needs reconnect', not_working: 'Not working', off: 'Off' };

export interface ToolView {
  name: string;
  label: string;
  rule: ToolRule;
  /** The owner chose this rule here (so "Back to default" is offered). */
  chosen: boolean;
  /** The rules the owner may pick, and why the others aren't offered. */
  choices: ToolRule[];
  note: string | null;
}
export interface ActionView { id: 'turn_off' | 'turn_on' | 'remove' | 'delete' | 'restore'; label: string; danger: boolean; hint: string }
export interface ConnectionView {
  id: string;
  name: string;
  logo?: string;
  kind: 'google' | 'service' | 'plugin';
  state: ConnState;
  stateText: string;
  /** One line: what it is, in plain words. */
  summary: string;
  /** One line: what is wrong and what to do, when it isn't Connected. */
  problem: string | null;
  /** "Used by Leonard and Howard" / "No Bot uses it yet". */
  usedBy: string;
  bots: { id: string; name: string; on: boolean; ownerName?: string }[];
  /** "31 tools: 20 run on their own, 11 ask first". */
  toolsLine: string;
  tools: ToolView[];
  /** `confirm`: asks first (propose 'reconnect'), since it moves Bots to a new sign-in. */
  reconnect: { label: string; hint: string; write?: boolean; confirm?: boolean } | null;
  actions: ActionView[];
  firm: boolean;
  /** For the Advanced fold. */
  details: { label: string; value: string }[];
  /** A plugin installed in the app: its settings form. */
  pluginSettings?: { settings: unknown[]; values: Record<string, unknown> };
}
export interface ReadyView { id: string; name: string; summary: string; problem: string | null; needsSignIn: boolean; onlyBots: string[] | null; canDelete: boolean; reconnect: boolean }

const botRows = () => db.prepare("SELECT id, name, user_id AS userId FROM bots WHERE COALESCE(kind,'agent') <> 'room' ORDER BY created_at").all() as { id: string; name: string; userId: string }[];
const connectorRow = (id: string) => db.prepare('SELECT * FROM connectors WHERE id=?').get(id) as any;
const isAdded = (id: string) => !!db.prepare('SELECT 1 FROM connector_apps WHERE connector_id=?').get(id);

/** "search_gmail_messages" → "Search gmail messages". */
const toolLabel = (t: string) => { const s = t.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
const firstSentence = (s: string | undefined | null, max = 140) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  const one = m ? m[1] : t;
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};
const hasVar = (v: unknown) => JSON.stringify(v ?? null).includes('${');

const SCOPE_NAMES: Record<string, string> = {
  'gmail.readonly': 'reading mail', 'gmail.compose': 'drafts', 'gmail.send': 'sending mail', calendar: 'Calendar changes', 'calendar.readonly': 'Calendar',
  drive: 'Drive changes', 'drive.readonly': 'Drive', tasks: 'Tasks', 'tasks.readonly': 'Tasks',
};
const scopeName = (s: string) => SCOPE_NAMES[s.split('/').pop() ?? ''] ?? s.split('/').pop() ?? s;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Errors that mean the sign-in or key no longer works, so Reconnect is the fix. */
const AUTH_ERROR = /\b(401|403)\b|unauthori[sz]ed|invalid_grant|invalid[_ ]token|expired|revoked|sign[- ]?in|log ?in again|forbidden|refresh token/i;

/** An older Google connection set up by hand on the server (not through Connect Google). */
function isOldGoogle(cfg: AppConfig, src: string | undefined): boolean {
  if (src === 'google' || cfg.origin === 'installed') return false;
  return /^google\b/i.test(cfg.id) || /^google\b/i.test(cfg.name ?? '');
}

function whereLine(cfg: AppConfig): string {
  if (cfg.origin === 'installed') return 'On your server, as a plugin in its own process.';
  if (cfg.url) {
    if (hasVar(cfg.url)) return 'A service the server reaches by address.';
    try {
      const u = new URL(cfg.url);
      return /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname) ? 'On your server.' : `At ${u.host}${cfg.remote ? ' (on another machine or the internet)' : ''}.`;
    } catch { return 'A service the server reaches by address.'; }
  }
  return 'A program on your server.';
}

function setUpLine(cfg: AppConfig, src: string | undefined): string {
  if (src === 'google') return 'Connect Google, in this app';
  if (src === 'custom') return 'Connected by address, in this app';
  if (cfg.origin === 'catalog') return 'Added from your connection list, in this app';
  if (cfg.origin === 'installed') return 'Installed as a plugin, in this app';
  if (cfg.origin === 'env') return 'The server\'s settings (EXTRA_MCP_SERVERS in .env)';
  return 'The server\'s connection file (apps.json)';
}

function signInLine(cfg: AppConfig, src: string | undefined, email?: string): string {
  if (src === 'google') return `Google sign-in for ${email ?? 'one account'}; the keys stay on your server.`;
  if (cfg.oauth) return 'Its own sign-in; the key stays on your server and is refreshed there.';
  if (cfg.headersFile || (cfg.headers && Object.keys(cfg.headers).length) || (cfg.env && Object.keys(cfg.env).length)) return 'A key kept on your server (never shown).';
  return 'None needed.';
}

function toolViews(cfg: AppConfig, owner: boolean): { tools: ToolView[]; line: string } {
  const ts = appTools(cfg.id);
  const rules = loadRules();
  const tools: ToolView[] = ts.map((t) => {
    const base = appBaseRule(t);
    const eff = appRule(t);
    const chosen = rules.has(`${cfg.id}\u0000${t.tool}`);
    let choices: ToolRule[] = ['runs', 'asks', 'off'];
    let note: string | null = null;
    if (base.fixed && base.decision === 'block') { choices = []; note = cfg.readOnly ? 'This connection is read only, so tools that change things are off.' : 'Blocked by how this connection is set up.'; }
    else if (base.fixed) { choices = ['asks', 'off']; note = 'Always asks first, so it can\'t be set to run on its own.'; }
    return { name: t.tool, label: toolLabel(t.tool), rule: RULE_OF[eff.decision], chosen, choices: owner ? choices : [], note };
  });
  const runs = tools.filter((t) => t.rule === 'runs').length;
  const asks = tools.filter((t) => t.rule === 'asks').length;
  const off = tools.filter((t) => t.rule === 'off').length;
  const parts = [runs && `${runs} run on their own`, asks && `${asks} ask first`, off && `${off} off`].filter(Boolean) as string[];
  const line = !ts.length ? 'No tools listed yet' : `${ts.length} tool${ts.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
  return { tools, line };
}

function googleSummary(id: string): { summary: string; missing: string[]; email?: string; write: boolean } {
  const g = googleSetup(id);
  if (!g) return { summary: 'A Google account.', missing: [], write: false };
  const services = g.permissions.some((p) => p.startsWith('tasks:')) ? 'Gmail, Calendar, Drive and Tasks' : 'Gmail, Calendar and Drive';
  const mode = g.write ? 'Reads run on their own; changes ask first.' : 'Read only.';
  return { summary: `${services} for ${g.email}. ${mode}`, missing: [...new Set(g.missing.map(scopeName))], email: g.email, write: g.write };
}

/** Every connection, worded the same for every app. A person who isn't the owner sees only connections their Bots can have, and only their Bots. */
export async function connectionsFor(userId: string): Promise<{ owner: boolean; connections: ConnectionView[]; ready: ReadyView[] }> {
  const owner = isOwner(userId);
  const status = new Map((await appsStatus()).apps.map((a) => [a.id, a]));
  const overview = new Map(pluginOverview().map((p) => [p.id, p]));
  const people = new Map((db.prepare('SELECT id, name, email FROM users').all() as { id: string; name: string | null; email: string }[]).map((x) => [x.id, x.name || x.email]));
  const agentBots = new Set(botRows().map((b) => b.id));
  const out: ConnectionView[] = [];
  for (const cfg of allAppConfigs()) {
    const s: AppStatus | undefined = status.get(cfg.id);
    const o = overview.get(cfg.id);
    const row = cfg.origin === 'catalog' ? connectorRow(cfg.id) : undefined;
    const src: string | undefined = row?.source;
    const bots = (o?.bots ?? []).filter((b) => agentBots.has(b.id) && (owner || b.userId === userId))
      .map((b) => ({ id: b.id, name: b.name, on: b.enabled, ...(b.userId !== userId ? { ownerName: people.get(b.userId) ?? 'someone else' } : {}) }));
    if (!owner && !bots.length) continue;
    const on = bots.filter((b) => b.on);
    const kind: ConnectionView['kind'] = src === 'google' || isOldGoogle(cfg, src) ? 'google' : cfg.origin === 'installed' ? 'plugin' : 'service';
    const { tools, line } = toolViews(cfg, owner);

    let summary = firstSentence(cfg.description ?? s?.description) || (kind === 'plugin' ? 'A plugin made for your Bots.' : 'A service your Bots can use.');
    let problem: string | null = null;
    let state: ConnState = 'connected';
    let reconnect: ConnectionView['reconnect'] = null;
    const g = src === 'google' ? googleSummary(cfg.id) : null;
    if (g) summary = g.summary;

    const err = s?.error ? firstSentence(redact(s.error), 160) : '';
    if (s?.status === 'disabled') { state = 'off'; problem = 'Turned off for every Bot. Turn it on to use it again.'; }
    else if (g && g.missing.length) { state = 'needs_reconnect'; problem = `${list(g.missing).replace(/^./, (c) => c.toUpperCase())} ${g.missing.length === 1 ? 'isn\'t' : 'aren\'t'} allowed yet. Press Reconnect and tick every box on Google's page.`; }
    else if (row && row.template && !signedIn(JSON.parse(row.template))) { state = 'needs_reconnect'; problem = 'Not signed in. Press Reconnect to sign in.'; }
    else if (s?.status === 'error') { state = AUTH_ERROR.test(s.error ?? '') ? 'needs_reconnect' : 'not_working'; problem = state === 'needs_reconnect' ? `Its sign-in stopped working (${err}). Press Reconnect.` : `${err || 'It stopped answering'}. Press Reconnect to start it again.`; }
    else if (s?.status !== 'ready') { state = 'not_working'; problem = 'Not running. Press Reconnect to start it.'; }
    else if (kind === 'google' && src !== 'google' && !appTools(cfg.id).some((t) => /task/i.test(t.tool))) {
      state = 'needs_reconnect';
      problem = 'An older Google sign-in, without Tasks. Press Reconnect to sign in again with Tasks; its Bots move to the new sign-in.';
    } else if (!on.length) { state = 'off'; problem = bots.length ? 'No Bot uses it. Switch it on for a Bot below.' : null; }

    if (owner && s?.status !== 'disabled') {
      if (src === 'google') reconnect = { label: 'Reconnect', hint: `Opens Google's page on ${g?.email ?? 'this account'}. Tick every box there; your Bots keep it.`, write: g?.write };
      else if (kind === 'google') reconnect = { label: 'Reconnect', hint: 'Opens Google\'s page. Pick the same account and tick every box. Its Bots move to the new sign-in, which includes Tasks; the old one is switched off (Undo in Recent changes).', write: true, confirm: true };
      else if (src === 'custom' && row?.template && JSON.parse(row.template).oauth) reconnect = { label: 'Reconnect', hint: 'Opens its sign-in page. Sign in, then come back here.' };
      else reconnect = { label: 'Reconnect', hint: 'Starts the connection again and lists its tools again. Use it when it stops answering or after it was changed.' };
    }

    const actions: ActionView[] = [];
    if (owner) {
      if (cfg.origin === 'apps.json') {
        if (s?.status === 'disabled') actions.push({ id: 'turn_on', label: 'Turn on', danger: false, hint: 'Starts it again for the Bots that had it.' });
        else actions.push({ id: 'turn_off', label: 'Turn off', danger: true, hint: 'Stops it for every Bot, keeping its setup. Turn it on again any time.' });
        actions.push({ id: 'remove', label: 'Remove', danger: true, hint: 'Removes it from your server. Undo in Recent changes puts it back exactly.' });
      } else if (cfg.origin === 'catalog' && isAdded(cfg.id)) {
        actions.push({ id: 'remove', label: 'Remove from Bots', danger: true, hint: `Every Bot loses it. ${src === 'google' || src === 'custom' ? 'The sign-in stays, so it' : 'It'} waits under Add a connection, ready to add again.` });
        if (src === 'google' || src === 'custom') actions.push({ id: 'delete', label: src === 'google' ? 'Disconnect account' : 'Delete', danger: true, hint: 'Every Bot loses it and its sign-in is deleted from your server. Connect it again to use it.' });
      } else if (cfg.origin === 'installed') {
        actions.push({ id: 'remove', label: 'Remove', danger: true, hint: 'Every Bot loses it. Its files are kept, so it can be restored.' });
        actions.push({ id: 'delete', label: 'Delete plugin', danger: true, hint: 'Deletes its files and settings from your server. This can\'t be undone.' });
      }
    }

    const details: { label: string; value: string }[] = [
      { label: 'Where it runs', value: whereLine(cfg) },
      { label: 'Set up in', value: setUpLine(cfg, src) },
      { label: 'Sign-in', value: signInLine(cfg, src, g?.email) },
    ];
    if (cfg.url && !hasVar(cfg.url)) details.push({ label: 'Address', value: cfg.url });
    if (cfg.origin === 'installed') details.push({ label: 'Sites it talks to', value: cfg.network?.length ? cfg.network.join(', ') : 'None' });
    if (g) {
      const gs = googleSetup(cfg.id);
      if (gs) details.push({ label: 'Google allows', value: gs.granted.length ? [...new Set(gs.granted.map(scopeName))].join(', ') : 'Nothing yet' });
    }
    if (s?.version ?? cfg.version) details.push({ label: 'Version', value: String(s?.version ?? cfg.version) });
    if (s?.digest ?? cfg.digest) details.push({ label: 'Fingerprint', value: String(s?.digest ?? cfg.digest).slice(0, 16) });
    if (err) details.push({ label: 'Last error', value: err });
    if (cfg.exclusive) details.push({ label: 'One Bot only', value: 'At most one Bot may have it on.' });
    if (cfg.onlyBots?.length) details.push({ label: 'Only for', value: cfg.onlyBots.join(', ') });
    details.push({ label: 'Approvals', value: 'A connection can never answer an approval card. Anything that changes data asks on a card in the chat unless you set it to run on its own here.' });
    details.push({ label: 'Id', value: cfg.id });

    const inst = cfg.origin === 'installed' ? installedPlugin(cfg.id) : undefined;
    const restorable = inst ? pluginHistory(cfg.id).find((h) => h.status === 'removed') : undefined;
    if (owner && restorable) actions.push({ id: 'restore', label: `Restore ${restorable.version}`, danger: false, hint: 'Puts the earlier version back. Bot switches stay as they are.' });

    out.push({
      id: cfg.id, name: cfg.name ?? cfg.id, ...(cfg.logo ? { logo: cfg.logo } : {}), kind, state, stateText: STATE_TEXT[state], summary, problem,
      usedBy: on.length ? `Used by ${list(on.map((b) => b.name))}` : 'No Bot uses it yet', bots, toolsLine: line, tools: owner ? tools : [],
      reconnect, actions, firm: isFirmApp(cfg.id), details,
      ...(owner && inst?.manifest.settings?.length ? { pluginSettings: { settings: inst.manifest.settings, values: publicValues(inst.manifest.settings, pluginSettings(inst.id)) } } : {}),
    });
  }
  const order: Record<ConnState, number> = { needs_reconnect: 0, not_working: 1, connected: 2, off: 3 };
  out.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));

  let ready: ReadyView[] = [];
  if (owner) {
    const conns: ConnectorView[] = await listConnectors();
    ready = conns.filter((c) => !c.browserSite && !c.added && !c.apps.length && (c.canAdd || (c.custom && c.needsSignIn))).map((c) => {
      const g = c.source === 'google' ? googleSummary(c.id) : null;
      const oauth = c.source === 'custom' && !!connectorRow(c.id)?.template && !!JSON.parse(connectorRow(c.id).template).oauth;
      return {
        id: c.id, name: c.name, needsSignIn: c.needsSignIn, onlyBots: c.onlyBots, canDelete: c.custom, reconnect: !!g || oauth,
        summary: g ? g.summary : firstSentence(c.description) || 'Ready for your Bots.',
        problem: g?.missing.length ? `${list(g.missing).replace(/^./, (x) => x.toUpperCase())} ${g.missing.length === 1 ? 'isn\'t' : 'aren\'t'} allowed yet. Press Reconnect and tick every box on Google's page.` : c.needsSignIn ? 'Not signed in yet. Press Reconnect to sign in.' : null,
      };
    });
  }
  return { owner, connections: out, ready };
}

// ---------- per-tool rules ----------

/** The owner's choice for one tool: runs on its own, asks first, off; null goes back to the default. Returns the tool as it is now. */
export function setToolRule(userId: string, appId: string, tool: string, rule: ToolRule | null): ToolView {
  if (!isOwner(userId)) throw new ConnectionError('Only the owner of this server can change connections.', 403);
  const cfg = appConfig(appId);
  if (!cfg) throw new ConnectionError('No such connection.', 404);
  const t = appTools(appId).find((x) => x.tool === tool);
  if (!t) throw new ConnectionError(`${cfg.name ?? appId} has no tool called ${tool}.`, 404);
  if (rule !== null && !(rule in OVERRIDE)) throw new ConnectionError('Pick runs, asks or off.');
  const before = toolViews(cfg, true).tools.find((x) => x.name === tool)!;
  if (rule !== null && !before.choices.includes(rule)) throw new ConnectionError(before.note ?? 'That can\'t be chosen for this tool.', 409);
  if (rule === null) db.prepare('DELETE FROM app_tool_rules WHERE app_id=? AND tool=?').run(appId, tool);
  else db.prepare(`INSERT INTO app_tool_rules(app_id,tool,rule,updated_at,updated_by) VALUES (?,?,?,?,?)
    ON CONFLICT(app_id,tool) DO UPDATE SET rule=excluded.rule, updated_at=excluded.updated_at, updated_by=excluded.updated_by`).run(appId, tool, OVERRIDE[rule], now(), userId);
  rulesCache = null;
  audit(userId, 'tool-rule', appId, null, { tool, from: before.chosen ? before.rule : 'default', to: rule ?? 'default' });
  return toolViews(cfg, true).tools.find((x) => x.name === tool)!;
}

// ---------- Reconnect ----------

/**
 * Reconnect, as the owner: a Google account signs in again on Google's page (on the same account,
 * keeping whether it may make changes unless `write` says otherwise); a server with its own sign-in
 * signs in again; anything else is started again so the Bots get its current tools. An older Google
 * connection goes through propose('reconnect') instead, since it moves Bots.
 */
export async function reconnect(userId: string, agent: string | null, appId: string, opts: { write?: boolean; base: string; origin: string }): Promise<{ signInUrl?: string; note: string }> {
  if (agent) throw new ConnectionError('Only a person can reconnect, from the app.', 403);
  if (!isOwner(userId)) throw new ConnectionError('Only the owner of this server can reconnect connections.', 403);
  const row = connectorRow(appId);
  const cfg = appConfig(appId);
  if (row?.source === 'google') {
    const a = account(appId);
    const write = typeof opts.write === 'boolean' ? opts.write : a?.write ?? true;
    const r = startGoogle(userId, agent, write, opts.base, { hint: a?.email });
    audit(userId, 'reconnect', appId, null, { how: 'google', write });
    return { signInUrl: r.signInUrl, note: 'Finish on Google\'s page: pick the same account and tick every box. Then come back here.' };
  }
  if (row?.source === 'custom' && row.template && JSON.parse(row.template).oauth) {
    const r = await restartSignIn(userId, appId, opts.origin);
    audit(userId, 'reconnect', appId, null, { how: 'signin' });
    return { signInUrl: r.signInUrl, note: 'Finish signing in on the page that opened, then come back here.' };
  }
  if (!cfg) throw new ConnectionError('No such connection.', 404);
  if (cfg.enabled === false) throw new ConnectionError(`${cfg.name ?? appId} is turned off. Turn it on instead.`, 409);
  if (isOldGoogle(cfg, row?.source)) throw new ConnectionError('Use Reconnect from the Connections list for this one: it asks you to confirm moving its Bots first.', 409);
  audit(userId, 'reconnect', appId, null, { how: 'restart' });
  const r = await reconnectApp(appId);
  return { note: r.ok ? `Reconnected. ${r.tools} tool${r.tools === 1 ? '' : 's'} ready.` : `Still not answering${r.error ? `: ${firstSentence(redact(r.error), 160)}` : ''}.` };
}

/** Once a sign-in started from an older Google connection is done: its Bots get the new account and lose the old one (each a change with Undo). */
async function moveBots(userId: string, oldId: string, newId: string) {
  const had = botsWith(oldId);
  if (!had.length) return;
  if (!isAdded(newId)) {
    db.prepare('INSERT INTO connector_apps(connector_id,bots,added_at,added_by) VALUES (?,?,?,?)').run(newId, '[]', now(), userId);
    invalidateApps();
  }
  for (const b of had) {
    try { await applyAsPerson(userId, { action: 'set_bot', app: newId, bot: b.id, on: true }, null, 'Reconnect (new Google sign-in)'); } catch (e) { if (!(e instanceof AdminError)) throw e; }
    try { await applyAsPerson(userId, { action: 'set_bot', app: oldId, bot: b.id, on: false }, null, 'Reconnect (new Google sign-in)'); } catch (e) { if (!(e instanceof AdminError)) throw e; }
  }
}
onGoogleReplaced(moveBots);

// ---------- Turn off, Turn on, Remove, Delete, Restore: proposed, then confirmed with the digest ----------

type Backend =
  | { kind: 'admin'; input: ChangeInput }
  | { kind: 'connector'; inner: string }
  | { kind: 'plugin'; inner: string; action: string }
  | { kind: 'delete-account'; appId: string }
  | { kind: 'old-google'; appId: string };
interface Proposal { id: string; userId: string; appId: string; summary: string; details: string[]; digest: string; danger: boolean; expiresAt: number; status: 'pending' | 'applying' | 'applied' | 'cancelled'; backend: Backend }
export interface ProposalView { id: string; summary: string; details: string[]; digest: string; danger: boolean; status: string; expiresAt: number }
const proposals = new Map<string, Proposal>();
const TTL = 10 * 60 * 1000;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const pview = (p: Proposal): ProposalView => ({ id: p.id, summary: p.summary, details: p.details, digest: p.digest, danger: p.danger, status: p.status === 'pending' && p.expiresAt <= now() ? 'expired' : p.status, expiresAt: p.expiresAt });

function keep(p: Omit<Proposal, 'id' | 'expiresAt' | 'status'>): ProposalView {
  for (const [k, v] of proposals) if (v.expiresAt < now() - TTL) proposals.delete(k);
  const full: Proposal = { ...p, id: newId('cnp'), expiresAt: now() + TTL, status: 'pending' };
  proposals.set(full.id, full);
  return pview(full);
}

const wrapAdmin = (e: unknown) => (e instanceof AdminError ? new ConnectionError(e.message, 409) : e);
const wrapOther = (e: unknown) => (e instanceof ConnectorError || (e as any)?.name === 'PluginError' || (e as any)?.status ? new ConnectionError((e as Error).message, ((e as any).status ?? 400) as 400) : e);

export function propose(userId: string, appId: string, action: string): ProposalView {
  if (!isOwner(userId)) throw new ConnectionError('Only the owner of this server can change connections.', 403);
  const cfg = appConfig(appId);
  const row = connectorRow(appId);
  const name = cfg?.name ?? row?.name ?? appId;
  const firm = isFirmApp(appId) ? ['This is a work (firm) connection. Confirming approves this one change only.'] : [];
  const on = cfg ? botsWith(appId).map((b) => b.name) : [];
  const losing = on.length ? `${list(on)} lose${on.length === 1 ? 's' : ''} its tools.` : 'No Bot uses it now.';

  if (action === 'reconnect') {
    if (!cfg || !isOldGoogle(cfg, row?.source)) throw new ConnectionError('Press Reconnect on the connection instead.', 409);
    const d = sha(JSON.stringify(['old-google', appId, on]));
    return keep({ userId, appId, danger: false, digest: d, backend: { kind: 'old-google', appId },
      summary: `Reconnect ${name} with a new Google sign-in`,
      details: ['Google\'s page opens next. Pick the same account and tick every box, including Tasks.', on.length ? `Then ${list(on)} move${on.length === 1 ? 's' : ''} to the new sign-in, and ${name} is switched off for ${on.length === 1 ? 'them' : 'them'}.` : 'No Bot uses this one, so nothing moves.', 'Each move shows in Recent changes with Undo.'] });
  }
  if (!cfg && !(row && (row.source === 'google' || row.source === 'custom'))) throw new ConnectionError('No such connection.', 404);

  if (cfg?.origin === 'apps.json' && (action === 'turn_off' || action === 'turn_on' || action === 'remove')) {
    if (action === 'turn_on' && cfg.enabled !== false) throw new ConnectionError(`${name} is already on.`, 409);
    if (action === 'turn_off' && cfg.enabled === false) throw new ConnectionError(`${name} is already off.`, 409);
    const input: ChangeInput = action === 'remove' ? { action: 'remove_app', app: appId } : action === 'turn_on' ? { action: 'edit_app', app: appId, unset: ['enabled'] } : { action: 'edit_app', app: appId, set: { enabled: false } };
    let pre;
    try { pre = previewForPerson(input); } catch (e) { throw wrapAdmin(e); }
    const details = action === 'turn_off' ? [losing, 'Its setup is kept; Turn on puts it back.']
      : action === 'turn_on' ? ['It starts again, and the Bots it was on for get its tools back.']
        : [losing, 'It is removed from your server. Undo in Recent changes puts it back exactly.'];
    return keep({ userId, appId, danger: action !== 'turn_on', digest: pre.digest, backend: { kind: 'admin', input },
      summary: `${action === 'turn_off' ? 'Turn off' : action === 'turn_on' ? 'Turn on' : 'Remove'} ${name}`, details: [...firm, ...details] });
  }
  if (cfg?.origin === 'catalog' && action === 'remove') {
    try {
      const v = proposeConnector(userId, { action: 'remove', connectorId: appId });
      return keep({ userId, appId, danger: true, digest: v.digest, backend: { kind: 'connector', inner: v.id }, summary: `Remove ${name} from every Bot`, details: [...firm, losing, row?.source === 'google' || row?.source === 'custom' ? 'Its sign-in stays, so you can add it again under Add a connection.' : 'You can add it again under Add a connection.'] });
    } catch (e) { throw wrapOther(e); }
  }
  if (action === 'delete' && row && (row.source === 'google' || row.source === 'custom')) {
    return keep({ userId, appId, danger: true, digest: sha(JSON.stringify(['delete-account', appId, row.template])), backend: { kind: 'delete-account', appId },
      summary: row.source === 'google' ? `Disconnect ${name}` : `Delete ${name}`, details: [...(on.length ? [losing] : []), 'Its sign-in or key is deleted from your server. Connect it again to use it.'] });
  }
  if (cfg?.origin === 'installed' && (action === 'remove' || action === 'delete' || action === 'restore')) {
    try {
      const restore = action === 'restore' ? pluginHistory(appId).find((h) => h.status === 'removed') : undefined;
      const v = proposeChange(userId, { action, pluginId: appId, ...(restore ? { digest: restore.digest } : {}) } as never);
      return keep({ userId, appId, danger: action !== 'restore', digest: v.digest, backend: { kind: 'plugin', inner: v.id, action }, summary: v.summary, details: v.details });
    } catch (e) { throw wrapOther(e); }
  }
  throw new ConnectionError(`${name} can't be changed that way here.`, 409);
}

export async function confirm(userId: string, agent: string | null, id: string, digest: unknown, opts: { via: string; base: string }): Promise<ProposalView & { signInUrl?: string; note?: string }> {
  if (agent) throw new ConnectionError('Only a person can confirm changes, from the app.', 403);
  const p = proposals.get(id);
  if (!p || p.userId !== userId) throw new ConnectionError('No such change.', 404);
  if (!isOwner(userId)) throw new ConnectionError('Only the owner of this server can change connections.', 403);
  if (p.status === 'applied') return pview(p);
  if (p.status === 'applying') throw new ConnectionError('That change is being made now.', 409);
  if (p.status !== 'pending' || p.expiresAt <= now()) throw new ConnectionError('That change expired or was cancelled. Start again.', 409);
  if (digest !== p.digest) throw new ConnectionError('That change is not the one shown. Start again.', 409);
  const b = p.backend;
  let extra: { signInUrl?: string; note?: string } = {};
  // Claimed before the first await, so a second press (or a second device) cannot make the change twice.
  p.status = 'applying';
  try {
    if (b.kind === 'admin') { await applyAsPerson(userId, b.input, p.digest, opts.via, p.summary); }
    else if (b.kind === 'connector') { confirmConnector(userId, b.inner, p.digest); }
    else if (b.kind === 'plugin') {
      const done = confirmChange(userId, b.inner, p.digest);
      if (b.action === 'delete' && done.status === 'applied') markPluginDeleted(String((done.result as any)?.deleted ?? ''));
    } else if (b.kind === 'delete-account') {
      const row = connectorRow(b.appId);
      if (!row || sha(JSON.stringify(['delete-account', b.appId, row.template])) !== p.digest) throw new ConnectionError('That connection changed after you were shown this; nothing was deleted. Look again.', 409);
      await deleteCustom(userId, b.appId);
    } else if (b.kind === 'old-google') {
      if (sha(JSON.stringify(['old-google', b.appId, botsWith(b.appId).map((x) => x.name)])) !== p.digest) throw new ConnectionError('Its Bots changed after you were shown this. Look again.', 409);
      const r = startGoogle(userId, agent, true, opts.base, { replaces: b.appId });
      audit(userId, 'reconnect', b.appId, null, { how: 'google-new' });
      extra = { signInUrl: r.signInUrl, note: 'Finish on Google\'s page: pick the same account and tick every box. Its Bots move over when you are done.' };
    }
  } catch (e) { p.status = 'pending'; throw wrapOther(wrapAdmin(e)); }
  p.status = 'applied';
  return { ...pview(p), ...extra };
}

export function cancel(userId: string, id: string): ProposalView {
  const p = proposals.get(id);
  if (!p || p.userId !== userId) throw new ConnectionError('No such change.', 404);
  if (p.status === 'pending') {
    p.status = 'cancelled';
    if (p.backend.kind === 'connector') try { cancelConnector(userId, p.backend.inner); } catch { /* already gone */ }
    if (p.backend.kind === 'plugin') try { cancelChange(userId, p.backend.inner); } catch { /* already gone */ }
  }
  return pview(p);
}
