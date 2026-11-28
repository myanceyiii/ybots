// A bot's look: its picture, the looks it offers on a card in the chat, and the poses made from it.
//
// - Pictures come from the image service at AVATAR_IMAGE_URL (scripts/codex-image-bridge.py on Host2,
//   which uses Hermes' ChatGPT sign-in). A reference picture is sent as `image` (a data URL); the
//   bridge passes it to the provider's edit route so the character stays the same.
// - A bot can offer new looks for itself (tool change_my_look): that only shows a card. Nothing
//   changes until the owner picks a picture on it. A bot can never choose.
// - Once a picture is set, a pose set is made from it (avatar-poses.ts) and the apps show the pose
//   that fits what the bot is doing.

import type { Hono } from 'hono';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import type { AuthVars } from './lib/auth.js';
import { appendRow, emitBot, getBot, getBotRow, getRow, updateRow } from './store.js';
import { AVATAR_POSES, AVATAR_STYLES, LOOK_SUGGESTIONS, isPose, styleById, type AvatarPose } from './avatar-poses.js';
import type { AvatarPoseJob, CardBody } from './types.js';
import { headCrop } from './avatar-crop.js';
import { hub } from './lib/hub.js';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_CANDIDATES = 8;
/** Every request for looks draws this many (Alex, 2026-11-22: no picker, always 3). */
export const LOOK_COUNT = 3;
const KEEP_UNCHOSEN_MS = 14 * 24 * 3600_000;
const POSE_WORKERS = 3;

type LookCard = Extract<CardBody, { card: 'look' }>;
export type LookIntent = LookCard['intent'];

/** Thrown with a message the owner can read. */
export class LookError extends Error {}

// ---------- pictures ----------

/** The picture type from its first bytes (services send PNG, JPEG or WebP as bare base64). */
export function sniffImage(b64: string): string {
  const head = Buffer.from(b64.slice(0, 24), 'base64');
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return 'image/png';
}

export function parseImageDataUrl(v: unknown): { mime: string; bytes: Buffer } | null {
  if (typeof v !== 'string') return null;
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(v);
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  return bytes.length && bytes.length <= AVATAR_MAX_BYTES ? { mime: m[1], bytes } : null;
}

/** Send a picture, or its head-and-shoulders crop (`?crop=head`) for small tiles. */
function sendPicture(c: { body: (b: Uint8Array, s: 200, h: Record<string, string>) => Response }, img: { mime: string; bytes: Buffer }, head: boolean): Response {
  const out = head ? headCrop(img.bytes, img.mime) : img;
  return c.body(new Uint8Array(out.bytes), 200, { 'content-type': out.mime, 'cache-control': 'private, max-age=86400' });
}

const clampCount = (n: unknown, fallback: number) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 1 ? Math.min(MAX_CANDIDATES, v) : fallback;
};

/** Ask the image service for `n` pictures. `reference` keeps the character of that picture. */
async function askImages(prompt: string, n: number, reference?: string | null): Promise<string[]> {
  if (!env.avatarImageUrl) throw new LookError('Making pictures is not set up on this server (AVATAR_IMAGE_URL). You can still upload one.');
  const res = await fetch(env.avatarImageUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(env.avatarImageKey ? { authorization: `Bearer ${env.avatarImageKey}` } : {}) },
    body: JSON.stringify({
      ...(env.avatarImageModel ? { model: env.avatarImageModel } : {}),
      prompt, n, size: '1024x1024', response_format: 'b64_json',
      ...(reference ? { image: reference } : {}),
    }),
    signal: AbortSignal.timeout(300_000),
  }).catch((e) => ({ ok: false, status: 0, statusText: String(e?.message ?? e) }) as const);
  if (!res.ok) {
    // Pass the service's own reason on (a refused prompt says why), shortened and as plain text.
    const err = res.status ? ((await (res as Response).json().catch(() => null)) as { error?: { message?: string } | string } | null) : null;
    const why = String((typeof err?.error === 'string' ? err.error : err?.error?.message) ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new LookError(why ? `The image service said no: ${why}` : `The image service did not answer (${res.status || res.statusText}).`);
  }
  const out = (await (res as Response).json().catch(() => null)) as { data?: { b64_json?: string }[] } | null;
  const pics = (out?.data ?? []).map((d) => (d.b64_json ? `data:${sniffImage(d.b64_json)};base64,${d.b64_json}` : null)).filter((x): x is string => !!x && !!parseImageDataUrl(x));
  if (!pics.length) throw new LookError('The image service sent no pictures back.');
  return pics;
}

