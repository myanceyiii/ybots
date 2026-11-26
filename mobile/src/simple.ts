import { useSyncExternalStore } from 'react';

/**
 * The simple view: what a scoped sign-in sees (the server's SCOPED_PEOPLE, e.g. Sam with one bot). It hides the workings a household assistant
 * doesn't need to show: the bot's computer, its model and helpers, raw commands in its steps, the
 * team-wide settings. Nothing is hidden for safety; the server already refuses what the sign-in may not do.
 */
let scoped = false;
const subs = new Set<() => void>();
export const isSimple = () => scoped;
/** App.tsx says whether the signed-in person is scoped (/auth/me user.scope). */
export function setScopedSignIn(v: boolean) {
  if (v === scoped) return;
  scoped = v;
  for (const f of subs) f();
}
export function useSimple(): boolean {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, isSimple, isSimple);
}

/**
 * A step's name in plain words for the simple view: no tool ids, commands or file paths. The server's
 * label ("Using Actual Budget", "Searching the web") is kept when it reads like words; a raw tool id is not.
 */
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
