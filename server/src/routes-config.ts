import { Hono } from 'hono';
import { db, now } from './db.js';
import './db-config.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { currentSession, displayName, requireUser, type AuthVars } from './lib/auth.js';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { env } from './env.js';
import { libraryRoot } from './paths.js';
import { describe, insideFile, mimeFor, pagePng, previewOf, safeRel, saveText } from './files.js';
import { listShelf, notePageOrigin, restoreFromTrash, setPinned, shelfInfo, trashPage } from './page-shelf.js';
import { applyOps, createPage, EXPORT_FORMATS, exportPage, history, isPagePath, loadPage, restore, undoLast, versionOf, type ExportFormat } from './pages.js';
import { chatOwner, emitBot, getBotRow, getLive, listRoutines, listTasks } from './store.js';
import { computerState, readyScreen, resetBotScreen } from './computer.js';
import { checkPaste, ClipboardError, readBotClipboard, writeBotClipboard } from './clipboard.js';
import { box } from './box.js';
import { orgo } from './orgo.js';
import { openTerminal } from './desk.js';
import { engineHome, engineInfo, engineKind, forgetEngineOptions, restartEngine, stopOwnScreen, syncEngineModel, syncEngineProviders, syncPrimaryEngine } from './engine.js';
import { cleanFallbacks, SUBSCRIPTION } from './provider-catalog.js';
import { checkProvider, CheckError, knownProvider } from './provider-runtime.js';
import { isSilo } from './silo.js';
import { listMemories } from './engine-memory.js';
import { cleanTiers } from './model-router.js';
import { usageSummary } from './model-choice.js';
import { cleanHelpers, helperModels, helperRuns, HelpersError, loadHelpers, readHelpers, saveHelpers } from './helpers.js';
import { isOwner } from './plugins/owner.js';
import YAML from 'yaml';
import { idleConfig, viewerCount } from './idle.js';
import type { ChatFileEntry, HermesSkillList, LibraryFile, Skill } from './types.js';
import { createHermesSkill, deleteHermesSkill, listHermesSkills, markAllSkillsSeen, saveHermesSkill, setHermesSkillEnabled, SkillsError, skillsTarget, viewHermesSkill } from './engine-skills.js';

/**
 * Bot settings, skills, library, computer controls and memory maintenance.
 * Mounted next to routes.ts in index.ts; every path here needs a signed-in user.
 */
export const configApi = new Hono<AuthVars>();

for (const p of ['/bots/*', '/skills/*', '/computer/*']) configApi.use(p, requireUser);

const ownBot = (userId: string, id: string) => {
  const b = getBotRow(id);
  return b && b.user_id === userId ? b : null;
};

const toSkill = (s: any): Skill => ({ id: s.id, botId: s.bot_id, name: s.name, description: s.description ?? '', body: s.body, createdAt: s.created_at, updatedAt: s.updated_at ?? s.created_at });
const listSkills = (botId: string) => (db.prepare('SELECT * FROM skills WHERE bot_id=? ORDER BY created_at ASC').all(botId) as any[]).map(toSkill);

// ---------- settings bundle ----------

configApi.get('/bots/:id/settings', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({
    memories: listMemories(b.id),
    skills: listSkills(b.id),
    routines: listRoutines(b.id),
    tasks: listTasks(b.id),
    // The agent keeps its own memory and trims its own context; there is nothing for the app to maintain.
    memory: { lastConsolidatedAt: null, historyChars: 0, compactAtChars: 0, lastCompaction: null },
  });
});

// ---------- skills ----------

function cleanSkill(p: any, partial = false): { name?: string; description?: string; body?: string } | string {
  const out: { name?: string; description?: string; body?: string } = {};
  if (p.name !== undefined || !partial) {
    const name = String(p.name ?? '').trim();
    if (!name) return 'Give the skill a name';
    out.name = name.slice(0, 80);
  }
  if (p.body !== undefined || !partial) {
    const body = String(p.body ?? '').trim();
    if (!body) return 'Write the steps for this skill';
    out.body = body.slice(0, 20_000);
  }
  if (p.description !== undefined) out.description = String(p.description).trim().slice(0, 300);
  return out;
}

configApi.get('/bots/:id/skills', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ skills: listSkills(b.id) }) : c.json({ error: 'not found' }, 404);
});

configApi.post('/bots/:id/skills', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await c.req.json().catch(() => ({})));
  if (typeof s === 'string') return c.json({ error: s }, 400);
  const id = newId('skl');
  db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, b.id, s.name, s.body, s.description ?? '', now(), now());
  return c.json({ skill: toSkill(db.prepare('SELECT * FROM skills WHERE id=?').get(id)) });
});

const ownSkill = (userId: string, id: string) =>
  db.prepare('SELECT s.* FROM skills s JOIN bots b ON b.id=s.bot_id WHERE s.id=? AND b.user_id=?').get(id, userId) as any;

configApi.patch('/skills/:id', async (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  const s = cleanSkill(await c.req.json().catch(() => ({})), true);
  if (typeof s === 'string') return c.json({ error: s }, 400);
  db.prepare('UPDATE skills SET name=?, body=?, description=?, updated_at=? WHERE id=?').run(s.name ?? cur.name, s.body ?? cur.body, s.description ?? cur.description ?? '', now(), cur.id);
  return c.json({ skill: toSkill(db.prepare('SELECT * FROM skills WHERE id=?').get(cur.id)) });
});