const FRAME = 'Square avatar, centered, the whole character in view, plain light background, no text.';

/** The words sent to the image service for a look. */
export function lookPrompt(name: string, o: { intent: 'tweak' | 'new'; description: string; style?: string | null; hasReference: boolean }) {
  const style = styleById(o.style);
  const desc = o.description.trim().replace(/\s+/g, ' ');
  if (o.intent === 'tweak' && o.hasReference) {
    return `Change the character in the reference picture: ${desc}. Keep the same character, face, colours and proportions${style ? '' : ' and the same art style'}.${style ? ` Redraw it in this style: ${style.prompt}.` : ''} ${FRAME}`;
  }
  const look = (style ?? AVATAR_STYLES[0]).prompt;
  const base = o.hasReference ? `A friendly assistant character named ${name}, based on the character in the reference picture` : `A friendly assistant character named ${name}`;
  return `${base}. ${desc}. Style: ${look}. ${FRAME}`;
}

export interface LookRequest { intent: 'tweak' | 'new'; description: string; style?: string | null; count?: number; reference?: string | null }

/** Make candidate pictures for a bot. Tweak starts from the bot's own picture unless another is given. */
export async function makeLooks(botId: string, r: LookRequest): Promise<string[]> {
  const bot = getBotRow(botId);
  if (!bot) throw new LookError('not found');
  const reference = r.reference ?? (r.intent === 'tweak' ? bot.avatar_image : null) ?? null;
  const intent = r.intent === 'tweak' && !reference ? 'new' : r.intent;
  const prompt = lookPrompt(bot.name, { intent, description: r.description, style: r.style, hasReference: !!reference });
  return askImages(prompt, LOOK_COUNT, reference);
}

// ---------- the picture itself ----------

/** Set (or with null, clear) a bot's picture. A new picture starts a fresh pose set. */
export function setPicture(botId: string, image: string | null, opts: { poses?: boolean } = {}) {
  db.prepare('UPDATE bots SET avatar_image=?, avatar_pose_job=NULL, updated_at=? WHERE id=?').run(image, now(), botId);
  db.prepare('DELETE FROM avatar_poses WHERE bot_id=?').run(botId);
  jobs.delete(botId);
  emitBot(botId);
  if (image && opts.poses !== false) void makePoses(botId);
  // Its desktop's home screen shows the picture: dress the screen again, if it has one.
  const owner = db.prepare('SELECT b.user_id FROM bots b JOIN screens s ON s.bot_id=b.id WHERE b.id=?').get(botId) as { user_id: string } | undefined;
  if (owner) {
    void import('./computer.js')
      .then(({ readyScreen }) => readyScreen(owner.user_id, botId, { redress: true }))
      .catch((e) => console.warn('[computer] redress after new picture failed', e?.message ?? e));
  }
}

/** Remove everything about a bot's looks (the bot is being deleted). */
export function forgetLooks(botId: string) {
  jobs.delete(botId);
  db.prepare('DELETE FROM avatar_poses WHERE bot_id=?').run(botId);
  db.prepare('DELETE FROM avatar_candidates WHERE bot_id=?').run(botId);
  db.prepare('DELETE FROM picture_runs WHERE bot_id=?').run(botId);
}

// ---------- poses ----------

/** The pose run in progress for each bot; a newer run (or a new picture) makes an older one stop. */
const jobs = new Map<string, symbol>();

function writeJob(botId: string, job: AvatarPoseJob) {
  db.prepare('UPDATE bots SET avatar_pose_job=? WHERE id=?').run(JSON.stringify(job), botId);
  emitBot(botId);
}

