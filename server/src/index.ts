import { answer } from './lib/contract.js';
import { API_VERSION, MIN_APP } from './app-support.js';
import { installProblemLog, requestMeter, startHealthWatch, statusApi, dbAnswers } from './status.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';
import { startDbCare } from './db-care.js';
import { pruneScriptSessions, sessionsApi } from './sessions.js';
import { usageApi } from './usage.js';
import { activityApi, backfillActivity, pruneActivity } from './activity.js';
import { accountExportApi } from './account-export.js';
import { desktopUpdatesApi } from './desktop-updates.js';
import { buildInfo } from './build-info.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db } from './db.js';
import { hub } from './lib/hub.js';
import path from 'node:path';
import type { Server } from 'node:http';
import { compatEnv, env } from './env.js';
import { api } from './routes.js';
import { attachVncRelay } from './vnc.js';
import { attachMachineLink } from './machines.js';
import { attachLiveStt } from './voiceLive.js';
import { initRoutines } from './routines.js';
import { initTriggers } from './triggers.js';
import { initProactive } from './proactive.js';
import { initSubagents } from './agent/subagents.js';
import { initRooms, setRoomEnqueue } from './agent/rooms.js';
import { initSlackLink, startSlackLink } from './slack-link.js';
import { checkinsApi } from './routes-proactive.js';
import { needsYouApi } from './needs-you.js';
import { vaultApi } from './vault.js';
import { roomsApi } from './routes-rooms.js';
import { busyBotNames, enqueue, expireStaleApprovals, interruptTurnsForUpdate } from './agent/loop.js';
import { resumeHops, startHopSweeper } from './bot-handoffs.js';
import { onShutdown } from './shutdown.js';
import { stallViewsAfterRestart } from './view-stall.js';
import { desSelfTest } from './lib/des.js';
import { configApi } from './routes-config.js';
import { extrasApi } from './chat-extras.js';
import { startIdleWatcher } from './idle.js';
import { mcpApi, startToolRefresh } from './mcp.js';
import { pluginsApi } from './plugins/routes.js';
import { connectorsApi, connectorsGoogleCallback, connectorsOAuth } from './connectors-routes.js';
import { connectionsApi } from './connections-routes.js';
import { startGoogleServers } from './google-accounts.js';
import { startConnectorScans } from './connectors.js';
import { initEngines } from './engine.js';
import { startProviderRefresh } from './provider-runtime.js';
import { isLocalRequest, purgeExpiredSessions, sameOriginWrites } from './lib/auth.js';
import { resolveBoxData } from './paths.js';
import { resumeLookWork, stopStalePoseJobs } from './avatars.js';
import { startNotify } from './notify.js';
import { startListSummaries } from './list-summary.js';
import { startSideChats } from './side-chats.js';
import { warmVoiceSamples } from './voice.js';
import { callsApi } from './calls.js';
import { systemdTimersApi } from './systemd-timer-routes.js';

// Warnings and errors are kept for the owner's System page from the first line on (status.ts).
installProblemLog();
if (!desSelfTest()) throw new Error('DES self-test failed');
initSubagents();
initRooms();
initSlackLink();
// Approvals wait in memory; whatever was still open when the last process stopped can no longer be answered.
startNotify();
startListSummaries();
startSideChats();
expireStaleApprovals();
// Handoffs between bots a restart cut off start again; waits that ran out fail out loud (bot-handoffs.ts).
try { const n = resumeHops(); if (n) console.log(`[hops] resumed ${n} handoff(s)`); } catch (e) { console.warn('[hops] could not resume', e); }
startHopSweeper();
try { stallViewsAfterRestart(); } catch (e) { console.warn('[views] could not mark stopped progress after restart', e); }
// Poses that were being made when the last process stopped will not finish (avatars.ts).
stopStalePoseJobs();
// Pictures that were being drawn are started again (picture runs and look cards).
resumeLookWork();

// Expired sign-ins are cleared out now and once a day.
try { purgeExpiredSessions(); } catch (e) { console.warn('[auth] could not clear expired sessions', (e as Error)?.message ?? e); }
// So are helper programs' sign-ins nobody has used for two weeks (sessions.ts).
{ const n = pruneScriptSessions(); if (n) console.log(`[auth] removed ${n} helper sign-in(s) unused for two weeks`); }
setInterval(() => { try { purgeExpiredSessions(); pruneScriptSessions(); } catch { /* next time */ } }, 24 * 60 * 60_000).unref();

