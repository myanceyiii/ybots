import { env } from './env.js';

/**
 * Names for the people of this install, taken from settings so no person's name is written into the
 * code: the owner's name from DISPLAY_NAMES for OWNER_EMAIL, and a scoped person's name (SCOPED_PEOPLE)
 * from DISPLAY_NAMES for that person's address. Display only; nothing here grants access.
 */

/** The first name in a display name: "Alex" from "Alex", and from "Alex & Sam". */
export function firstNameOf(name: string | null | undefined): string | null {
  const n = String(name ?? '').trim();
  if (!n || n.includes('@')) return null;
  const first = n.split(/\s*(?:&|\band\b|,|\+)\s*/i)[0]?.trim().split(/\s+/)[0] ?? '';
  return first && /\p{L}/u.test(first) ? first : null;
}

/** The owner's first name (DISPLAY_NAMES for OWNER_EMAIL), else `fallback`. */
export function ownerName(fallback = 'the owner'): string {
  return firstNameOf(env.displayNames.get(env.ownerEmail)) ?? fallback;
}

/**
 * The first name of the person whose scoped sign-in sees a bot with this name (SCOPED_PEOPLE
 * `person@x=BotName`, named by DISPLAY_NAMES), else `fallback`.
 */
export function scopedPersonName(botName: string, fallback = 'them'): string {
  const want = String(botName ?? '').trim().toLowerCase();
  for (const [email, bots] of env.scopedPeople) {
    if (!bots.includes(want)) continue;
    const n = firstNameOf(env.displayNames.get(email));
    if (n) return n;
  }
  return fallback;
}
