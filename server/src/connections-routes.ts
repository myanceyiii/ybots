import { Hono } from 'hono';
import { requireUser, type AuthVars } from './lib/auth.js';
import { env } from './env.js';
import { googleBase } from './google-accounts.js';
import { cancel, confirm, ConnectionError, connectionsFor, propose, reconnect, setToolRule, type ToolRule } from './connections.js';

/**
 * /api/connections: Settings › Connections in every app (web, Windows, Android), worded by the server
 * (connections.ts) so they all say the same. Reading needs the signed-in session; changes need the
 * owner, signed in as a person (a program signed in to the account cannot), and go propose -> confirm
 * with the digest shown, except Reconnect (a sign-in page the person finishes) and the per-tool
 * choice (applied at once with Undo, like the per-bot switches in /api/plugins/switch).
 */
export const connectionsApi = new Hono<AuthVars>();
connectionsApi.use('*', requireUser);
connectionsApi.use('*', async (c, next) => {
  if (c.get('agent') && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return c.json({ error: 'Only a person can change connections, from the app.' }, 403);
  return next();
});

const fail = (c: any, e: unknown) => {
  if (e instanceof ConnectionError) return c.json({ error: e.message }, e.status);
  if (e && typeof e === 'object' && 'status' in e && typeof (e as any).status === 'number' && (e as any).status < 500) return c.json({ error: (e as any).message }, (e as any).status);
  throw e;
};
/** Where the request came from, for the change log: a bearer sign-in is the phone app. */
const via = (c: any) => (c.get('client') === 'bearer' ? 'phone app' : /Electron|CleftBot|YBots/i.test(c.req.header('user-agent') ?? '') ? 'Windows app' : 'web');
const originFor = (given: unknown) => {
  const mine = [env.appUrl, ...env.extraOrigins].map((u) => { try { return new URL(u).origin; } catch { return ''; } }).filter(Boolean);
  try { const o = new URL(String(given)).origin; if (mine.includes(o)) return o; } catch { /* not given */ }
  return mine[0] ?? env.appUrl;
};
const base = () => googleBase([env.appUrl, ...env.extraOrigins]);

connectionsApi.get('/', async (c) => c.json(await connectionsFor(c.get('user').id)));

connectionsApi.post('/:id/reconnect', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(await reconnect(c.get('user').id, c.get('agent'), c.req.param('id'), { write: typeof body?.write === 'boolean' ? body.write : undefined, base: base(), origin: originFor(body?.returnTo) }));
  } catch (e) { return fail(c, e); }
});

connectionsApi.put('/:id/tools/:tool', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rule = body?.rule === null ? null : (String(body?.rule ?? '') as ToolRule);
  try { return c.json({ tool: setToolRule(c.get('user').id, c.req.param('id'), c.req.param('tool'), rule) }); } catch (e) { return fail(c, e); }
});

connectionsApi.post('/:id/changes', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(propose(c.get('user').id, c.req.param('id'), String(body?.action ?? ''))); } catch (e) { return fail(c, e); }
});

connectionsApi.post('/changes/:cid/confirm', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await confirm(c.get('user').id, c.get('agent'), c.req.param('cid'), body?.digest, { via: `Connections in the ${via(c)}`, base: base() })); } catch (e) { return fail(c, e); }
});

connectionsApi.post('/changes/:cid/cancel', (c) => {
  try { return c.json(cancel(c.get('user').id, c.req.param('cid'))); } catch (e) { return fail(c, e); }
});
