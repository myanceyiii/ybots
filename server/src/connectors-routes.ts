import { Hono } from 'hono';
import { requireUser, type AuthVars } from './lib/auth.js';
import { isOwner } from './plugins/owner.js';
import { env } from './env.js';
import { createCustom, deleteCustom, finishSignIn, restartSignIn } from './connectors-custom.js';
import { audienceUrl, finishGoogle, googleBase, googleClient, redirectUri, saveClient, startGoogle } from './google-accounts.js';
import { webSearchStatus } from './web-search.js';
import { AdminError, history as adminHistory, undoAsPerson } from './connector-admin.js';
import { botRows, cancelConnector, confirmConnector, ConnectorError, lastScan, listConnectors, proposeConnector, scanNow } from './connectors.js';

/**
 * /api/connectors: the Connectors list in every app (web, Windows, Android). Reading needs the
 * signed-in session; scanning and adding need the owner, and adding goes propose -> confirm.
 */
export const connectorsApi = new Hono<AuthVars>();

/**
 * Where a server's sign-in page sends the browser back. It runs without the Cleft session (the
 * browser that signs in may not have one, as on a phone); the one-time state from the sign-in start
 * is what ties it to the owner's request.
 */
export const connectorsOAuth = new Hono();
const page = (title: string, text: string, ok: boolean) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 16px;color:#222;background:#fff}h1{font-size:20px}p{color:${ok ? '#444' : '#b00020'}}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:${ok ? '#bbb' : '#ff6b81'}}}</style></head>
<body><h1>${title}</h1><p>${text}</p></body></html>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
connectorsOAuth.get('/callback', async (c) => {
  try {
    const name = await finishSignIn({ code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error') });
    return c.html(page('Signed in', `${esc(name)} is connected to YBots. Go back to Connectors and add it to your Bots. You can close this tab.`, true));
  } catch (e) {
    return c.html(page("Couldn't sign in", esc((e as Error).message), false), 400);
  }
});

/** Where Google's sign-in page sends the browser back (registered on the Web client; no session needed). */
export const connectorsGoogleCallback = new Hono();
connectorsGoogleCallback.get('/', async (c) => {
  try {
    const email = await finishGoogle({ code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error') });
    return c.html(page('Google account connected', `${esc(email)} is connected to YBots. Go back to Connectors and add it to a Bot. You can close this tab.`, true));
  } catch (e) {
    return c.html(page("Couldn't connect Google", esc((e as Error).message), false), 400);
  }
});

connectorsApi.use('*', requireUser);
connectorsApi.use('*', async (c, next) => {
  if (c.get('agent') && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    return c.json({ error: 'Only a person can change connections from the app.' }, 403);
  }
  return next();
});

/** Google accounts: whether sign-in is set up, the client upload (owner, a person), and the start. */
connectorsApi.get('/google', (c) => c.json({ configured: !!googleClient(), audienceUrl: audienceUrl(), redirectUri: redirectUri(googleBase([env.appUrl, ...env.extraOrigins])) }));
connectorsApi.post('/google/client', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { saveClient(c.get('user').id, c.get('agent'), body?.json); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
});
connectorsApi.post('/google/start', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(startGoogle(c.get('user').id, c.get('agent'), body?.write === true, googleBase([env.appUrl, ...env.extraOrigins]))); } catch (e) { return fail(c, e); }
});

/** The address a sign-in comes back to: the one the app is using, if it is one of this server's own. */
const originFor = (given: unknown) => {
  const mine = [env.appUrl, ...env.extraOrigins].map((u) => { try { return new URL(u).origin; } catch { return ''; } }).filter(Boolean);
  try { const o = new URL(String(given)).origin; if (mine.includes(o)) return o; } catch { /* not given */ }
  return mine[0] ?? env.appUrl;
};

connectorsApi.post('/custom', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await createCustom(c.get('user').id, body, originFor(body?.returnTo))); } catch (e) { return fail(c, e); }
});

connectorsApi.post('/custom/:id/signin', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await restartSignIn(c.get('user').id, c.req.param('id'), originFor(body?.returnTo))); } catch (e) { return fail(c, e); }
});

connectorsApi.post('/custom/:id/delete', async (c) => {
  try { await deleteCustom(c.get('user').id, c.req.param('id')); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
});

const fail = (c: any, e: unknown) => {
  if (e instanceof ConnectorError) return c.json({ error: e.message }, e.status);
  throw e;
};

connectorsApi.get('/', async (c) => {
  const owner = isOwner(c.get('user').id);
  const list = await listConnectors();
  return c.json({ owner, scanHosts: (process.env.CONNECTOR_SCAN_HOSTS ?? '').split(/[\s,]+/).filter(Boolean).length, lastScan: lastScan(), bots: owner ? botRows() : [], connectors: list });
});

/** Web search by API (web-search.ts): the service, whether its key is set, and each bot's use this month. Never the key. */
connectorsApi.get('/web-search', (c) => {
  const id = c.get('user').id;
  return c.json(webSearchStatus(id, isOwner(id)));
});

connectorsApi.post('/scan', async (c) => {
  if (!isOwner(c.get('user').id)) return c.json({ error: 'Only the owner of this server can scan for connectors.' }, 403);
  return c.json(await scanNow());
});

connectorsApi.post('/changes', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(proposeConnector(c.get('user').id, body)); } catch (e) { return fail(c, e); }
});

connectorsApi.post('/changes/:id/confirm', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(confirmConnector(c.get('user').id, c.req.param('id'), body?.digest)); } catch (e) { return fail(c, e); }
});

connectorsApi.post('/changes/:id/cancel', (c) => {
  try { return c.json(cancelConnector(c.get('user').id, c.req.param('id'))); } catch (e) { return fail(c, e); }
});

/** Changes the admin bot made to connected apps (connector-admin.ts), newest first, with Undo for the owner. */
connectorsApi.get('/admin-changes', (c) => {
  if (!isOwner(c.get('user').id)) return c.json({ changes: [] });
  return c.json({ changes: adminHistory(30) });
});

connectorsApi.post('/admin-changes/:id/undo', async (c) => {
  if (!isOwner(c.get('user').id)) return c.json({ error: 'Only the owner of this server can undo changes.' }, 403);
  // Same reading as the approval route (routes.ts): a bearer sign-in is the phone app.
  const via = c.get('client') === 'bearer' ? 'phone app' : /Electron|CleftBot/i.test(c.req.header('user-agent') ?? '') ? 'Windows app' : 'web';
  try { return c.json(await undoAsPerson(c.get('user').id, c.req.param('id'), `Undo in the ${via}`)); } catch (e) {
    if (e instanceof AdminError) return c.json({ error: e.message }, 409);
    throw e;
  }
});