const app = new Hono();
app.use('*', requestMeter);
// Every API answer carries a short reference. A failure is logged under the same one, and the apps show it
// beside the error, so "it said something went wrong (ref 3fa9c1d2)" leads straight to the line in the log.
const refs = new WeakMap<Request, string>();
app.use('/api/*', async (c, next) => {
  const ref = crypto.randomBytes(4).toString('hex');
  refs.set(c.req.raw, ref);
  await next();
  c.res.headers.set('X-Request-Id', ref);
});
// Nothing the server sends is meant to be shown inside another site's frame (clickjacking), so every
// response says so, in both the current form and the one older browsers know. A route that sets a
// Content-Security-Policy of its own keeps it: frame-ancestors is added to it unless it names one
// (no route does yet; the app-connection callback page sets none and its inline script is unaffected).
// Browsers are also told never to guess a file's type (a bot's file served as text stays text) and to
// keep the app's addresses to themselves when a link leaves it.
app.use('*', async (c, next) => {
  await next();
  const csp = c.res.headers.get('Content-Security-Policy');
  if (!csp) c.res.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  else if (!/(^|;)\s*frame-ancestors(\s|;|$)/i.test(csp)) c.res.headers.set('Content-Security-Policy', `${csp.replace(/[;\s]+$/, '')}; frame-ancestors 'none'`);
  if (!c.res.headers.has('X-Frame-Options')) c.res.headers.set('X-Frame-Options', 'DENY');
  if (!c.res.headers.has('X-Content-Type-Options')) c.res.headers.set('X-Content-Type-Options', 'nosniff');
  if (!c.res.headers.has('Referrer-Policy')) c.res.headers.set('Referrer-Policy', 'same-origin');
  // A private app: search engines are told to keep out (robots.txt says the same), and the browser is
  // told the page never uses what it has no use for. The microphone and camera stay: calls, dictation, QR.
  c.res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  if (!c.res.headers.has('Permissions-Policy')) c.res.headers.set('Permissions-Policy', 'geolocation=(), payment=(), usb=(), serial=()');
  // What the API answers is one person's data: never kept by a browser or a proxy. Only JSON:
  // pictures and files keep whatever caching their routes give them.
  if (c.req.path.startsWith('/api/') && !c.res.headers.has('Cache-Control') && /json/i.test(c.res.headers.get('Content-Type') ?? '')) c.res.headers.set('Cache-Control', 'no-store');
  // Reached over https (through the front door): the browser is told to keep using https for this address.
  if (c.req.header('x-forwarded-proto') === 'https' && !c.res.headers.has('Strict-Transport-Security')) c.res.headers.set('Strict-Transport-Security', 'max-age=15552000');
});
// Answers are sent compressed (the app's script is a quarter of its size that way, a long chat's rows a
// fifth). Streams are left alone: event streams, the agents' /mcp, voice and calls must not be buffered.
const NEVER_COMPRESSED = /^\/api\/(events|notify\/stream|voice|calls)(\/|$)|^\/mcp(\/|$)/;
const squeeze = compress();
app.use('*', (c, next) => (NEVER_COMPRESSED.test(c.req.path) ? next() : squeeze(c, next)));
// A request the server cannot read (a body that is not JSON) is the sender's mistake, said plainly; anything
// else is logged here and answered without the details, so the apps show a sentence and not a stack.
app.onError((e, c) => {
  const status = (e as { status?: number }).status;
  if (e instanceof SyntaxError || /JSON/i.test(String((e as Error)?.message ?? ''))) return c.json({ error: 'The request could not be read.' }, 400);
  if (typeof status === 'number' && status >= 400 && status < 500) return c.json({ error: String((e as Error).message || 'Bad request.') }, status as 400);
  const ref = refs.get(c.req.raw);
  console.error(`[http]${ref ? ` ref ${ref}` : ''}`, c.req.method, c.req.path, e);
  return c.json({ error: 'Something went wrong on the server. Try again.', ...(ref ? { ref } : {}) }, 500);
});
// A JSON request larger than anything the apps send is refused before it is read (files and voice go up
// as uploads, not JSON, and keep their own limits).
const MAX_JSON = 16 * 1024 * 1024;
// Counted as the body arrives (Hono's bodyLimit), so a chunked request without a Content-Length is held to
// the same limit. Uploads (attachments, voice) are at most 25 MB; every other body is far smaller.
const MAX_BODY = 30 * 1024 * 1024;
const tooLarge = (c: Context) => c.json({ error: 'That is too much to send in one go.', code: 'too_large' }, 413);
const jsonLimit = bodyLimit({ maxSize: MAX_JSON, onError: tooLarge });
const anyLimit = bodyLimit({ maxSize: MAX_BODY, onError: tooLarge });
app.use('/api/*', (c, next) => (/json/i.test(c.req.header('content-type') ?? '') ? jsonLimit(c, next) : anyLimit(c, next)));
// Cookie-authenticated writes must come from the app's own pages (CSRF; see sameOriginWrites).
app.use('/api/*', sameOriginWrites);
// From the machine itself, health also names the bots with a turn running: a deploy (cleft-ops) waits for
// them before it restarts the server. Others see only ok.
// A server whose database no longer answers is not healthy: the deploy tool then puts the last build back.
app.get('/api/health', (c) => {
  if (!dbAnswers()) return c.json({ ok: false, engine: 'hermes', error: 'The database is not answering.' }, 503);
  return c.json(isLocalRequest(c) ? { ok: true, engine: 'hermes', busy: busyBotNames(), commit: buildInfo().commit, uptimeSec: Math.round(process.uptime()) } : { ok: true, engine: 'hermes' });
});
// Which installed apps still work with this server (app-support.ts): no sign-in needed, nothing private in it.
app.get('/api/app-support', (c) => answer(c, 'GET /api/app-support', { api: API_VERSION, minApp: { ...MIN_APP }, updateUrl: { android: safeUpdateUrl(process.env.ANDROID_UPDATE_URL) } }));
const safeUpdateUrl = (v: string | undefined) => (v && /^https:\/\/[^\s]+$/.test(v.trim()) ? v.trim() : null);
// Stopping: the apps are told first, so they say "updating" instead of "connection lost" and come back
// the moment the new server answers.
onShutdown('tell the apps', async () => { hub.broadcast({ type: 'restarting' }); await new Promise((r) => setTimeout(r, 150)); }, 600);
// A restart (deploy) stops running turns first, so each chat says "Interrupted by an update" (agent/loop.ts).
onShutdown('interrupt running turns', async () => {
  const busy = await interruptTurnsForUpdate(4000);
  if (busy.length) console.log(`[cleftbot] interrupted for the update: ${busy.join(', ')}`);
}, 5000);
// The app's tools for the agent engines (MCP).
app.route('/mcp', mcpApi);
app.route('/api/checkins', checkinsApi);
app.route('/api/needs-you', needsYouApi);
app.route('/api/vault', vaultApi);
app.route('/api/rooms', roomsApi);
app.route('/api/plugins', pluginsApi);
app.route('/api/connectors/oauth', connectorsOAuth);
app.route('/api/connectors/google/callback', connectorsGoogleCallback);
app.route('/api/connectors', connectorsApi);
app.route('/api/connections', connectionsApi);
// The call service on this machine (deploy/calls); its own key, this machine only.
app.route('/api/calls', callsApi);
app.route('/api', systemdTimersApi);
app.route('/api', api);
app.route('/api', configApi);
app.route('/api', extrasApi);
app.route('/api', statusApi);
app.route('/api', sessionsApi);
app.route('/api', usageApi);
app.route('/api', activityApi);
app.route('/api', accountExportApi);
app.route('/api', desktopUpdatesApi);
// An address under /api that no route answers is a mistake in the caller, said as one: it used to get the
// web app's page with a 200, which an app then failed to read as JSON.
app.all('/api/*', (c) => c.json({ error: 'There is nothing at this address.', code: 'no_route' }, 404));
// For tests/app-routes.mjs: every route the server answers, so the suite can check each address the apps call.
if (process.env.CLEFT_ROUTE_LIST) fs.writeFileSync(process.env.CLEFT_ROUTE_LIST, JSON.stringify(app.routes.map((r) => ({ method: r.method, path: r.path }))));

