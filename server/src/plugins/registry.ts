import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import './store.js';
import { allAppConfigs, appConfig, appInfo, listAppTools, type AppConfig, type AppTool } from '../local-apps.js';
import { logActivity } from '../activity.js';

/**
 * Which bot has which plugin on.
 *
 * Every app in apps.json, every EXTRA_MCP_SERVERS entry and every plugin installed through the app is
 * a plugin (local-apps.ts loads them). Whether a bot gets one is decided here:
 *
 *  1. the owner's switch for that plugin and bot (table plugin_bots), if there is one;
 *  2. otherwise the plugin's `bots` field: bot ids or names, or "*";
 *  3. otherwise: hand-written entries (apps.json, EXTRA_MCP_SERVERS) go to every bot, as they always
 *     did; plugins installed through the app go to none.
 *
 * A plugin marked `exclusive` may be on for one bot at most. Turning one on for a second bot is
 * refused; the owner turns it off for the first bot first. Every change is written to plugin_audit.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS plugin_bots (
  plugin_id TEXT NOT NULL,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (plugin_id, bot_id)
);
CREATE TABLE IF NOT EXISTS plugin_audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  bot_id TEXT,
  detail TEXT
);
`);

interface BotLite { id: string; name: string }
const bots = (): (BotLite & { userId: string })[] => db.prepare('SELECT id, name, user_id AS userId FROM bots ORDER BY created_at').all() as (BotLite & { userId: string })[];
const botLite = (id: string): BotLite | undefined => db.prepare('SELECT id, name FROM bots WHERE id=?').get(id) as BotLite | undefined;

/** Whether the plugin's own `bots` field (or the default for its origin) gives it to this bot. */
const named = (list: string[], bot: BotLite) => list.some((b) => b === bot.id || b.toLowerCase() === bot.name.toLowerCase());
/** Whether "onlyBots" lets this bot have it at all. */
export function allowedFor(cfg: AppConfig, bot: BotLite): boolean {
  return !cfg.onlyBots || named(cfg.onlyBots, bot);
}

export function defaultOn(cfg: AppConfig, bot: BotLite): boolean {
  // An exclusive plugin is on by default only when its entry names exactly one bot.
  if (cfg.exclusive && (cfg.bots === undefined || cfg.bots.length !== 1 || cfg.bots[0] === '*')) return false;
  if (cfg.bots === undefined) return cfg.origin !== 'installed';
  return cfg.bots.some((b) => b === '*' || b === bot.id || b.toLowerCase() === bot.name.toLowerCase());
}

function switchFor(pluginId: string, botId: string): boolean | undefined {
  const r = db.prepare('SELECT enabled FROM plugin_bots WHERE plugin_id=? AND bot_id=?').get(pluginId, botId) as { enabled: number } | undefined;
  return r ? r.enabled === 1 : undefined;
}

/** Whether a bot has this plugin on. Unknown plugins and unknown bots are off. */
export function enabledFor(pluginId: string, botId: string): boolean {
  const cfg = appConfig(pluginId);
  const bot = botLite(botId);
  if (!cfg || !bot || !allowedFor(cfg, bot)) return false;
  return switchFor(pluginId, botId) ?? defaultOn(cfg, bot);
}

/** The bots that have this plugin on. */
export function botsWith(pluginId: string): BotLite[] {
  return bots().filter((b) => enabledFor(pluginId, b.id)).map(({ id, name }) => ({ id, name }));
}

/** The tools of every running plugin this bot has on. */
export async function toolsForBot(botId: string): Promise<AppTool[]> {
  return (await listAppTools()).filter((t) => enabledFor(t.appId, botId));
}

export function audit(userId: string | null, action: string, pluginId: string, botId: string | null, detail?: unknown) {
  db.prepare('INSERT INTO plugin_audit(id,at,user_id,action,plugin_id,bot_id,detail) VALUES (?,?,?,?,?,?,?)')
    .run(newId('pau'), now(), userId, action, pluginId, botId, detail === undefined ? null : JSON.stringify(detail));
  // The activity trail (activity.ts) shows a person's change to a plugin or connection too. A bot's own
  // change (`admin:…`) is already a row from its tool call.
  if (userId && !action.startsWith('admin:')) {
    logActivity({ userId, botId, tool: `plugin.${action}`, title: `${appInfo(pluginId)?.name ?? pluginId}: ${action.replace(/^person:/, '').replace(/[-_:.]/g, ' ')}`, outcome: 'allowed', source: action.startsWith('connector') || action.startsWith('person:') || action === 'reconnect' || action === 'tool-rule' ? 'connection' : 'plugin', starter: { kind: 'person' }, looks: false });
  }
}

