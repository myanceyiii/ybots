import crypto from 'node:crypto';
import { env } from '../env.js';

/**
 * Sign-in through Cloudflare Access. When the app sits behind an Access application, Cloudflare puts a
 * signed token (a JWT) in the `Cf-Access-Jwt-Assertion` header of every request it lets through. The
 * token says which email address passed Access. It is signed with the Access team's keys, which are
 * published at https://<team>.cloudflareaccess.com/cdn-cgi/access/certs, so the app checks the
 * signature itself and never takes the header on trust: a caller on this machine or the network can
 * write the header, but cannot sign it.
 *
 * Checked: the signature (RS256, a key the team publishes), the issuer (the team domain), the audience
 * (this Access application's AUD tag, so a token for another app on the same team is refused), the
 * expiry and not-before times, and that the token names a person (a service token carries no email).
 * Who then gets in is still decided by ALLOWED_EMAILS (see routes.ts).
 */

type Jwk = crypto.JsonWebKey & { kid?: string };

let keys = new Map<string, crypto.KeyObject>();
let fetchedAt = 0;
let lastTry = 0;
let inflight: Promise<void> | null = null;

const KEYS_TTL = 60 * 60_000;
/** A token with a key we don't have makes us ask again, but at most this often. */
const RETRY_GAP = 60_000;

/** Whether Access sign-in is set up (CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD). */
export function accessConfigured(): boolean {
  return !!(env.cfAccessTeamDomain && env.cfAccessAud.length);
}

function certsUrl(): string {
  return env.cfAccessCertsUrl || `${env.cfAccessTeamDomain}/cdn-cgi/access/certs`;
}

async function loadKeys(): Promise<void> {
  lastTry = Date.now();
  const res = await fetch(certsUrl(), { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const next = new Map<string, crypto.KeyObject>();
  for (const k of body.keys ?? []) {
    if (!k.kid || k.kty !== 'RSA') continue;
    try { next.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })); } catch { /* skip a key we can't read */ }
  }
  if (!next.size) throw new Error('Access certs: no usable keys');
  keys = next;
  fetchedAt = Date.now();
}

async function keyFor(kid: string): Promise<crypto.KeyObject | undefined> {
  // Stale keys are refetched at most once per RETRY_GAP: while the certs address is down, requests use the
  // keys we have instead of each waiting up to 5 s on another try.
  const stale = Date.now() - fetchedAt > KEYS_TTL && Date.now() - lastTry > RETRY_GAP;
  const unknown = !keys.has(kid) && Date.now() - lastTry > RETRY_GAP;
  if (stale || unknown) {
    inflight ??= loadKeys().catch((e) => console.warn(`[access] ${e?.message ?? e}`)).finally(() => { inflight = null; });
    await inflight;
  }
  return keys.get(kid);
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** The email address a valid Access token names, or null for anything else (bad, expired, another app's, a service token). */
export async function accessEmail(jwt: string | undefined): Promise<string | null> {
  if (!jwt || !accessConfigured()) return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  let header: any, claims: any;
  try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { return null; }
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  const key = await keyFor(header.kid);
  if (!key) return null;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) return null;
  const nowSec = Date.now() / 1000;
  const skew = 60;
  if (claims.iss !== env.cfAccessTeamDomain) return null;
  const aud: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => typeof a === 'string' && env.cfAccessAud.includes(a))) return null;
  if (typeof claims.exp !== 'number' || claims.exp < nowSec - skew) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > nowSec + skew) return null;
  if (typeof claims.email !== 'string' || !claims.email.includes('@')) return null;
  return claims.email.trim().toLowerCase();
}
