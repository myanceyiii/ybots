import { appRule, type AppTool } from './local-apps.js';
import { toolsForBot } from './plugins/registry.js';
import { account } from './google-accounts.js';
import { remindersText } from './reminders-text.js';

/**
 * "Remind me to ..." for a bot that has Google Tasks (Alex, 2026-11-26: Leonard should put reminders
 * in Google Tasks when asked). The Tasks tools come from a Google account connected with Tasks
 * (google-accounts.ts, workspace-mcp `tasks:manage`), so this guidance shows only for a bot that has
 * one on; every other bot keeps answering reminders as before.
 *
 * Google Tasks keeps only the DATE of a due time (the API drops the time of day), so a reminder for a
 * set time also gets a one-time app routine at that time (create_routine once=true). That routine's
 * run is an ordinary bot message, so the owner's phone and PC get the usual notification on time.
 */

/** The bot's Google Tasks write tool (`<app>__manage_task`), or null when it has none it may use. */
export async function tasksToolFor(botId: string): Promise<AppTool | null> {
  let tools: AppTool[] = [];
  try { tools = await toolsForBot(botId); } catch { return null; }
  const usable = tools.filter((t) => t.tool === 'manage_task' && !(appRule(t).fixed && appRule(t).decision === 'block'));
  // A personal Google account (google-<email>) before the older shared one, so the pick is stable.
  usable.sort((a, b) => Number(b.appId.startsWith('google-')) - Number(a.appId.startsWith('google-')) || a.name.localeCompare(b.name));
  return usable[0] ?? null;
}

export async function remindersGuidance(botId: string, owner: string): Promise<string> {
  const t = await tasksToolFor(botId);
  if (!t) return '';
  let email: string | null = null;
  try { email = account(t.appId)?.email ?? null; } catch { /* the older shared Google app has no account file */ }
  return remindersText(t.name, owner, email);
}