configApi.delete('/skills/:id', (c) => {
  const cur = ownSkill(c.get('user').id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  db.prepare('DELETE FROM skills WHERE id=?').run(cur.id);
  return c.json({ ok: true });
});

// ---------- the bot's own Hermes skills (engine-skills.ts) ----------
// Alex's own action from the signed-in app (like Hermes' dashboard), so no approval card. Bots'
// skills are shared by everyone who uses the same account.

function skillsFail(c: any, e: any) {
  if (e instanceof SkillsError) return c.json({ error: e.message }, e.status);
  return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 500);
}

const hermesSkillsFor = (c: any) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return { error: c.json({ error: 'not found' }, 404) };
  if (b.kind === 'room') return { error: c.json({ error: 'A group has no agent skills of its own.' }, 409) };
  const t = skillsTarget(b.id);
  if ('reason' in t) return { error: c.json({ error: t.reason }, 409), reason: t.reason, bot: b };
  return { t, bot: b, user };
};

configApi.get('/bots/:id/hermes-skills', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const t = b.kind === 'room' ? { reason: 'A group has no agent skills of its own.' } : skillsTarget(b.id);
  if ('reason' in t) return c.json({ available: false, reason: t.reason, skills: [] } satisfies HermesSkillList);
  try {
    return c.json({
      available: true, skills: await listHermesSkills(t, c.req.query('fresh') === '1'),
      autoSave: !!b.auto_save_skills, canChangeAutoSave: isOwner(c.get('user').id),
    } satisfies HermesSkillList);
  } catch (e) { return skillsFail(c, e); }
});

configApi.get('/bots/:id/hermes-skills/:name', async (c) => {
  const r = hermesSkillsFor(c);
  if (r.error) return r.error;
  try { return c.json({ skill: await viewHermesSkill(r.t!, c.req.param('name')) }); } catch (e) { return skillsFail(c, e); }
});

configApi.post('/bots/:id/hermes-skills', async (c) => {
  const r = hermesSkillsFor(c);
  if (r.error) return r.error;
  const p = await c.req.json().catch(() => ({} as any));
  try {
    const skill = await createHermesSkill(r.t!, { name: String(p.name ?? ''), category: p.category ? String(p.category) : undefined, description: String(p.description ?? ''), body: String(p.body ?? '') });
    console.log(`[skills] ${r.user.id} created ${r.bot.name}'s Hermes skill ${skill.name}`);
    return c.json({ skill });
  } catch (e) { return skillsFail(c, e); }
});

/**
 * The owner's switch: let this bot save (create and improve) its own Hermes skills without an approval
 * card. Alex chose this on 2026-11-22. Only the owner, from the signed-in app; no bot tool reaches it.
 * Registered before the /:name routes so 'auto-save' is never read as a skill name.
 */
configApi.put('/bots/:id/hermes-skills/auto-save', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (!isOwner(user.id)) return c.json({ error: 'Only the owner of this server can change this.' }, 403);
  if (c.get('agent')) return c.json({ error: 'Only a person can change the skill approval setting.' }, 403);
  if (b.kind === 'room' || isSilo(b.id)) return c.json({ error: 'This bot has no agent skills here.' }, 409);
  const { on } = await c.req.json<{ on?: boolean }>().catch(() => ({} as { on?: boolean }));
  db.prepare('UPDATE bots SET auto_save_skills=? WHERE id=?').run(on === true ? 1 : 0, b.id);
  console.log(`[skills] ${user.id} turned ${on === true ? 'on' : 'off'} auto-save of ${b.name}'s own skills`);
  return c.json({ ok: true, autoSave: on === true });
});

configApi.put('/bots/:id/hermes-skills/:name', async (c) => {
  const r = hermesSkillsFor(c);
  if (r.error) return r.error;
  const p = await c.req.json().catch(() => ({} as any));
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  try {
    const skill = await saveHermesSkill(r.t!, c.req.param('name'), { content: str(p.content), description: str(p.description), body: str(p.body) });
    console.log(`[skills] ${r.user.id} edited ${r.bot.name}'s Hermes skill ${skill.name}`);
    return c.json({ skill });
  } catch (e) { return skillsFail(c, e); }
});

configApi.put('/bots/:id/hermes-skills/:name/enabled', async (c) => {
  const r = hermesSkillsFor(c);
  if (r.error) return r.error;
  const p = await c.req.json().catch(() => ({} as any));
  try {
    await setHermesSkillEnabled(r.t!, c.req.param('name'), p.enabled === true);
    console.log(`[skills] ${r.user.id} turned ${p.enabled === true ? 'on' : 'off'} ${r.bot.name}'s Hermes skill ${c.req.param('name')}`);
    return c.json({ ok: true, enabled: p.enabled === true });
  } catch (e) { return skillsFail(c, e); }
});

configApi.delete('/bots/:id/hermes-skills/:name', async (c) => {
  const r = hermesSkillsFor(c);
  if (r.error) return r.error;
  try {
    await deleteHermesSkill(r.t!, c.req.param('name'));
    console.log(`[skills] ${r.user.id} deleted ${r.bot.name}'s Hermes skill ${c.req.param('name')}`);
    return c.json({ ok: true });
  } catch (e) { return skillsFail(c, e); }
});