export class PluginError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) { super(message); }
}

/**
 * Turn a plugin on or off for one bot, as the owner. Returns the state read back from the database,
 * so the caller can show what is actually stored rather than what it asked for.
 */
export function setEnabled(userId: string, pluginId: string, botId: string, enabled: boolean): { pluginId: string; botId: string; enabled: boolean } {
  const cfg = appConfig(pluginId);
  if (!cfg) throw new PluginError(`No plugin called ${pluginId}.`, 404);
  const bot = botLite(botId);
  if (!bot) throw new PluginError('No such bot.', 404);
  if (enabled && !allowedFor(cfg, bot)) throw new PluginError(`${cfg.name ?? pluginId} is only for ${cfg.onlyBots!.join(', ')}.`, 409);
  if (enabled && cfg.exclusive) {
    const other = botsWith(pluginId).find((b) => b.id !== botId);
    if (other) throw new PluginError(`${cfg.name ?? pluginId} can be on for one bot only, and ${other.name} has it. Turn it off for ${other.name} first.`, 409);
  }
  db.prepare(`INSERT INTO plugin_bots(plugin_id,bot_id,enabled,updated_at,updated_by) VALUES (?,?,?,?,?)
              ON CONFLICT(plugin_id,bot_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(pluginId, botId, enabled ? 1 : 0, now(), userId);
  audit(userId, enabled ? 'enable' : 'disable', pluginId, botId);
  return { pluginId, botId, enabled: enabledFor(pluginId, botId) };
}

/**
 * The owner's own switch, flipped straight from the Plugins page (no confirm step: the signed-in
 * person is the approver). `enabled: null` clears the switch so the plugin's default applies again
 * (used by Undo). Returns the state before and after, read back from the database.
 */
export function flipSwitch(userId: string, pluginId: string, botId: string, enabled: boolean | null, via: string) {
  const cfg = appConfig(pluginId);
  if (!cfg) throw new PluginError(`No plugin called ${pluginId}.`, 404);
  const bot = botLite(botId);
  if (!bot) throw new PluginError('No such bot.', 404);
  const sw = switchFor(pluginId, botId);
  const before = { enabled: enabledFor(pluginId, botId), fromDefault: sw === undefined };
  if (enabled === null) {
    db.prepare('DELETE FROM plugin_bots WHERE plugin_id=? AND bot_id=?').run(pluginId, botId);
    if (enabledFor(pluginId, botId) && cfg.exclusive && botsWith(pluginId).some((b) => b.id !== botId)) {
      // Going back to the default would put an exclusive plugin on twice; keep it off instead.
      setEnabled(userId, pluginId, botId, false);
    } else {
      audit(userId, 'default', pluginId, botId, { via });
    }
  } else {
    setEnabled(userId, pluginId, botId, enabled);
  }
  const after = { enabled: enabledFor(pluginId, botId), fromDefault: switchFor(pluginId, botId) === undefined };
  return { pluginId, botId, pluginName: cfg.name ?? pluginId, botName: bot.name, before, after };
}

/** Every plugin with the bots that have it on, for the Plugins page and list_apps. */
export function pluginOverview(): { id: string; name: string; origin: string; exclusive: boolean; bots: { id: string; name: string; userId: string; enabled: boolean; fromDefault: boolean }[] }[] {
  const all = bots();
  return allAppConfigs().map((cfg) => ({
    id: cfg.id,
    name: cfg.name ?? cfg.id,
    origin: cfg.origin ?? 'apps.json',
    exclusive: cfg.exclusive === true,
    bots: all.filter((b) => allowedFor(cfg, b)).map((b) => {
      const sw = switchFor(cfg.id, b.id);
      return { id: b.id, name: b.name, userId: b.userId, enabled: sw ?? defaultOn(cfg, b), fromDefault: sw === undefined };
    }),
  }));
}