/**
 * Make poses from the bot's picture (all of them, or just `only`). `note` is added to each pose's
 * words (e.g. "keep the hat on"). Runs in the background, saving each pose as it arrives.
 */
export async function makePoses(botId: string, only?: AvatarPose[], note?: string): Promise<void> {
  // Groups don't get poses: each one redraws a single character from the group picture.
  if (getBotRow(botId)?.kind === 'room') return;
  const bot = getBotRow(botId);
  if (!bot?.avatar_image) return;
  const picture: string = bot.avatar_image;
  const list = AVATAR_POSES.filter((p) => !only?.length || only.includes(p.id));
  if (!list.length) return;
  const run = Symbol(botId);
  jobs.set(botId, run);
  const live = () => jobs.get(botId) === run && getBotRow(botId)?.avatar_image === picture;
  const job: AvatarPoseJob = { state: 'making', done: 0, total: list.length, failed: 0 };
  writeJob(botId, job);
  const extra = note?.trim() ? ` ${note.trim().replace(/\s+/g, ' ').slice(0, 300)}.` : '';
  const queue = [...list];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      if (!live()) return;
      const prompt = `The same character as in the reference picture, with the same face, colours, outfit, proportions and art style. Pose and expression: ${p.prompt}.${extra} ${FRAME}`;
      try {
        const [img] = await askImages(prompt, 1, picture);
        if (!live()) return;
        db.prepare('INSERT INTO avatar_poses(bot_id,pose,image,made_at) VALUES (?,?,?,?) ON CONFLICT(bot_id,pose) DO UPDATE SET image=excluded.image, made_at=excluded.made_at').run(botId, p.id, img, now());
        job.done++;
      } catch (e) {
        if (!live()) return;
        job.failed++;
        job.error = (e as Error).message;
        console.warn(`[looks] pose ${p.id} for ${botId} failed: ${job.error}`);
      }
      writeJob(botId, job);
    }
  };
  await Promise.all(Array.from({ length: Math.min(POSE_WORKERS, list.length) }, worker));
  if (!live()) return;
  jobs.delete(botId);
  writeJob(botId, { ...job, state: job.done ? 'ready' : 'stopped' });
}

/** A server that stopped mid-run cannot finish it; say so instead of showing "making" for ever. */
export function stopStalePoseJobs() {
  for (const r of db.prepare("SELECT id, avatar_pose_job FROM bots WHERE avatar_pose_job LIKE '%\"making\"%'").all() as { id: string; avatar_pose_job: string }[]) {
    try {
      const j = JSON.parse(r.avatar_pose_job) as AvatarPoseJob;
      db.prepare('UPDATE bots SET avatar_pose_job=? WHERE id=?').run(JSON.stringify({ ...j, state: 'stopped', error: 'The server restarted before every pose was made.' }), r.id);
    } catch { /* leave it */ }
  }
}

export const RESTARTED = 'The server restarted while drawing, so those pictures were lost. Try again.';

// ---------- picture runs for the settings page ----------
// Drawing can take longer than a proxy keeps a request open (Cloudflare gives up at 100 s), so the
// settings page starts a run and asks for it until it is done. Runs live in the database
// (picture_runs) so that:
//  - a server restart does not lose them: a run that was drawing is started again (resumeLookWork);
//  - an app that went to the background, was closed or was reloaded finds its pictures when it comes
//    back (GET /bots/:id/avatar/runs). Reading a run never removes it, so a reply lost on the way to
//    a phone that was asleep can simply be asked for again.

const RUN_KEEP_MS = 24 * 3600_000;
/** A run is started again after a restart at most this many times (a restart loop must not keep drawing). */
const MAX_RESUMES = 2;

interface RunRow { id: string; bot_id: string; ask: string; state: 'making' | 'done' | 'failed'; candidates: string | null; error: string | null; resumes: number; created_at: number; updated_at: number; seen_at: number | null }