/** Clear the New marker on every skill of this bot. */
configApi.post('/bots/:id/hermes-skills/seen', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  markAllSkillsSeen(b.id);
  return c.json({ ok: true });
});

/** Move an app-only skill into the bot's Hermes skills, then remove the app copy. */
configApi.post('/skills/:id/to-hermes', async (c) => {
  const user = c.get('user');
  const cur = ownSkill(user.id, c.req.param('id'));
  if (!cur) return c.json({ error: 'not found' }, 404);
  const t = skillsTarget(cur.bot_id);
  if ('reason' in t) return c.json({ error: t.reason }, 409);
  try {
    const skill = await createHermesSkill(t, { name: cur.name, description: cur.description || `Use for ${cur.name}.`, body: cur.body });
    db.prepare('DELETE FROM skills WHERE id=?').run(cur.id);
    console.log(`[skills] ${user.id} moved app skill ${cur.id} into Hermes as ${skill.name}`);
    return c.json({ skill });
  } catch (e) { return skillsFail(c, e); }
});

// ---------- memory maintenance (now the agent's own job; kept so older clients get an answer) ----------

configApi.post('/bots/:id/memories/consolidate', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ added: [], skipped: 0, considered: 0 });
});

configApi.post('/bots/:id/compact', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ itemsBefore: 0, itemsAfter: 0, compacted: false });
});

// ---------- the agent behind a bot: model, sign-in, restart ----------

configApi.get('/bots/:id/engine', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ engine: await engineInfo(b.id) });
});

/**
 * Which model this bot's turns ask for. Empty provider/model go back to the agent's own default.
 * modelMode 'auto' picks one of modelTiers per turn (model-router.ts) and needs a provider, because
 * Hermes only honours a per-request model that comes with a provider unless its API server opts in to
 * bare model names. providerLock pins the bot to one provider; every change is checked against it.
 */
configApi.patch('/bots/:id/engine', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  type Body = { provider?: string | null; model?: string | null; modelMode?: string; modelTiers?: unknown; providerLock?: string | null;
    fallbacks?: unknown; allowSubscription?: boolean; acknowledgeSubscriptionTerms?: boolean };
  const p = await c.req.json<Body>().catch(() => ({} as Body));
  const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);
  const row = getBotRow(b.id);
  const next = {
    provider: p.provider !== undefined ? clean(p.provider) : row.provider ?? null,
    model: p.model !== undefined ? clean(p.model) : row.model ?? null,
    mode: p.modelMode !== undefined ? p.modelMode : row.model_mode ?? 'manual',
    tiers: p.modelTiers !== undefined ? cleanTiers(p.modelTiers) : cleanTiers(row.model_tiers),
    lock: p.providerLock !== undefined ? clean(p.providerLock) : row.provider_lock ?? null,
  };
  if (next.mode !== 'manual' && next.mode !== 'auto') return c.json({ error: 'modelMode must be manual or auto' }, 400);
  if (next.provider && !/^[a-z0-9][a-z0-9._-]{0,60}$/.test(next.provider)) return c.json({ error: 'bad provider' }, 400);
  if (next.lock && !/^[a-z0-9][a-z0-9._-]{0,60}$/.test(next.lock)) return c.json({ error: 'bad providerLock' }, 400);
  if (next.lock && next.provider !== next.lock) return c.json({ error: `This bot is locked to ${next.lock}. Pick that provider, or remove the lock first.` }, 400);
  if (next.mode === 'auto' && !next.provider) return c.json({ error: 'Auto needs a provider: pick one first.' }, 400);
  if (next.mode === 'auto' && !next.tiers && !next.model) return c.json({ error: 'Auto needs at least one tier model (or a manual model to fall back on).' }, 400);

  // The shared provider catalog (provider-catalog.ts): fallbacks and the Claude subscription opt-in are
  // the app's settings for bots it runs; another agent's setup (the owner's own, a container) is not changed.
  // The owner's own agent (primary) is configurable too: its home is written with a backup and an audit
  // line, and it restarts only when idle (primary-providers.ts). A siloed agent's setup is its container's.
  const kind = engineKind(b.id);
  const managed = kind === 'managed' || kind === 'primary';
  let subscription = !!row.claude_subscription;
  if (p.allowSubscription !== undefined) {
    if (!managed) return c.json({ error: `The Claude subscription route is only offered for bots whose agent this app can set up.` }, 409);
    if (!isOwner(c.get('user').id)) return c.json({ error: 'Only the owner of this server can switch the Claude subscription route on or off.' }, 403);
    if (p.allowSubscription && !p.acknowledgeSubscriptionTerms) return c.json({ error: 'Read and accept the warning about the Claude subscription route first.' }, 400);
    subscription = !!p.allowSubscription;
  }
  let fallbacks: { provider: string; model: string }[] | undefined;
  if (p.fallbacks !== undefined) {
    if (!managed) return c.json({ error: `${b.name}'s fallbacks are set in its own agent, not from the app.` }, 409);
    try { fallbacks = cleanFallbacks(p.fallbacks); } catch (e: any) { return c.json({ error: e.message }, 400); }
    if (fallbacks.some((f) => f.provider === next.provider && f.model === next.model)) return c.json({ error: 'A fallback cannot be the same provider and model as the default.' }, 400);
  }
  const usesSub = next.provider === SUBSCRIPTION
    || (fallbacks ?? JSON.parse(row.fallbacks ?? '[]')).some((f: any) => f?.provider === SUBSCRIPTION);
  if (usesSub && !subscription) {
    return c.json({ error: p.allowSubscription === false
      ? `${b.name} still uses the Claude subscription as its default or a fallback. Pick another provider there first.`
      : `The Claude subscription route is switched off for ${b.name}. Switch it on under Providers first.` }, 409);
  }

  // A person chose here, so the one-time Auto tier setup for new bots (engine.ts seedTiers) is done.
  db.prepare('UPDATE bots SET provider=?, model=?, model_mode=?, model_tiers=?, provider_lock=?, claude_subscription=?, tiers_seed=0, updated_at=? WHERE id=?')
    .run(next.provider, next.model, next.mode, next.tiers ? JSON.stringify(next.tiers) : null, next.lock, subscription ? 1 : 0, now(), b.id);
  if (fallbacks) db.prepare('UPDATE bots SET fallbacks=? WHERE id=?').run(JSON.stringify(fallbacks), b.id);
  if (p.allowSubscription !== undefined && subscription !== !!row.claude_subscription) {
    console.log(`[providers] ${c.get('user').id} switched the Claude subscription route ${subscription ? 'ON' : 'off'} for ${b.name}`);
  }
  // Hermes falls back to its config's provider before it reads the one a turn asks for, so the
  // choice goes into the bot's own config too; a new provider needs the agent restarted, which waits
  // for a running turn to finish. Fallbacks need no restart; the subscription switch does.
  if (kind === 'primary') {
    const modelChanged = (p.provider !== undefined || p.model !== undefined) && (next.provider !== (row.provider ?? null) || next.model !== (row.model ?? null));
    try {
      const r = syncPrimaryEngine(b.id, { model: modelChanged, actor: c.get('user').id });
      emitBot(b.id);
      return c.json({ engine: await engineInfo(b.id), notes: r?.notes ?? [] });
    } catch (e: any) {
      emitBot(b.id);
      return c.json({ error: `Saved in the app, but ${b.name}'s agent setup was not changed: ${String(e?.message ?? e).slice(0, 200)}` }, 500);
    }
  }
  const synced = syncEngineModel(b.id);
  const prov = syncEngineProviders(b.id);
  if (synced.providerChanged || prov.restart) restartWhenIdle(b.id);
  emitBot(b.id);
  return c.json({ engine: await engineInfo(b.id) });
});

