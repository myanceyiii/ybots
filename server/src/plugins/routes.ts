import { Hono } from 'hono';
import { db } from '../db.js';
import { requireUser, type AuthVars } from '../lib/auth.js';
import { appsStatus } from '../local-apps.js';
import { isOwner } from './owner.js';
import { flipSwitch, PluginError, pluginOverview } from './registry.js';
import { cancelChange, changeAction, confirmChange, pendingChanges, proposeChange } from './changes.js';
import { createPluginRequest, dismissPlan, markPluginDeleted, draftFiles, draftsFor, installDraft, startBuild, undoDraft } from './builder.js';
import { appendRow } from '../store.js';
import { isOutside } from '../outside.js';
import { enqueue } from '../agent/loop.js';
import { installedPlugin, installedPlugins, pluginHistory, pluginSettings, savePluginSettings } from './store.js';
import { publicValues, validateSettingValues } from './ui-schema.js';
import { audit } from './registry.js';

/**
 * /api/plugins: the Plugins page in every app (web, Windows, Android). Every route needs the
 * signed-in session; changes need the owner and go through propose -> confirm (changes.ts).
 */
export const pluginsApi = new Hono<AuthVars>();
pluginsApi.use('*', requireUser);

const PERSON_ONLY = 'Only you can do this, from the app. A program signed in to your account cannot.';
pluginsApi.use('*', async (c, next) => {
  if (c.get('agent') && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return c.json({ error: PERSON_ONLY }, 403);
  return next();
});

const fail = (c: any, e: unknown) => {
  if (e instanceof PluginError) return c.json({ error: e.message }, e.status);
  throw e;
};

pluginsApi.get('/', async (c) => {
  const u = c.get('user');
  const status = new Map((await appsStatus()).apps.map((a) => [a.id, a]));
  const installed = new Map(installedPlugins().map((p) => [p.id, p]));
  const owner = isOwner(u.id);
  // The owner manages every bot on the server (each shown with whose it is); anyone else sees their own.
  const people = new Map((db.prepare('SELECT id, name, email FROM users').all() as { id: string; name: string | null; email: string }[]).map((x) => [x.id, x.name || x.email]));
  return c.json({
    owner,
    plugins: pluginOverview().map((o) => {
      const p = { ...o, bots: o.bots.filter((b) => owner || b.userId === u.id).map(({ userId, ...b }) => ({ ...b, ...(userId !== u.id ? { ownerName: people.get(userId) ?? 'someone else' } : {}) })) };
      const s = status.get(p.id);
      const i = installed.get(p.id);
      return {
        ...p,
        status: s?.status ?? 'stopped', error: s?.error, tools: s?.tools ?? 0, readOnly: s?.readOnly ?? false, reads: s?.reads ?? 0, blocked: s?.blocked ?? 0, version: s?.version, digest: s?.digest,
        network: i?.manifest.network ?? [], description: s?.description,
        settings: i?.manifest.settings ?? [], values: i ? publicValues(i.manifest.settings ?? [], pluginSettings(i.id)) : {},
        history: i ? pluginHistory(p.id).map((h) => ({ version: h.version, digest: h.digest, status: h.status, installedAt: h.installedAt })) : [],
      };
    }),
    pending: pendingChanges(u.id),
    drafts: owner ? draftsFor(u.id) : [],
  });
});

const VIA: Record<string, string> = { cookie: 'web or Windows app', bearer: 'phone app' };

/**
 * The owner flips a plugin for one bot. No confirm step: the person pressing the switch is the
 * approver, and the apps show an Undo. `enabled: null` puts the bot back on the plugin's default.
 * Bots never reach /api (their /mcp tokens are refused), and agent sessions are refused here.
 */
pluginsApi.post('/switch', async (c) => {
  const u = c.get('user');
  if (!isOwner(u.id)) return c.json({ error: 'Only the owner of this server can change plugins.' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const enabled = body?.enabled === null ? null : typeof body?.enabled === 'boolean' ? body.enabled : undefined;
  if (enabled === undefined) return c.json({ error: 'Say whether to switch it on or off.' }, 400);
  try { return c.json(flipSwitch(u.id, String(body?.pluginId ?? ''), String(body?.botId ?? ''), enabled, VIA[c.get('client')] ?? 'app')); } catch (e) { return fail(c, e); }
});

pluginsApi.post('/changes', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(proposeChange(c.get('user').id, body)); } catch (e) { return fail(c, e); }
});

pluginsApi.post('/changes/:id/confirm', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const action = changeAction(c.req.param('id'));
  try {
    const done = confirmChange(c.get('user').id, c.req.param('id'), body?.digest);
    if (action === 'delete' && done.status === 'applied') markPluginDeleted(String((done.result as any)?.deleted ?? ''));
    return c.json(done);
  } catch (e) { return fail(c, e); }
});