function userOfBot(botId: string): string | null {
  return (db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as { user_id: string } | undefined)?.user_id ?? null;
}

function drawRun(id: string, botId: string, r: LookRequest) {
  makeLooks(botId, r)
    .then((pics) => {
      const ids = saveCandidates(botId, pics);
      db.prepare("UPDATE picture_runs SET state='done', candidates=?, error=NULL, updated_at=? WHERE id=?").run(JSON.stringify(ids), now(), id);
      return 'done' as const;
    })
    .catch((e) => {
      const error = (e as Error).message || 'The image service failed without saying why.';
      console.warn(`[looks] pictures for ${botId} failed: ${error}`);
      db.prepare("UPDATE picture_runs SET state='failed', error=?, updated_at=? WHERE id=?").run(error, now(), id);
      return 'failed' as const;
    })
    .then((state) => {
      const user = userOfBot(botId);
      if (user) hub.emit(user, { type: 'look-run', botId, run: id, state });
    });
}

function startPictureRun(botId: string, r: LookRequest): string {
  const t = now();
  db.prepare('DELETE FROM picture_runs WHERE created_at<?').run(t - RUN_KEEP_MS);
  const id = newId('run');
  db.prepare("INSERT INTO picture_runs(id,bot_id,ask,state,created_at,updated_at) VALUES (?,?,?,'making',?,?)").run(id, botId, JSON.stringify(r), t, t);
  drawRun(id, botId, r);
  return id;
}

/** The pictures of a finished run, as data URLs (the apps set one as the picture with PUT /avatar). */
function runPictures(botId: string, raw: string | null): string[] {
  let ids: string[] = [];
  try { ids = raw ? (JSON.parse(raw) as string[]) : []; } catch { /* none */ }
  const get = db.prepare('SELECT image FROM avatar_candidates WHERE id=? AND bot_id=?');
  return ids.map((cid) => (get.get(cid, botId) as { image: string } | undefined)?.image).filter((x): x is string => !!x);
}

const runSummary = (r: RunRow) => {
  let ask: Partial<LookRequest> = {};
  try { ask = JSON.parse(r.ask) as LookRequest; } catch { /* leave it empty */ }
  return {
    id: r.id, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at, seen: !!r.seen_at,
    ask: { description: ask.description ?? '', style: ask.style ?? null, count: ask.count, intent: ask.intent ?? 'new' },
    ...(r.state === 'failed' ? { error: r.error ?? 'The image service failed without saying why.' } : {}),
  };
};

/**
 * Work that was drawing when the last process stopped. Picture runs and look cards are started again
 * (at most MAX_RESUMES times each), so a restart in the middle of drawing costs time, not the pictures.
 * A look card started from an uploaded drawing starts again from the bot's own picture: the upload
 * was not kept.
 */
export function resumeLookWork() {
  const canDraw = !!env.avatarImageUrl;
  const t = now();
  const runs = db.prepare("SELECT * FROM picture_runs WHERE state='making'").all() as RunRow[];
  for (const r of runs) {
    if (!canDraw || r.resumes >= MAX_RESUMES || t - r.created_at > RUN_KEEP_MS) {
      db.prepare("UPDATE picture_runs SET state='failed', error=?, updated_at=? WHERE id=?").run(RESTARTED, t, r.id);
      continue;
    }
    db.prepare('UPDATE picture_runs SET resumes=resumes+1, updated_at=? WHERE id=?').run(t, r.id);
    try { drawRun(r.id, r.bot_id, JSON.parse(r.ask) as LookRequest); }
    catch { db.prepare("UPDATE picture_runs SET state='failed', error=?, updated_at=? WHERE id=?").run(RESTARTED, t, r.id); }
  }
  const rows = db.prepare(`SELECT r.bot_id, r.seq, r.body FROM rows r JOIN bots b ON b.id=r.bot_id AND b.generation=r.generation
    WHERE r.body LIKE '%"card":"look"%' AND r.body LIKE '%"status":"making"%'`).all() as { bot_id: string; seq: number; body: string }[];
  for (const r of rows) {
    try {
      const body = JSON.parse(r.body) as LookCard;
      if (body.card !== 'look' || body.status !== 'making') continue;
      const resumes = body.resumes ?? 0;
      if (!canDraw || body.intent === 'default' || resumes >= MAX_RESUMES) {
        updateRow(r.bot_id, r.seq, { ...body, status: body.candidates.length ? 'pending' : 'failed', error: RESTARTED });
        continue;
      }
      updateRow(r.bot_id, r.seq, { ...body, resumes: resumes + 1 });
      void fillLookCard(r.bot_id, r.seq, { intent: body.intent, description: body.description || 'a friendly look', style: body.style, count: body.count });
    } catch { /* leave it */ }
  }
}