/**
 * One real request from the bot's own agent to a provider and model, with every tool refused and nothing
 * stored, so settings can show it as verified (or the error it gave). Costs one tiny request.
 */
configApi.post('/bots/:id/engine/check', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { provider, model } = await c.req.json<{ provider?: string; model?: string }>().catch(() => ({} as { provider?: string; model?: string }));
  if (typeof provider !== 'string' || !/^[a-z0-9][a-z0-9:._-]{0,60}$/.test(provider)) return c.json({ error: 'bad provider' }, 400);
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,119}$/.test(model)) return c.json({ error: 'Pick a model to check.' }, 400);
  const info = await engineInfo(b.id);
  if (!knownProvider(provider, info.providers)) return c.json({ error: `${provider} is not a provider this bot knows.` }, 400);
  try {
    const result = await checkProvider(getBotRow(b.id), provider, model);
    return c.json({ result, engine: await engineInfo(b.id) });
  } catch (e: any) {
    if (e instanceof CheckError) return c.json({ error: e.message }, e.status);
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

/** Restart a bot's agent once it is not in the middle of a turn (checked every 5 s for up to 30 min). */
function restartWhenIdle(botId: string, tries = 0) {
  if (getLive(botId).isRunning && tries < 360) { setTimeout(() => restartWhenIdle(botId, tries + 1), 5000); return; }
  restartEngine(botId).catch((e) => console.warn(`[engine] restart after model change failed for ${botId}: ${e?.message ?? e}`));
}

/** Turns per tier and model, with token counts Hermes reported, for the last `days` days (1–90). */
configApi.get('/bots/:id/engine/usage', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const days = Math.min(90, Math.max(1, Number(c.req.query('days')) || 7));
  return c.json({ usage: usageSummary(b.id, days) });
});

// ---------- helpers: the sub-agents a bot's Hermes may start (helpers.ts, docs/helpers.md) ----------

/** Where a bot's helper settings live, and the provider its helpers must use. */
function helperTarget(b: any): { home: string; provider: string | null } | { error: string; status: 404 | 409 } {
  if (isSilo(b.id)) return { error: `${b.name}'s agent runs in its own container; its helpers are set there, not from the app.`, status: 409 };
  const home = engineHome(b.id);
  if (!home || !fs.existsSync(`${home}/config.yaml`)) return { error: `${b.name} is not set up on this server yet, so there are no helper settings to change.`, status: 409 };
  let provider: string | null = b.provider ?? null;
  if (!provider) {
    try { provider = (YAML.parse(fs.readFileSync(`${home}/config.yaml`, 'utf8'))?.model?.provider as string) || null; } catch { /* unreadable: no provider */ }
  }
  return { home, provider };
}

