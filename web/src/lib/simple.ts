import { useStore } from '../store';

/**
 * The simple view: what a scoped sign-in sees on the web and in the Windows app (the Android app's is
 * mobile/src/simple.ts). On for a scoped sign-in (the server's SCOPED_PEOPLE). It
 * hides the workings a household assistant doesn't need to show: the bot's computer, model and engine,
 * raw commands in its steps, and the team-wide settings. The server already refuses what the sign-in may not do.
 */
export const useSimple = () => useStore((s) => !!s.user?.scope);
export const isSimpleNow = () => !!useStore.getState().user?.scope;

/** A step's name in plain words for the simple view: no tool ids, commands or file paths. */
export function plainStep(label: string | undefined, name: string | undefined): string {
  const l = String(label ?? '').trim();
  if (l && !/[_/]|^mcp|\(|\)|[{}]/.test(l)) return l;
  const n = String(name ?? '').toLowerCase();
  if (/search|web|browse/.test(n)) return 'Looking it up';
  if (/mail|gmail/.test(n)) return 'Checking email';
  if (/calendar/.test(n)) return 'Checking the calendar';
  if (/actual|budget|plaid|finance|transaction/.test(n)) return 'Checking the budget';
  if (/message|send_to|bot_chat|ask_bot|delegate/.test(n)) return 'Talking with the team';
  if (/memory|remember/.test(n)) return 'Remembering';
  if (/file|write|read|page|document/.test(n)) return 'Working on a file';
  if (/cron|routine|schedule|remind/.test(n)) return 'Setting a reminder';
  return 'Working on it';
}