// ---------- look cards in the chat ----------

function saveCandidates(botId: string, pics: string[]): string[] {
  const t = now();
  db.prepare('DELETE FROM avatar_candidates WHERE bot_id=? AND kept=0 AND created_at<?').run(botId, t - KEEP_UNCHOSEN_MS);
  const ins = db.prepare('INSERT INTO avatar_candidates(id,bot_id,image,kept,created_at) VALUES (?,?,?,0,?)');
  return pics.map((p) => { const id = newId('look'); ins.run(id, botId, p, t); return id; });
}

const lookRow = (botId: string, seq: number) => {
  const row = getRow(botId, seq);
  return row && row.body.type === 'card' && row.body.card === 'look' ? { row, body: row.body as LookCard } : null;
};

/** Fill a look card with pictures (adding to any it has). Runs in the background. */
async function fillLookCard(botId: string, seq: number, r: LookRequest) {
  try {
    const pics = await makeLooks(botId, r);
    const ids = saveCandidates(botId, pics);
    const cur = lookRow(botId, seq);
    if (!cur || cur.body.status !== 'making') return;
    updateRow(botId, seq, { ...cur.body, candidates: [...cur.body.candidates, ...ids], status: 'pending', error: undefined });
  } catch (e) {
    const cur = lookRow(botId, seq);
    if (!cur || cur.body.status !== 'making') return;
    const error = (e as Error).message || 'The image service failed without saying why.';
    console.warn(`[looks] card ${seq} for ${botId} failed: ${error}`);
    updateRow(botId, seq, { ...cur.body, status: cur.body.candidates.length ? 'pending' : 'failed', error });
  }
}

/** A bot offers new looks for itself: shows a card and starts making the pictures. */
export function offerLooks(botId: string, a: { description: string; intent: LookIntent; style?: string | null; count?: number }) {
  const bot = getBotRow(botId);
  const intent: LookIntent = a.intent === 'default' ? 'default' : a.intent === 'tweak' && bot?.avatar_image ? 'tweak' : 'new';
  const style = styleById(a.style)?.id;
  const count = LOOK_COUNT;
  const description = String(a.description ?? '').trim().slice(0, 1000);
  const card: LookCard = { type: 'card', card: 'look', intent, description, ...(style ? { style } : {}), count, candidates: [], status: intent === 'default' ? 'pending' : 'making' };
  const row = appendRow(botId, 'card', card);
  if (intent !== 'default') void fillLookCard(botId, row.seq, { intent, description: description || 'a friendly look', style, count });
  return { row, intent };
}

// ---------- routes ----------