/** The bot's own models that its Hermes lists: the only models its helpers may use (helperModels). */
async function allowedHelperModels(b: any, t: { home: string; provider: string | null }): Promise<string[]> {
  const info = await engineInfo(b.id).catch(() => null);
  const listed = info?.providers.find((p) => p.id === t.provider)?.models ?? [];
  let main: string | null = null;
  try { main = (YAML.parse(fs.readFileSync(`${t.home}/config.yaml`, 'utf8'))?.model?.default as string) || null; } catch { /* unreadable */ }
  return helperModels(b, main, listed);
}

configApi.get('/bots/:id/helpers', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const t = helperTarget(b);
  if ('error' in t) return c.json({ error: t.error }, t.status);
  const models = await allowedHelperModels(b, t);
  try {
    return c.json({ helpers: loadHelpers(t.home, t.provider), models, canEdit: isOwner(user.id), runs: helperRuns(t.home) });
  } catch (e: any) {
    return c.json({ error: `Couldn't read this bot's agent config: ${String(e?.message ?? e).slice(0, 200)}` }, 500);
  }
});

/**
 * Change a bot's helper settings. Only the server's owner, from the signed-in app: no bot tool can
 * reach this, and nothing here changes an approval rule. Writes the bot's own Hermes config.yaml.
 */
configApi.put('/bots/:id/helpers', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (!isOwner(user.id)) return c.json({ error: 'Only the owner of this server can change helper settings.' }, 403);
  const t = helperTarget(b);
  if ('error' in t) return c.json({ error: t.error }, t.status);
  if (!t.provider) return c.json({ error: 'Pick a provider for this bot first; helpers use the same one.' }, 409);
  const body = await c.req.json().catch(() => ({}));
  const models = await allowedHelperModels(b, t);
  try {
    const current = readHelpers(YAML.parse(fs.readFileSync(`${t.home}/config.yaml`, 'utf8')) ?? {});
    const next = cleanHelpers(body, models, current);
    const helpers = saveHelpers(t.home, next, t.provider);
    console.log(`[helpers] ${user.id} set ${b.name}'s helpers: ${JSON.stringify(next)}`);
    return c.json({ helpers, models, canEdit: true, runs: helperRuns(t.home) });
  } catch (e: any) {
    if (e instanceof HelpersError) return c.json({ error: e.message }, 400);
    return c.json({ error: `Couldn't change this bot's agent config: ${String(e?.message ?? e).slice(0, 200)}` }, 500);
  }
});

/**
 * Sign in to a model provider (a Claude, ChatGPT or Grok subscription, or an API key). Hermes does
 * the sign-in itself; we open its command in a terminal on the bot's screen, where the user
 * finishes it through the live view.
 */
configApi.post('/bots/:id/engine/login', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (isSilo(b.id)) return c.json({ error: `${b.name}'s agent runs in its own container. Sign in there: open its screen with Take control and use the terminal on it (hermes auth add <provider>).` }, 409);
  const home = engineHome(b.id);
  if (!home) return c.json({ error: 'This bot has no agent.' }, 409);
  // The agent's files are on the machine this server runs on; a terminal on another machine cannot reach them.
  if (!box.local) return c.json({ error: 'Sign-in opens a terminal on the computer. It works once the app runs on that computer.' }, 409);
  const { provider } = await c.req.json<{ provider?: string }>().catch(() => ({} as { provider?: string }));
  if (provider !== undefined && !/^[a-z0-9][a-z0-9._-]{0,60}$/.test(provider)) return c.json({ error: 'bad provider' }, 400);
  const hermes = `HERMES_HOME=${box.quote(home)} ${box.quote(env.hermesBin)}`;
  // The Claude subscription route has its own login (CLAUDE_LOGIN_DIR); it is not signed in per bot.
  if (provider === SUBSCRIPTION) return c.json({ error: 'The Claude subscription route uses the Claude Code login set up for the app on the server, not a sign-in per bot.' }, 409);
  // Anthropic here is the API-key route: Hermes asks for a key. Signing Hermes itself in to a Claude
  // subscription (its OAuth) is not offered from the app (provider-catalog.ts).
  const cmd = !provider ? `${hermes} model` : `${hermes} auth add ${provider}${provider === 'anthropic' ? ' --type api-key' : ''}`;
  try {
    const s = await readyScreen(user.id, b.id);
    await openTerminal(s.screenId, cmd, provider ? `Sign in: ${provider}` : 'Choose a model');
    forgetEngineOptions(b.id);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

configApi.post('/bots/:id/engine/restart', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  // The primary agent serves more than this app (its messaging runs through the same process), so it is never restarted from here.
  if (isSilo(b.id)) return c.json({ error: `${b.name}'s agent runs in its own container, which is restarted on the host, not from the app.` }, 409);
  if (engineKind(b.id) !== 'managed') return c.json({ error: `${b.name} runs on the computer's own agent, which this app does not restart.` }, 409);
  try {
    await restartEngine(b.id);
    forgetEngineOptions(b.id);
    return c.json({ engine: await engineInfo(b.id) });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

/** Stop the private screen Hermes runs for this agent, so its computer work comes back to the screen shown here. */
configApi.post('/bots/:id/engine/screen/stop', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    await stopOwnScreen(b.id);
    return c.json({ engine: await engineInfo(b.id) });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 409);
  }
});

/** The user gives the screen back after taking control; the bot is told on its next turn. */
configApi.post('/bots/:id/handback', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET handback_at=? WHERE id=?').run(now(), b.id);
  return c.json({ ok: true });
});