pluginsApi.post('/changes/:id/cancel', (c) => {
  try { return c.json(cancelChange(c.get('user').id, c.req.param('id'))); } catch (e) { return fail(c, e); }
});

/** The owner saves a plugin's settings form. The plugin restarts with the new values. */
pluginsApi.put('/:id/settings', async (c) => {
  const u = c.get('user');
  if (!isOwner(u.id)) return c.json({ error: 'Only the owner of this server can change plugins.' }, 403);
  const p = installedPlugin(c.req.param('id'));
  if (!p) return c.json({ error: 'No such installed plugin.' }, 404);
  const spec = p.manifest.settings ?? [];
  const v = validateSettingValues(spec, await c.req.json().catch(() => null), pluginSettings(p.id));
  if (!v.ok) return c.json({ error: v.error }, 400);
  savePluginSettings(p.id, v.value, u.id);
  audit(u.id, 'settings', p.id, null, { keys: Object.keys(v.value) });
  return c.json({ values: publicValues(spec, pluginSettings(p.id)) });
});

// ---------- plugins made with a bot (builder.ts) ----------

/**
 * Create plugin: the owner's request goes to the picked bot as the owner's own chat message, and the
 * bot answers with a plan card. The apps then open that chat.
 */
pluginsApi.post('/create', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    if (isOutside(String(body?.botId ?? ''))) return c.json({ error: 'Bots outside the app (through Slack) cannot make plugins here.' }, 400);
    const r = createPluginRequest(c.get('user').id, String(body?.botId ?? ''), body?.idea);
    const row = appendRow(r.botId, 'message', { type: 'message', role: 'user', text: r.text });
    enqueue(r.botId, { type: 'user', text: r.text });
    return c.json({ botId: r.botId, row });
  } catch (e) { return fail(c, e); }
});

/** The draft's files, for the owner's code review before Install. */
pluginsApi.get('/drafts/:id/files', (c) => {
  try { return c.json(draftFiles(c.get('user').id, c.req.param('id'))); } catch (e) { return fail(c, e); }
});

/** The owner's Build on a plan card: authorizes building that plan, and tells the bot to go ahead. */
pluginsApi.post('/drafts/:id/build', (c) => {
  try {
    const { botId, notice } = startBuild(c.get('user').id, c.req.param('id'));
    enqueue(botId, { type: 'system', text: notice });
    return c.json({ ok: true });
  } catch (e) { return fail(c, e); }
});

pluginsApi.post('/drafts/:id/dismiss', (c) => {
  try { dismissPlan(c.get('user').id, c.req.param('id')); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
});

/** The owner's Install on a review card, with the fingerprint the card showed. */
pluginsApi.post('/drafts/:id/install', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json(installDraft(c.get('user').id, c.req.param('id'), String(body?.digest ?? ''), Array.isArray(body?.bots) ? body.bots.map(String) : []));
  } catch (e) { return fail(c, e); }
});

pluginsApi.post('/drafts/:id/undo', (c) => {
  try { undoDraft(c.get('user').id, c.req.param('id')); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
});