export function lookRoutes(api: Hono<AuthVars>, ownBot: (userId: string, id: string) => any) {
  api.get('/looks/options', (c) => c.json({ styles: AVATAR_STYLES.map(({ id, label }) => ({ id, label })), poses: AVATAR_POSES.map(({ id, label }) => ({ id, label })), maxCount: LOOK_COUNT, generating: !!env.avatarImageUrl }));

  api.get('/bots/:id/avatar', (c) => {
    const b = ownBot(c.get('user').id, c.req.param('id'));
    if (!b) return c.json({ error: 'not found' }, 404);
    const img = parseImageDataUrl(b.avatar_image);
    if (!img) return c.json({ error: 'no picture' }, 404);
    // A group's picture is usually several characters: a face crop would zoom in on just one of them.
    return sendPicture(c, img, c.req.query('crop') === 'head' && b.kind !== 'room');
  });

  // Set the picture (`image`: a data URL) or go back to the shape (`image: null`). `poses: false` skips making poses.
  api.put('/bots/:id/avatar', async (c) => {
    const b = ownBot(c.get('user').id, c.req.param('id'));
    if (!b) return c.json({ error: 'not found' }, 404);
    // A side chat shows its bot's picture; one saved on the side chat itself would never be seen.
    if (b.side_of) return c.json({ error: 'Set the picture on the bot itself.' }, 400);
    const { image, poses } = await c.req.json<{ image: string | null; poses?: boolean }>();
    if (image !== null && !parseImageDataUrl(image)) return c.json({ error: 'image must be a PNG, JPEG or WebP data URL of at most 2 MB, or null' }, 400);
    setPicture(b.id, image, { poses: poses !== false });
    return c.json({ bot: getBot(b.id) });
  });

  // Candidate pictures. Nothing is saved until one is PUT above.
  //   prompt: the description; style: an AVATAR_STYLES id; count: 1-8 (4 when left out);
  //   intent: 'new' (default) or 'tweak' (start from the bot's picture, or from `reference`);
  //   reference: a data URL to start from (e.g. an uploaded drawing).
  api.post('/bots/:id/avatar/generate', async (c) => {
    const b = ownBot(c.get('user').id, c.req.param('id'));
    if (!b) return c.json({ error: 'not found' }, 404);
    const { prompt, style, count, intent, reference, wait } = await c.req.json<{ prompt: string; style?: string; count?: number; intent?: 'new' | 'tweak'; reference?: string | null; wait?: boolean }>();
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1000) return c.json({ error: 'describe the look in 1 to 1000 characters' }, 400);
    if (reference != null && !parseImageDataUrl(reference)) return c.json({ error: 'reference must be a PNG, JPEG or WebP data URL of at most 2 MB' }, 400);
    const ask: LookRequest = { description: prompt, style, count, intent: intent === 'tweak' ? 'tweak' : 'new', reference };
    // `wait: false` (the apps since this change): answer at once with a run to ask about.
    if (wait === false) {
      if (!env.avatarImageUrl) return c.json({ error: 'Making pictures is not set up on this server (AVATAR_IMAGE_URL).' }, 501);
      return c.json({ run: startPictureRun(b.id, ask) }, 202);
    }
    try {
      const candidates = await makeLooks(b.id, ask);
      return c.json({ candidates });
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg.startsWith('Making pictures is not set up') ? 501 : 502);
    }
  });

  // How a picture run is doing. 404 means it is unknown (older than a day, or from before runs were kept).
  // Asking again is safe: a finished run stays until it is a day old.
  api.get('/bots/:id/avatar/generate/:run', (c) => {
    const b = ownBot(c.get('user').id, c.req.param('id'));
    const run = b ? (db.prepare('SELECT * FROM picture_runs WHERE id=? AND bot_id=?').get(c.req.param('run'), b.id) as RunRow | undefined) : undefined;
    if (!b || !run) return c.json({ error: RESTARTED }, 404);
    if (run.state === 'making') return c.json({ state: 'making' });
    return c.json(run.state === 'done' ? { state: 'done', candidates: runPictures(b.id, run.candidates) } : { state: 'failed', error: run.error });
  });

  // A bot's picture runs from the last day that an app has not shown yet (and any still drawing), newest
  // first. An app that was closed, reloaded or in the background uses this to pick up where it left off.
  api.get('/bots/:id/avatar/runs', (c) => {
    const b = ownBot(c.get('user').id, c.req.param('id'));
    if (!b) return c.json({ error: 'not found' }, 404);
    const rows = db.prepare("SELECT * FROM picture_runs WHERE bot_id=? AND created_at>? AND (state='making' OR seen_at IS NULL) ORDER BY created_at DESC LIMIT 10")
      .all(b.id, now() - RUN_KEEP_MS) as RunRow[];
    return c.json({ runs: rows.map(runSummary) });
  });

  // An app has shown a finished run's pictures (or its failure): stop offering it to the other apps.
  api.post('/bots/:id/avatar/generate/:run/seen', (c) => {
    const b = ownBot(c.get('user').id, c.req.param('id'));
    if (!b) return c.json({ error: 'not found' }, 404);
    db.prepare("UPDATE picture_runs SET seen_at=? WHERE id=? AND bot_id=? AND state!='making'").run(now(), c.req.param('run'), b.id);
    return c.json({ ok: true });
  });

  api.get('/bots/:id/avatar/poses/:pose', (c) => {
    const b = ownBot(c.get('user').id, c.req.param('id'));
    if (!b || !isPose(c.req.param('pose'))) return c.json({ error: 'not found' }, 404);
    const r = db.prepare('SELECT image FROM avatar_poses WHERE bot_id=? AND pose=?').get(b.id, c.req.param('pose')) as { image: string } | undefined;
    const img = parseImageDataUrl(r?.image);
    if (!img) return c.json({ error: 'no picture' }, 404);
    return sendPicture(c, img, c.req.query('crop') === 'head');
  });

  // Make poses again: all of them, or `poses` only; `note` is added to every pose's words.
  api.post('/bots/:id/avatar/poses', async (c) => {
    const b = ownBot(c.get('user').id, c.req.param('id'));
    if (!b) return c.json({ error: 'not found' }, 404);
    if (!b.avatar_image) return c.json({ error: 'Set a picture first: poses are made from it.' }, 400);
    if (!env.avatarImageUrl) return c.json({ error: 'Making pictures is not set up on this server (AVATAR_IMAGE_URL).' }, 501);
    const { poses, note } = await c.req.json<{ poses?: string[]; note?: string }>().catch(() => ({} as { poses?: string[]; note?: string }));
    const only = Array.isArray(poses) ? poses.filter(isPose) : undefined;
    if (Array.isArray(poses) && !only?.length) return c.json({ error: 'no such pose' }, 400);
    void makePoses(b.id, only, typeof note === 'string' ? note : undefined);
    return c.json({ ok: true });
  });

  // Stop using poses (the picture stays).
  api.delete('/bots/:id/avatar/poses', (c) => {
    const b = ownBot(c.get('user').id, c.req.param('id'));
    if (!b) return c.json({ error: 'not found' }, 404);
    jobs.delete(b.id);
    db.prepare('DELETE FROM avatar_poses WHERE bot_id=?').run(b.id);
    db.prepare('UPDATE bots SET avatar_pose_job=NULL WHERE id=?').run(b.id);
    emitBot(b.id);
    return c.json({ ok: true });
  });

  api.get('/bots/:id/look/:cid', (c) => {
    const b = ownBot(c.get('user').id, c.req.param('id'));
    if (!b) return c.json({ error: 'not found' }, 404);
    const r = db.prepare('SELECT image FROM avatar_candidates WHERE id=? AND bot_id=?').get(c.req.param('cid'), b.id) as { image: string } | undefined;
    const img = parseImageDataUrl(r?.image);
    if (!img) return c.json({ error: 'gone' }, 404);
    return c.body(new Uint8Array(img.bytes), 200, { 'content-type': img.mime, 'cache-control': 'private, max-age=604800, immutable' });
  });

  // The owner picks a picture on a look card (or, on a "back to the shape" card, candidateId null).
  api.post('/bots/:id/look-cards/:seq/choose', async (c) => {
    const b = ownBot(c.get('user').id, c.req.param('id'));
    if (!b) return c.json({ error: 'not found' }, 404);
    const cur = lookRow(b.id, Number(c.req.param('seq')));
    if (!cur) return c.json({ error: 'not a look card' }, 400);
    if (cur.body.status !== 'pending') return c.json({ error: 'This card is no longer open.' }, 409);
    const { candidateId } = await c.req.json<{ candidateId: string | null }>();
    if (candidateId === null) {
      setPicture(b.id, null);
      updateRow(b.id, cur.row.seq, { ...cur.body, chosen: null, status: 'applied' });
      return c.json({ ok: true });
    }
    if (!cur.body.candidates.includes(candidateId)) return c.json({ error: 'not on this card' }, 400);
    const pic = db.prepare('SELECT image FROM avatar_candidates WHERE id=? AND bot_id=?').get(candidateId, b.id) as { image: string } | undefined;
    if (!pic || !parseImageDataUrl(pic.image)) return c.json({ error: 'That picture is no longer kept. Ask for new looks.' }, 410);
    db.prepare('UPDATE avatar_candidates SET kept=1 WHERE id=?').run(candidateId);
    setPicture(b.id, pic.image);
    updateRow(b.id, cur.row.seq, { ...cur.body, chosen: candidateId, status: 'applied' });
    const pool = [...LOOK_SUGGESTIONS].sort(() => Math.random() - 0.5).slice(0, 3);
    appendRow(b.id, 'card', { type: 'card', card: 'look-reveal', candidateId, suggestions: pool });
    return c.json({ ok: true });
  });

  // The owner asks for a look card straight away, without asking the bot. The apps use this for a bot
  // that lives outside the app (Sheldon): a chat message to it would go out through its link instead.
  api.post('/bots/:id/look-cards', async (c) => {
    const b = ownBot(c.get('user').id, c.req.param('id'));
    if (!b) return c.json({ error: 'not found' }, 404);
    const a = await c.req.json<{ description?: string; intent?: LookIntent; style?: string | null; count?: number }>().catch(() => ({} as Record<string, never>));
    const description = typeof a.description === 'string' ? a.description.trim() : '';
    if (description.length > 1000) return c.json({ error: 'describe the look in at most 1000 characters' }, 400);
    if (a.intent !== 'default' && !env.avatarImageUrl) return c.json({ error: 'Making pictures is not set up on this server (AVATAR_IMAGE_URL).' }, 501);
    const intent: LookIntent = a.intent === 'default' ? 'default' : a.intent === 'new' ? 'new' : 'tweak';
    const { row } = offerLooks(b.id, { description, intent, style: a.style, count: a.count });
    return c.json({ seq: row.seq });
  });

  // More pictures on an open look card: optionally a different intent, description, style or count.
  api.post('/bots/:id/look-cards/:seq/more', async (c) => {
    const b = ownBot(c.get('user').id, c.req.param('id'));
    if (!b) return c.json({ error: 'not found' }, 404);
    const cur = lookRow(b.id, Number(c.req.param('seq')));
    if (!cur) return c.json({ error: 'not a look card' }, 400);
    if (!['pending', 'failed'].includes(cur.body.status)) return c.json({ error: cur.body.status === 'making' ? 'Still making the last ones.' : 'This card is no longer open.' }, 409);
    const a = await c.req.json<{ intent?: 'tweak' | 'new'; description?: string; style?: string | null; count?: number; reference?: string | null }>().catch(() => ({} as Record<string, never>));
    if (a.reference != null && !parseImageDataUrl(a.reference)) return c.json({ error: 'reference must be a PNG, JPEG or WebP data URL of at most 2 MB' }, 400);
    const intent = a.intent === 'tweak' && b.avatar_image ? 'tweak' : a.intent === 'new' ? 'new' : cur.body.intent === 'default' ? 'new' : cur.body.intent;
    const description = (typeof a.description === 'string' && a.description.trim() ? a.description : cur.body.description || 'a friendly look').slice(0, 1000);
    const style = a.style === null ? undefined : styleById(a.style ?? cur.body.style)?.id;
    const count = LOOK_COUNT;
    const card: LookCard = { ...cur.body, intent, description, count, status: 'making', error: undefined };
    if (style) card.style = style; else delete card.style;
    updateRow(b.id, cur.row.seq, card);
    void fillLookCard(b.id, cur.row.seq, { intent, description, style, count, reference: a.reference ?? null });
    return c.json({ ok: true });
  });
}