// ---------- library: files under <libraryRoot>/<botId> on the bot's computer (see paths.ts) ----------

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Shell that sets $d to the real path of `target` (links followed) and exits 3 unless it is `root` itself
 * or inside it. `kind` is only for readability at the call site.
 */
export function insideRootSh(root: string, target: string, _kind: 'd' | 'f'): string {
  return `r=$(realpath -e -- ${shq(root)}) && d=$(realpath -e -- ${shq(target)}) && { [ "$d" = "$r" ] || case "$d" in "$r"/*) true ;; *) false ;; esac || exit 3; }`;
}

/** Parse `ls -la --time-style=+%s` output. */
export function parseLs(out: string): LibraryFile[] {
  const files: LibraryFile[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^([-dlcbps])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    let name = m[4];
    if (m[1] === 'l') name = name.replace(/ -> .*$/, '');
    if (name === '.' || name === '..') continue;
    files.push({ name, size: Number(m[2]), modifiedAt: Number(m[3]) * 1000, isDir: m[1] === 'd' });
  }
  return files.sort((a, b) => Number(b.isDir) - Number(a.isDir) || b.modifiedAt - a.modifiedAt);
}

configApi.get('/bots/:id/files', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (rel === null) return c.json({ error: 'bad path' }, 400);
  try {
    if (!box.local && computerState(user.id).status !== 'running') return c.json({ status: 'asleep', path: rel, files: [] });
    const root = `${libraryRoot()}/${b.id}`;
    const dir = `${root}${rel ? `/${rel}` : ''}`;
    // Links are followed before listing, on the machine that holds the files, so a link inside the
    // library can never show a folder outside it.
    const r = await box.bash(`mkdir -p ${shq(root)} && ${insideRootSh(root, dir, 'd')} && ls -la --time-style=+%s -- "$d/" 2>&1`, 30);
    if (r.exit_code === 3) return c.json({ status: 'error', path: rel, files: [], error: 'That folder is outside the library.' }, 400);
    if (r.exit_code !== 0) return c.json({ status: 'error', path: rel, files: [], error: (r.output ?? '').slice(0, 300) });
    // Pages have their own tab (page-shelf.ts); the Library is the bot's other files.
    return c.json({ status: 'ok', path: rel, files: parseLs(r.output ?? '').filter((f) => f.name !== '.cleft-trash' && !(!f.isDir && isPagePath(f.name))) });
  } catch (e: any) {
    return c.json({ status: 'error', path: rel, files: [], error: String(e?.message ?? e).slice(0, 300) });
  }
});

configApi.post('/bots/:id/files/download', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { path } = await c.req.json<{ path: string }>().catch(() => ({ path: '' }));
  const rel = safeRel(path);
  if (!rel) return c.json({ error: 'bad path' }, 400);
  // On the computer itself the file is on our own disk: serve it directly.
  if (box.local) return c.json({ url: `/api/bots/${b.id}/files/raw?path=${encodeURIComponent(rel)}` });
  try {
    if (!env.orgoComputerId) return c.json({ error: 'computer unavailable' }, 409);
    // Resolve links on the computer first and export the real path, only if it is a file inside the library.
    const root = `${libraryRoot()}/${b.id}`;
    const chk = await box.bash(`${insideRootSh(root, `${root}/${rel}`, 'f')} && test -f "$d" && printf '%s' "$d"`, 30);
    if (chk.exit_code !== 0 || !chk.output) return c.json({ error: 'not found' }, 404);
    const r: any = await orgo.exportFile(env.orgoComputerId, String(chk.output).trim());
    const url = r?.url ?? r?.file?.url ?? r?.download_url;
    if (!url) return c.json({ error: 'export returned no link' }, 502);
    return c.json({ url });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

configApi.get('/bots/:id/files/raw', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || !box.local) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  if (!rel) return c.json({ error: 'bad path' }, 400);
  // Follow links before checking, so a link inside the library cannot point outside it.
  const file = insideFile(b.id, rel);
  if (!file) return c.json({ error: 'not found' }, 404);
  const name = rel.split('/').pop()!;
  // inline=1 shows pictures and PDFs in the file pane; everything else is always a download.
  const mime = mimeFor(name);
  const inline = c.req.query('inline') === '1' && mime !== 'application/octet-stream';
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
    headers: {
      'content-type': inline ? mime : 'application/octet-stream',
      'content-length': String(fs.statSync(file).size),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'",
      'cache-control': 'private, no-cache',
    },
  });
});

// ---------- file pane: previews, pages, edits, this chat's files (files.ts) ----------

const fileErr = (c: any, e: any) => c.json({ error: String(e?.message ?? e).slice(0, 300) }, e?.status ?? 500);

