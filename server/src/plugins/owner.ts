import { db } from '../db.js';
import { env } from '../env.js';

/**
 * Whether this account is the owner of the server: the account whose email is OWNER_EMAIL, or, when
 * OWNER_EMAIL is not set, anyone signed in on a server that only listens on this machine (the same
 * rule as engine.ts, mayUsePrimary). Only the owner installs, removes or switches plugins, and only
 * from the signed-in app: no bot, plugin or message can.
 */
export function isOwner(userId: string): boolean {
  const email = String((db.prepare('SELECT email FROM users WHERE id=?').get(userId) as { email?: string } | undefined)?.email ?? '').toLowerCase();
  if (!email) return false;
  return env.ownerEmail ? email === env.ownerEmail : env.localOnly;
}