app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n', 200, { 'Cache-Control': 'public, max-age=86400' }));

// Serve the built web app in production.
const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
if (fs.existsSync(webDist)) {
  // Files under /assets carry a hash of their contents in their name, so a browser may keep them for good;
  // the page that names them is asked for again every time, so a deploy shows up on the next load.
  app.use('/*', serveStatic({
    root: path.relative(process.cwd(), webDist),
    onFound: (file, c) => { c.header('Cache-Control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : /index\.html$/.test(file) ? 'no-cache' : 'public, max-age=3600'); },
  }));
  // A script or style from a build that is gone (a tab left open across a deploy): a plain 404, never the
  // page itself, which the browser would try to run as a script.
  app.get('/assets/*', (c) => c.text('Not found. Reload the page to get the current version.', 404, { 'Cache-Control': 'no-store' }));
  let page: { html: string; mtimeMs: number } | null = null;
  const indexFile = path.join(webDist, 'index.html');
  app.get('*', (c) => {
    const mtimeMs = fs.statSync(indexFile).mtimeMs;
    if (!page || page.mtimeMs !== mtimeMs) page = { html: fs.readFileSync(indexFile, 'utf8'), mtimeMs };
    return c.html(page.html, 200, { 'Cache-Control': 'no-cache' });
  });
}

const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => console.log(`[cleftbot] server on http://localhost:${info.port} (listening on ${env.host ?? 'every interface'})`));
// The front door (a proxy) keeps connections open to reuse them. Node's default closes an idle one after
// 5 s, and a request sent on a connection that is just closing comes back to the person as a 502. Kept
// open longer than proxies wait, that cannot happen.
(server as unknown as Server).keepAliveTimeout = 65_000;
(server as unknown as Server).headersTimeout = 66_000;
// One line that says what started: the build, the database it opened and what is in it. The first thing
// to read when the app shows the wrong bots (a stray database) or an old build.
try {
  const n = (q: string) => (db.prepare(q).get() as { n: number }).n;
  const b = buildInfo();
  console.log(`[cleftbot] build ${b.commit ?? 'unknown'}${b.version !== '0' ? ` (version ${b.version})` : ''}, node ${process.version}, database ${env.dbPath}${process.env.DB_PATH ? ' (DB_PATH)' : ' (default path)'}: ${n('SELECT COUNT(*) n FROM users')} account(s), ${n("SELECT COUNT(*) n FROM bots WHERE side_of IS NULL AND COALESCE(kind,'agent')<>'room'")} bot(s), ${n('SELECT COUNT(*) n FROM rows')} rows`);
} catch (e) { console.warn('[cleftbot] could not read the database for the start line', (e as Error)?.message ?? e); }
attachVncRelay(server as unknown as Server);
attachMachineLink(server as unknown as Server);
attachLiveStt(server as unknown as Server);
warmVoiceSamples();
// CLEFTBOT_NO_SCHEDULER=1 (or the older BOTHQ_NO_SCHEDULER=1) for extra dev/test servers sharing a database copy, so routines and triggers don't fire twice.
if (compatEnv('NO_SCHEDULER') !== '1') {
  initRoutines(enqueue);
  void initTriggers(enqueue);
initProactive(enqueue);
// The activity trail (activity.ts): copy the older logs in once, then keep it to 180 days.
try { backfillActivity(); pruneActivity(); } catch (e) { console.warn('[activity] start-up step failed', e); }
} else console.log('[cleftbot] scheduler disabled (NO_SCHEDULER=1)');
startIdleWatcher();
// The database is checked now; snapshots and housekeeping run daily (db-care.ts), not on a dev server sharing a copy.
startDbCare(compatEnv('NO_SCHEDULER') !== '1');
// The owner is told when a check on the System page turns bad (status.ts). STATUS_WATCH=1 switches it on for a test server.
if (compatEnv('NO_SCHEDULER') !== '1' || process.env.STATUS_WATCH === '1') startHealthWatch();
// Daily read-only scan of the machines for MCP servers (connectors.ts); off without CONNECTOR_SCAN_HOSTS.
if (compatEnv('NO_SCHEDULER') !== '1') startConnectorScans();
startGoogleServers();
resolveBoxData().catch((e) => console.warn('[cleftbot] could not check the computer for its data folder:', e?.message ?? e));
initEngines();
// Restarts an idle bot's gateway when its agent's list of app tools is out of date (mcp.ts); a dev server sharing the database must not.
if (compatEnv('NO_SCHEDULER') !== '1') startToolRefresh();
// Agents started with an older provider setup are restarted once idle (provider-runtime.ts).
if (compatEnv('NO_SCHEDULER') !== '1') startProviderRefresh();
// Outside members (Sheldon in Slack): the link runs even with NO_SCHEDULER, since it only reacts to messages.
startSlackLink(enqueue);
setRoomEnqueue(enqueue);