configApi.get('/bots/:id/files/preview', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (!box.local) return c.json({ error: 'Previews need the app to run on the bots’ computer.' }, 409);
  const rel = safeRel(c.req.query('path'));
  if (!rel) return c.json({ error: 'bad path' }, 400);
  try { return c.json(await previewOf(b.id, rel)); } catch (e) { return fileErr(c, e); }
});

configApi.get('/bots/:id/files/page', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || !box.local) return c.json({ error: 'not found' }, 404);
  const rel = safeRel(c.req.query('path'));
  const n = Number(c.req.query('n') ?? 1);
  if (!rel || !Number.isInteger(n) || n < 1 || n > 2000) return c.json({ error: 'bad request' }, 400);
  const file = insideFile(b.id, rel);
  if (!file) return c.json({ error: 'not found' }, 404);
  try {
    const png = await pagePng(file, n);
    return new Response(Readable.toWeb(fs.createReadStream(png)) as ReadableStream, {
      headers: { 'content-type': 'image/png', 'content-length': String(fs.statSync(png).size), 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' },
    });
  } catch (e) { return fileErr(c, e); }
});

/** The owner saving a text file from the pane. Only inside the bot's workspace; a person's edit, not a bot's. */
configApi.put('/bots/:id/files/text', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || !box.local) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ path: string; text: string; modifiedAt?: number }>().catch(() => null);
  const rel = safeRel(body?.path);
  if (!rel || typeof body?.text !== 'string') return c.json({ error: 'bad request' }, 400);
  try { return c.json(saveText(b.id, rel, body.text, body.modifiedAt)); } catch (e) { return fileErr(c, e); }
});

configApi.get('/bots/:id/chat-files', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rows = db.prepare(`SELECT seq, body FROM rows WHERE bot_id=? AND generation=? AND kind='card' AND body LIKE '%"card":"files"%' ORDER BY seq DESC LIMIT 200`).all(b.id, b.generation) as any[];
  const seen = new Set<string>();
  const files: ChatFileEntry[] = [];
  for (const r of rows) {
    let body: any;
    try { body = JSON.parse(r.body); } catch { continue; }
    for (const f of body.files ?? []) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      const now = box.local ? describe(b.id, f.path) : null;
      files.push(now ? { ...now, seq: r.seq } : { ...f, seq: r.seq, missing: box.local ? true : undefined });
    }
  }
  return c.json({ files });
});

// ---------- Pages (pages.ts): read, change, history, export ----------

// Who a Page change is recorded under: the person's own name (as on approval cards), or the program's
// name when a script signed in to the account made it.
/**
 * Who is editing a Page. Alex and Sam share one account, so the id says which person signed in (and a
 * script gets its own): one person's edits are never merged into another's, and Undo only takes back your own.
 */
const personOf = (c: any) => {
  const u = c.get('user');
  const agent: string | null = c.get('agent') ?? null;
  const person = currentSession(c)?.person ?? null;
  const id = agent ? `${u.id}:script:${agent}` : person ? `${u.id}:${person}` : u.id;
  return { kind: 'person' as const, id, name: agent || displayName(u, person) || 'You' };
};
const pageReq = (c: any, rel0: unknown): { error?: Response; b: any; rel: string } => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || !box.local) return { error: c.json({ error: 'not found' }, 404), b, rel: '' };
  const rel = safeRel(typeof rel0 === 'string' ? rel0 : undefined);
  if (!rel || !isPagePath(rel)) return { error: c.json({ error: 'bad path' }, 400), b, rel: '' };
  return { b, rel };
};

configApi.get('/bots/:id/pages', (c) => {
  const r = pageReq(c, c.req.query('path'));
  if (r.error) return r.error;
  // With where its buttons and calculators send (the chat it came from), for the page view.
  try { const info = shelfInfo(r.b.id, r.rel); return c.json({ ...loadPage(r.b.id, r.rel, r.b.name), sendTo: info.sendTo, sendToTitle: info.chatTitle, pinned: info.pinned }); } catch (e) { return fileErr(c, e); }
});

// ---------- the Pages tab (page-shelf.ts): list, pin, delete with Undo ----------

configApi.get('/bots/:id/pages/list', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  if (!box.local || b.kind === 'room') return c.json({ pages: [] });
  try { return c.json({ pages: listShelf(b.id) }); } catch (e) { return fileErr(c, e); }
});

configApi.post('/bots/:id/pages/pin', async (c) => {
  const body = await c.req.json<{ path: string; pinned?: boolean }>().catch(() => null);
  const r = pageReq(c, body?.path);
  if (r.error) return r.error;
  try { setPinned(r.b.id, r.rel, !!body?.pinned); return c.json({ ok: true }); } catch (e) { return fileErr(c, e); }
});

configApi.post('/bots/:id/pages/delete', async (c) => {
  const body = await c.req.json<{ path: string }>().catch(() => null);
  const r = pageReq(c, body?.path);
  if (r.error) return r.error;
  try { return c.json(trashPage(r.b.id, r.rel)); } catch (e) { return fileErr(c, e); }
});

configApi.post('/bots/:id/pages/undelete', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || !box.local) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ id: string }>().catch(() => null);
  if (typeof body?.id !== 'string' || !/^pg_\w{4,40}$/.test(body.id)) return c.json({ error: 'bad request' }, 400);
  try { return c.json(restoreFromTrash(b.id, body.id)); } catch (e) { return fileErr(c, e); }
});

configApi.post('/bots/:id/pages', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b || !box.local) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ title?: string; markdown?: string; folder?: string }>().catch(() => null);
  try {
    const made = createPage(chatOwner(b.id), { title: String(body?.title ?? ''), markdown: body?.markdown, folder: body?.folder }, personOf(c));
    notePageOrigin(b.id, made.page.id, { kind: 'person' });
    return c.json(made);
  } catch (e) { return fileErr(c, e); }
});

configApi.post('/bots/:id/pages/ops', async (c) => {
  const body = await c.req.json<{ path: string; ops: any[] }>().catch(() => null);
  const r = pageReq(c, body?.path);
  if (r.error) return r.error;
  try { const out = applyOps(r.b.id, r.rel, body!.ops, personOf(c), r.b.name); return c.json({ page: out.page, results: out.results }); } catch (e) { return fileErr(c, e); }
});

configApi.get('/bots/:id/pages/history', (c) => {
  const r = pageReq(c, c.req.query('path'));
  if (r.error) return r.error;
  try { return c.json({ versions: history(r.b.id, r.rel) }); } catch (e) { return fileErr(c, e); }
});

configApi.get('/bots/:id/pages/version', (c) => {
  const r = pageReq(c, c.req.query('path'));
  if (r.error) return r.error;
  try { return c.json(versionOf(r.b.id, r.rel, Number(c.req.query('v')))); } catch (e) { return fileErr(c, e); }
});

configApi.post('/bots/:id/pages/restore', async (c) => {
  const body = await c.req.json<{ path: string; version?: number; undo?: boolean }>().catch(() => null);
  const r = pageReq(c, body?.path);
  if (r.error) return r.error;
  try { return c.json(body?.undo ? undoLast(r.b.id, r.rel, personOf(c)) : restore(r.b.id, r.rel, Number(body?.version), personOf(c))); } catch (e) { return fileErr(c, e); }
});

configApi.post('/bots/:id/pages/export', async (c) => {
  const body = await c.req.json<{ path: string; format: string; table?: string; buttons?: boolean }>().catch(() => null);
  const r = pageReq(c, body?.path);
  if (r.error) return r.error;
  if (!(EXPORT_FORMATS as readonly string[]).includes(String(body?.format))) return c.json({ error: 'bad format' }, 400);
  try { return c.json(await exportPage(r.b.id, r.rel, body!.format as ExportFormat, { table: body?.table, buttons: body?.buttons })); } catch (e) { return fileErr(c, e); }
});

// ---------- computer: screens, reset, hibernation ----------

configApi.get('/computer/details', (c) => {
  const userId = c.get('user').id;
  const leases = db.prepare('SELECT bot_id, screen_id, last_used_at FROM screens WHERE user_id=? ORDER BY last_used_at DESC').all(userId) as any[];
  return c.json({
    computer: computerState(userId),
    screens: leases.map((l) => ({ botId: l.bot_id, screenId: l.screen_id, lastUsedAt: l.last_used_at })),
    hibernation: { idleMinutes: idleConfig.idleMin, viewers: viewerCount(userId), dryRun: idleConfig.dryRun },
  });
});

/** Give a bot a clean screen: close what is open and bring its browser back to its home screen. Logins stay. */
configApi.post('/bots/:id/screen/reset', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    await resetBotScreen(user.id, b.id);
    hub.emit(user.id, { type: 'computer', state: computerState(user.id) });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, 502);
  }
});

/**
 * A viewer (phone or web app) gave up on a bot's live screen after its quiet retries (screenRetry.ts). Only
 * logged: with the relay's own lines (vnc.ts) it says which side dropped the link and why.
 */
configApi.post('/bots/:id/screen/problem', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const p = await c.req.json<{ tries?: unknown; cause?: unknown; code?: unknown; opened?: unknown; ms?: unknown; client?: unknown }>().catch(() => ({} as Record<string, unknown>));
  const text = (v: unknown, n: number) => String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, n);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : '-');
  console.warn(`[vnc] screen bot=${b.id}: ${text(p.client, 20) || 'a viewer'} gave up after ${num(p.tries)} tries (last link: code ${num(p.code)}, ${p.opened === false ? 'never opened' : p.opened ? 'opened' : 'open unknown'}, ${num(p.ms)} ms): ${text(p.cause, 240)}`);
  return c.json({ ok: true });
});

// ---------- copy and paste with a bot's screen (clipboard.ts) ----------

/** What is on the bot's screen's clipboard: read when the person presses Copy, never in the background. */
configApi.get('/bots/:id/clipboard', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    const r = await readBotClipboard(user.id, b.id);
    c.header('Cache-Control', 'no-store');
    return c.json(r);
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, e instanceof ClipboardError ? (e.status as any) : 502);
  }
});

/** Put the person's text on the bot's screen's clipboard, for Ctrl+V there. */
configApi.put('/bots/:id/clipboard', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  try {
    const body = await c.req.json<{ text?: unknown }>().catch(() => ({}) as { text?: unknown });
    await writeBotClipboard(user.id, b.id, checkPaste(body.text));
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e).slice(0, 300) }, e instanceof ClipboardError ? (e.status as any) : 502);
  }
});
