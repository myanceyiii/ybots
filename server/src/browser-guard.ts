import crypto from 'node:crypto';
import WebSocket from 'ws';
import { db } from './db.js';
import { cdpUrlFor } from './computer.js';
import { GUARD_BINDING, GUARD_SOURCE, GUARD_WORLD } from './browser-guard-page.js';
import { browserKindKey, KIND_NAME, parseBrowserKindKey, siteOf, type ActionKind } from './action-kinds.js';
import { noteRuleUse } from './allow-rules.js';
import { conversationKindKeys, standingAllow } from './conversation-allows.js';

/**
 * The browser guard (docs/browser-cards.md): a DevTools connection from this server to each working bot's
 * Chrome. It puts browser-guard-page.ts into every page and frame in an isolated world, so that:
 *
 *  - purchase controls are held until the person approves a purchase card for the page's current state
 *    (request_purchase_approval); a changed total at the click is held and reported;
 *  - secure input (ask_secure_input) finds the field on the live page, and the value the person typed goes
 *    from the app straight into that field with Input.insertText, after re-checking the origin;
 *  - the bot hears, after its next browser step, that a pay button was held or a CAPTCHA is showing.
 *
 * Nothing here ever returns an entered value. Entered values are kept only as salted hashes, for an hour,
 * so the gate plugin can mask them if a later browser result echoes one (scrubList).
 */

type Json = any;
interface Ctx { id: number; session: string; frameId: string; origin: string }
interface Sess { id: string; targetId: string; type: string; parent: string | null; url: string; ready: Promise<void>; at: number }

class Cdp {
  private n = 0;
  private wait = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private handlers: ((method: string, params: Json, session: string) => void)[] = [];
  closed = false;
  constructor(private ws: WebSocket) {
    ws.on('message', (raw) => {
      let m: Json;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (typeof m.id === 'number') {
        const w = this.wait.get(m.id);
        if (!w) return;
        this.wait.delete(m.id); clearTimeout(w.timer);
        if (m.error) w.reject(new Error(String(m.error.message ?? 'DevTools error')));
        else w.resolve(m.result ?? {});
      } else if (typeof m.method === 'string') {
        for (const h of this.handlers) { try { h(m.method, m.params ?? {}, m.sessionId ?? ''); } catch { /* one bad handler */ } }
      }
    });
    ws.on('close', () => { this.closed = true; for (const w of this.wait.values()) { clearTimeout(w.timer); w.reject(new Error('The browser connection closed.')); } this.wait.clear(); });
    ws.on('error', () => { /* close follows */ });
  }
  on(h: (method: string, params: Json, session: string) => void) { this.handlers.push(h); }
  send(method: string, params: Json = {}, session?: string, timeoutMs = 8000): Promise<Json> {
    if (this.closed) return Promise.reject(new Error('The browser connection is closed.'));
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.wait.delete(id); reject(new Error(`${method} took too long`)); }, timeoutMs);
      this.wait.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
    });
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

export interface GuardNote { at: number; kind: 'held' | 'changed' | 'passed' | 'captcha' | 'pub_held' | 'pub_dry' | 'published' | 'kind_held' | 'kind_passed'; label?: string; origin: string; platform?: string; preview?: string; h?: string; action?: ActionKind; site?: string; via?: string }

/**
 * Publish hold state for a bot (posting.ts owns it): whether the hold is on, whether a dry run is running,
 * and the caption hashes the person approved. Pushed into every page; `publishOn` decides at attach time.
 */
export interface PublishState { on: boolean; dry: boolean; allow: { h: string; p: string }[] }
let publishStateOf: (botId: string) => PublishState = () => ({ on: false, dry: false, allow: [] });
let onPublishEvent: (botId: string, note: GuardNote) => void = () => undefined;
export function setPublishHooks(state: (botId: string) => PublishState, onEvent: (botId: string, note: GuardNote) => void) { publishStateOf = state; onPublishEvent = onEvent; }

/**
 * Other features that put a script of their own into a bot's pages (teach.ts, while recording) register here:
 * an attach hook runs for every new page and frame session, and a binding hook hears that feature's binding.
 */
type Send = (method: string, params?: Json) => Promise<Json>;
const attachHooks: ((botId: string, session: string, send: Send) => Promise<void>)[] = [];
const bindingHooks = new Map<string, (botId: string, payload: string, session: string) => void>();
export function onGuardAttach(h: (botId: string, session: string, send: Send) => Promise<void>) { attachHooks.push(h); }
export function onGuardBinding(name: string, h: (botId: string, payload: string, session: string) => void) { bindingHooks.set(name, h); }

class Watch {
  sessions = new Map<string, Sess>();
  contexts = new Map<string, Ctx>(); // key `${session}:${id}`
  notes: GuardNote[] = [];
  /** The kinds state last sent into the pages (setKinds), sent again into every new page and frame. */
  kindState = '';
  constructor(public botId: string, public cdp: Cdp) {}

  start = async () => {
    this.cdp.on((method, p, session) => {
      if (method === 'Target.attachedToTarget') void this.attach(p.sessionId, p.targetInfo, session || null);
      else if (method === 'Target.detachedFromTarget') { this.sessions.delete(p.sessionId); for (const k of [...this.contexts.keys()]) if (k.startsWith(`${p.sessionId}:`)) this.contexts.delete(k); }
      else if (method === 'Target.targetInfoChanged') { for (const s of this.sessions.values()) if (s.targetId === p.targetInfo?.targetId) { s.url = p.targetInfo.url; s.at = Date.now(); } }
      else if (method === 'Runtime.executionContextCreated') {
        const c = p.context;
        if (c?.name === GUARD_WORLD) {
          const ctx = { id: c.id, session, frameId: c.auxData?.frameId ?? '', origin: c.origin ?? '' };
          this.contexts.set(`${session}:${c.id}`, ctx);
          void this.pushPublish(ctx);
          void this.pushKinds(ctx);
        }
      } else if (method === 'Runtime.executionContextDestroyed') this.contexts.delete(`${session}:${p.executionContextId}`);
      else if (method === 'Runtime.executionContextsCleared') { for (const k of [...this.contexts.keys()]) if (k.startsWith(`${session}:`)) this.contexts.delete(k); }
      else if (method === 'Runtime.bindingCalled' && p.name === GUARD_BINDING) this.event(p.payload);
      else if (method === 'Runtime.bindingCalled' && bindingHooks.has(p.name)) { try { bindingHooks.get(p.name)!(this.botId, String(p.payload ?? ''), session); } catch { /* the hook logs its own problems */ } }
    });
    await this.cdp.send('Target.setDiscoverTargets', { discover: true });
    await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'page', exclude: false }, { type: 'iframe', exclude: false }, { exclude: true }] });
    // Pages that were open before we connected.
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    for (const t of targetInfos ?? []) {
      if (t.type === 'page' && ![...this.sessions.values()].some((s) => s.targetId === t.targetId)) {
        await this.cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(() => undefined);
      }
    }
  };

  private attach(session: string, info: Json, parent: string | null) {
    if (this.sessions.has(session)) return;
    const s: Sess = { id: session, targetId: info?.targetId ?? '', type: info?.type ?? 'page', parent, url: info?.url ?? '', at: Date.now(), ready: Promise.resolve() };
    s.ready = (async () => {
      const send = (m: string, p: Json = {}) => this.cdp.send(m, p, session).catch(() => undefined);
      await send('Runtime.addBinding', { name: GUARD_BINDING, executionContextName: GUARD_WORLD });
      await send('Page.enable');
      // Publish hold starts closed on every new document of a guarded bot, before the server's state arrives.
      if (publishStateOf(this.botId).on) await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__cleftPubOn = 1;', worldName: GUARD_WORLD, runImmediately: true });
      await send('Page.addScriptToEvaluateOnNewDocument', { source: GUARD_SOURCE, worldName: GUARD_WORLD, runImmediately: true });
      await send('Runtime.enable');
      // After Runtime.enable, so a hook's binding calls are heard from the first one.
      for (const h of attachHooks) await h(this.botId, session, send).catch(() => undefined);
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }, { exclude: true }] });
      await send('Runtime.runIfWaitingForDebugger');
    })();
    this.sessions.set(session, s);
  }

  private event(payload: string) {
    let e: Json;
    try { e = JSON.parse(payload); } catch { return; }
    const kind = ['held', 'changed', 'passed', 'captcha', 'pub_held', 'pub_dry', 'published', 'kind_held', 'kind_passed'].includes(e?.t) ? e.t : null;
    if (!kind) return;
    const origin = typeof e.origin === 'string' ? e.origin.slice(0, 200) : '';
    const label = typeof e.label === 'string' ? e.label.slice(0, 80) : undefined;
    if (kind === 'kind_held' || kind === 'kind_passed') {
      const action = ['delete', 'send', 'share', 'post', 'credentials'].includes(e.kind) ? e.kind as ActionKind : null;
      if (!action) return;
      const site = siteOf(typeof e.site === 'string' ? e.site : origin);
      const last = this.notes[this.notes.length - 1];
      if (last && last.kind === kind && last.origin === origin && last.action === action && Date.now() - last.at < 3000) return;
      const note: GuardNote = { at: Date.now(), kind, label, origin, action, site, via: e.via === 'once' ? 'once' : e.via === 'standing' ? 'standing' : undefined };
      this.notes.push(note);
      if (this.notes.length > 20) this.notes.shift();
      if (kind === 'kind_held') heldKinds.set(this.botId, note);
      else {
        // A press a standing answer let through is logged with the rule uses (Permissions screens).
        const key = browserKindKey(action, site);
        if (note.via === 'once') { onceKinds.delete(this.botId); heldKinds.delete(this.botId); }
        else {
          const id = standingAllow(this.botId, kindChat.get(this.botId), key);
          if (id) { try { noteRuleUse(id, this.botId, key, { label, origin }, `Pressed "${label ?? KIND_NAME[action]}" on ${site}`); } catch { /* log only */ } }
        }
      }
      return;
    }
    if (kind === 'pub_held' || kind === 'pub_dry' || kind === 'published') {
      const note: GuardNote = { at: Date.now(), kind, label, origin, platform: typeof e.platform === 'string' ? e.platform.slice(0, 20) : '', preview: typeof e.preview === 'string' ? e.preview.slice(0, 160) : '', h: typeof e.h === 'string' ? e.h.slice(0, 32) : undefined };
      const last = this.notes[this.notes.length - 1];
      if (kind !== 'published' && last && last.kind === kind && last.origin === origin && Date.now() - last.at < 3000) return;
      this.notes.push(note);
      if (this.notes.length > 20) this.notes.shift();
      try { onPublishEvent(this.botId, note); } catch { /* posting.ts logs its own problems */ }
      return;
    }
    const last = this.notes[this.notes.length - 1];
    if (last && last.kind === kind && last.origin === origin && Date.now() - last.at < 3000) return; // one note per gesture
    this.notes.push({ at: Date.now(), kind, label, origin });
    if (this.notes.length > 20) this.notes.shift();
    if (kind === 'passed') purchaseUsed(this.botId);
  }

  /** The tab the bot is looking at: a visible page, the most recently changed one if several. */
  async activePage(): Promise<Sess | null> {
    const pages = [...this.sessions.values()].filter((s) => s.type === 'page');
    await Promise.all(pages.map((s) => s.ready));
    let best: { s: Sess; score: number } | null = null;
    for (const s of pages) {
      const v = await this.cdp.send('Runtime.evaluate', { expression: 'document.visibilityState + (document.hasFocus() ? ":f" : "")', returnByValue: true }, s.id, 3000).catch(() => null);
      const val = String(v?.result?.value ?? '');
      const score = (val.startsWith('visible') ? 2 : 0) + (val.endsWith(':f') ? 1 : 0);
      if (!best || score > best.score || (score === best.score && s.at > best.s.at)) best = { s, score };
    }
    return best?.s ?? null;
  }

  /** The page session and every frame session below it. */
  tree(page: Sess): Sess[] {
    const out = [page];
    for (let i = 0; i < out.length; i++) for (const s of this.sessions.values()) if (s.parent === out[i].id && !out.includes(s)) out.push(s);
    return out;
  }

  guardContexts(page: Sess): Ctx[] {
    const ids = new Set(this.tree(page).map((s) => s.id));
    return [...this.contexts.values()].filter((c) => ids.has(c.session));
  }

  /** The guard world of the top frame of a page. */
  async topContext(page: Sess): Promise<Ctx | null> {
    const tree = await this.cdp.send('Page.getFrameTree', {}, page.id).catch(() => null);
    const top = tree?.frameTree?.frame?.id;
    return [...this.contexts.values()].find((c) => c.session === page.id && c.frameId === top) ?? null;
  }

  /** Send the bot's publish hold state into one guard context. */
  async pushPublish(ctx: Ctx) {
    const st = publishStateOf(this.botId);
    if (!st.on && !st.dry) return;
    await this.call(ctx, `g.setPublish(${JSON.stringify(JSON.stringify(st))})`).catch(() => undefined);
  }

  /** Send what kinds of action are allowed into one guard context. */
  async pushKinds(ctx: Ctx) {
    if (!this.kindState) return;
    await this.call(ctx, `g.setKinds && g.setKinds(${JSON.stringify(this.kindState)})`).catch(() => undefined);
  }

  async call(ctx: Ctx, expr: string): Promise<Json> {
    const r = await this.cdp.send('Runtime.evaluate', { expression: `(() => { const g = window.__cleftGuard; return g ? (${expr}) : { noguard: true }; })()`, contextId: ctx.id, returnByValue: true, awaitPromise: true }, ctx.session, 6000);
    if (r?.exceptionDetails) throw new Error('The page check failed.');
    return r?.result?.value;
  }
}

const watches = new Map<string, Watch>();
const connecting = new Map<string, Promise<Watch | null>>();

/** The DevTools address of a bot's Chrome, if it has a screen on this machine. */
function botCdp(botId: string): string | null {
  const s = db.prepare('SELECT screen_id FROM screens WHERE bot_id=?').get(botId) as { screen_id?: string } | undefined;
  if (!s?.screen_id) return process.env.CLEFT_GUARD_CDP_URL || null; // tests point at a Chrome of their own
  return process.env.CLEFT_GUARD_CDP_URL || cdpUrlFor(botId, s.screen_id);
}

/** Connect (or reuse the connection) to a bot's Chrome. Null when it has no browser running. */
export async function watchFor(botId: string): Promise<Watch | null> {
  const have = watches.get(botId);
  if (have && !have.cdp.closed) return have;
  watches.delete(botId);
  const busy = connecting.get(botId);
  if (busy) return busy;
  const p = (async () => {
    const base = botCdp(botId);
    if (!base) return null;
    let ws: WebSocket | null = null;
    try {
      const v = await fetch(`${base.replace(/\/$/, '')}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()) as { webSocketDebuggerUrl?: string };
      if (!v.webSocketDebuggerUrl) return null;
      ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
      const sock = ws;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => { sock.once('open', () => resolve()); sock.once('error', reject); timer = setTimeout(() => reject(new Error('timeout')), 3000); });
      } finally { clearTimeout(timer); }
      const w = new Watch(botId, new Cdp(ws));
      await w.start();
      // Give attach events a moment to arrive for pages that were already open.
      await new Promise((r) => setTimeout(r, 150));
      watches.set(botId, w);
      return w;
    } catch {
      // A socket that timed out or failed to start is closed, not left open to Chrome.
      try { ws?.terminate(); } catch { /* gone */ }
      return null;
    } finally {
      connecting.delete(botId);
    }
  })();
  connecting.set(botId, p);
  return p;
}

/** Push a bot's publish hold state into every page it has open now (new pages get it as they load). */
export async function pushPublishState(botId: string): Promise<void> {
  const w = watches.get(botId);
  if (!w || w.cdp.closed) return;
  const st = publishStateOf(botId);
  await Promise.all([...w.contexts.values()].map((c) => w.call(c, `g.setPublish(${JSON.stringify(JSON.stringify(st))})`).catch(() => undefined)));
}

/** What the composer on the bot's current tab shows (posting.ts dry runs). Null without a guarded page. */
export async function readPost(botId: string): Promise<{ origin: string; platform: string; texts: string[]; hashes: string[]; files: string[] } | null> {
  const w = await watchFor(botId);
  if (!w) return null;
  const page = await w.activePage();
  if (!page) return null;
  await page.ready;
  const top = await waitFor(() => w.topContext(page));
  if (!top) return null;
  const r = await w.call(top, 'g.readPost()').catch(() => null);
  return r && !r.noguard ? r : null;
}

/**
 * The browser's cookies for some sites, by name, domain and expiry only (never values), for the sign-in
 * check (posting.ts checkSignins). Null when the bot's browser is not running.
 */
export async function cookieFacts(botId: string, domains: RegExp): Promise<{ name: string; domain: string; expires: number; session: boolean }[] | null> {
  const w = await watchFor(botId);
  if (!w) return null;
  // The default profile, plus any other browser contexts (windows opened in a separate profile).
  const ctxs = await w.cdp.send('Target.getBrowserContexts', {}).catch(() => null);
  const all: Json[] = [];
  let any = false;
  for (const id of [undefined, ...((ctxs?.browserContextIds as string[] | undefined) ?? [])]) {
    const r = await w.cdp.send('Storage.getCookies', id ? { browserContextId: id } : {}).catch(() => null);
    if (r?.cookies) { any = true; all.push(...r.cookies); }
  }
  if (!any) return null;
  return all.filter((c) => domains.test(String(c.domain ?? ''))).map((c) => ({ name: String(c.name), domain: String(c.domain), expires: Number(c.expires) || -1, session: !!c.session }));
}

export function stopWatch(botId: string) { watches.get(botId)?.cdp.close(); watches.delete(botId); }

// ------------------------------------------------------------------ reading the page

export interface PageRead {
  origin: string; url: string; title: string; site: string;
  total: { amount: string; currency: string; text: string; label: string } | null;
  card: { brand: string; last4: string } | null;
  items: string[]; shipping: string; shipTo: string; recurring: string;
  controls: string[]; cardFields: boolean; captcha: boolean;
  /** Buttons that delete, send, share, post or change a password (action-kinds.ts), as the guard read them. */
  kindControls?: { k: Exclude<ActionKind, 'pay'>; l: string }[];
  /** Payment frames inside the page (PayPal, Stripe...): their origins. */
  processors: string[];
}

/** What the bot's current tab shows, read by the guard (never by the bot). Null when no guarded page is up. */
export async function readPage(botId: string): Promise<PageRead | null> {
  const w = await watchFor(botId);
  if (!w) return null;
  const page = await w.activePage();
  if (!page) return null;
  await page.ready;
  const top = await waitFor(() => w.topContext(page));
  if (!top) return null;
  const r = await w.call(top, 'g.read()').catch(() => null);
  if (!r || r.noguard) return null;
  const processors: string[] = [];
  for (const c of w.guardContexts(page)) {
    if (c === top) continue;
    const f = await w.call(c, 'g.read()').catch(() => null);
    if (f?.processor) processors.push(f.origin);
    if (f?.controls?.length) r.controls.push(...f.controls.map((l: string) => `${l} (${f.origin})`));
    if (Array.isArray(f?.kindControls) && f.kindControls.length) r.kindControls = [...(r.kindControls ?? []), ...f.kindControls].slice(0, 8);
    if (f?.captcha) r.captcha = true;
    if (f?.cardFields) r.cardFields = true;
  }
  return { ...r, processors: [...new Set(processors)] } as PageRead;
}

async function waitFor<T>(fn: () => Promise<T | null>, ms = 2500): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** The key a purchase approval binds to (the same as the guard's stateKey). */
export const purchaseKey = (r: PageRead) => [r.origin, r.total?.amount ?? '', r.total?.currency ?? '', r.card?.last4 ?? ''].join('|');

/** A page where something could be bought with one more click. */
export const isPayPage = (r: PageRead | null) => !!r && (r.controls.length > 0 || r.cardFields || r.processors.length > 0);

// ------------------------------------------------------------------ purchase approvals

/** Approved purchases, by bot: what was approved and until when (armed in the page too). */
const armed = new Map<string, { key: string; until: number; approvalId: string }>();
export const PURCHASE_ARM_MS = 3 * 60_000;

function purchaseUsed(botId: string) { armed.delete(botId); }

export function purchaseArmed(botId: string): boolean {
  const a = armed.get(botId);
  if (a && a.until < Date.now()) armed.delete(botId);
  return !!armed.get(botId);
}

/**
 * After the person approved: read the page again and arm the guard only if it still shows what the card
 * showed. Returns null when armed, else why not.
 */
export async function armPurchase(botId: string, approvalId: string, key: string): Promise<string | null> {
  const w = await watchFor(botId);
  if (!w) return 'The browser could not be reached.';
  const now = await readPage(botId);
  if (!now) return 'The checkout page is no longer open.';
  if (purchaseKey(now) !== key) return `The checkout changed since the card was shown (now ${now.total ? `${now.total.text}` : 'no total'} on ${now.origin}${now.card?.last4 ? `, card ending ${now.card.last4}` : ''}).`;
  const page = await w.activePage();
  if (!page) return 'The checkout page is no longer open.';
  const top = await w.topContext(page);
  let ok = false;
  for (const c of w.guardContexts(page)) {
    const r = await w.call(c, `g.arm(${JSON.stringify(c === top ? key : '*')}, ${PURCHASE_ARM_MS})`).catch(() => false);
    if (c === top) ok = r === true;
  }
  if (!ok) return 'The guard on the checkout page could not be armed.';
  armed.set(botId, { key, until: Date.now() + PURCHASE_ARM_MS, approvalId });
  return null;
}

export async function disarmPurchase(botId: string) {
  armed.delete(botId);
  const w = watches.get(botId);
  if (!w) return;
  for (const c of w.contexts.values()) await w.call(c, 'g.disarm()').catch(() => undefined);
}

// ------------------------------------------------------------------ kinds of action (action-kinds.ts)

/** The last press of a kind the guard held, per bot: what request_action_approval asks about. */
const heldKinds = new Map<string, GuardNote>();
/** An "Allow once" for a kind on a site, per bot, until it is used or runs out. */
const onceKinds = new Map<string, { kind: ActionKind; site: string; until: number }>();
/** The chat whose turn last used the browser, per bot: its "Allow for this conversation" answers count. */
const kindChat = new Map<string, string>();
/** Bots whose screen a person has taken control of (vnc.ts), with how many control viewers are open. */
const personControl = new Map<string, number>();
export const KIND_ONCE_MS = 2 * 60_000;

/** The held press request_action_approval asks about: the newest within ten minutes. */
export function lastHeldKind(botId: string): GuardNote | null {
  const n = heldKinds.get(botId);
  return n && Date.now() - n.at < 10 * 60_000 ? n : null;
}

/** What the pages are told: the person's control, the kinds allowed on which sites, and an armed "once". */
function kindStateFor(botId: string, chatId: string | undefined): string {
  const keys = new Set<string>();
  const rules = db.prepare("SELECT tool FROM allow_rules WHERE bot_id=? AND tool LIKE 'browser_kind__%'").all(botId) as { tool: string }[];
  for (const r of rules) keys.add(r.tool.toLowerCase());
  for (const k of conversationKindKeys(chatId)) keys.add(k.toLowerCase());
  const allow = [...keys].map(parseBrowserKindKey).filter((x): x is { kind: ActionKind; site: string } => !!x && x.kind !== 'credentials').map((x) => ({ k: x.kind, s: x.site }));
  const once = onceKinds.get(botId);
  const live = once && once.until > Date.now() ? once : null;
  if (once && !live) onceKinds.delete(botId);
  return JSON.stringify({ control: (personControl.get(botId) ?? 0) > 0, allow, ...(live ? { once: { k: live.kind, s: live.site, ms: live.until - Date.now() } } : { keepOnce: false }) });
}

/** Tell every open page of this bot's browser what is allowed now (only when it changed, unless `force`). */
export async function refreshKindState(botId: string, chatId?: string, force = false): Promise<void> {
  if (chatId) kindChat.set(botId, chatId);
  const w = watches.get(botId);
  if (!w) return;
  const st = kindStateFor(botId, kindChat.get(botId));
  if (!force && st === w.kindState) return;
  w.kindState = st;
  await Promise.all([...w.contexts.values()].map((c) => w.pushKinds(c)));
}

/** After "Allow once" on a kind's card: the next press of that kind on that site goes through, within two minutes. */
export async function armKindOnce(botId: string, kind: ActionKind, site: string, chatId?: string): Promise<void> {
  onceKinds.set(botId, { kind, site: siteOf(site), until: Date.now() + KIND_ONCE_MS });
  await refreshKindState(botId, chatId, true);
}

/** vnc.ts: a person took control of (or let go of) this bot's screen. Their own presses are never held. */
export function setPersonControl(botId: string, on: boolean) {
  const n = Math.max(0, (personControl.get(botId) ?? 0) + (on ? 1 : -1));
  if (n) personControl.set(botId, n); else personControl.delete(botId);
  void refreshKindState(botId).catch(() => undefined);
}

// ------------------------------------------------------------------ secure input

export type FieldKind = 'password' | 'username' | 'email' | 'one_time_code' | 'card_number' | 'card_expiry' | 'card_cvc' | 'other' | 'service_key';
export const FIELD_KINDS: FieldKind[] = ['password', 'username', 'email', 'one_time_code', 'card_number', 'card_expiry', 'card_cvc', 'other'];

export interface FieldLoc {
  session: string; contextId: number; stamp: string; boxes: number;
  label: string; type: string; origin: string; topOrigin: string; pageUrl: string; targetId: string;
}

/** Find the field for a secure input on the bot's current tab, in the page or any of its frames. */
export async function findField(botId: string, kind: FieldKind, hint: string): Promise<FieldLoc | { error: string }> {
  const w = await watchFor(botId);
  if (!w) return { error: 'Your browser is not running, so there is no page to fill.' };
  const page = await w.activePage();
  if (!page) return { error: 'No page is open in your browser.' };
  await page.ready;
  const top = await waitFor(() => w.topContext(page));
  if (!top) return { error: 'The page is still loading. Wait for it, then ask again.' };
  const topRead = await w.call(top, 'g.read()').catch(() => null);
  let best: { ctx: Ctx; f: Json } | null = null;
  for (const c of w.guardContexts(page)) {
    const f = await w.call(c, `g.find(${JSON.stringify(kind)}, ${JSON.stringify(hint.slice(0, 60))})`).catch(() => null);
    if (f && !f.noguard && typeof f.score === 'number' && (!best || f.score > best.f.score)) best = { ctx: c, f };
  }
  if (!best) return { error: `No ${kind.replace(/_/g, ' ')} field is showing on ${topRead?.origin ?? 'the page'}. Open the page with that field first.` };
  return {
    session: best.ctx.session, contextId: best.ctx.id, stamp: String(best.f.stamp), boxes: Math.max(1, Number(best.f.boxes) || 1),
    label: String(best.f.label ?? ''), type: String(best.f.type ?? ''), origin: String(best.f.origin ?? ''),
    topOrigin: String(topRead?.origin ?? ''), pageUrl: String(topRead?.url ?? ''), targetId: page.targetId,
  };
}

/**
 * Type the person's value into the field found earlier. The page and frame must still be the ones the
 * card showed. Returns null when filled, else why not (never the value). The caller drops the value after.
 */
export async function fillField(botId: string, loc: FieldLoc, value: string): Promise<string | null> {
  const w = watches.get(botId);
  if (!w || w.cdp.closed) return 'The browser connection was lost.';
  const ctx = w.contexts.get(`${loc.session}:${loc.contextId}`);
  if (!ctx) return 'The page changed (it navigated or reloaded) since the card was shown. Nothing was typed.';
  const page = [...w.sessions.values()].find((s) => s.targetId === loc.targetId);
  const top = page ? await w.topContext(page) : null;
  const topRead = top ? await w.call(top, 'g.read()').catch(() => null) : null;
  if (!topRead || topRead.origin !== loc.topOrigin) return `The page is no longer ${loc.topOrigin}. Nothing was typed.`;
  const parts = loc.boxes > 1 ? [...value].slice(0, loc.boxes) : [value];
  for (let i = 0; i < parts.length; i++) {
    const f = await w.call(ctx, `g.focus(${JSON.stringify(loc.stamp)}, ${i})`).catch(() => null);
    if (!f?.ok) return `The field could not be used (${f?.why ?? 'page check failed'}). Nothing was typed.`;
    if (f.origin !== loc.origin) return `The field is no longer on ${loc.origin}. Nothing was typed.`;
    await w.cdp.send('Input.insertText', { text: parts[i] }, ctx.session);
  }
  const want = loc.boxes > 1 ? 1 : value.replace(/[\s-]/g, '').length;
  const chk = await w.call(ctx, `g.check(${JSON.stringify(loc.stamp)}, ${want}, 0)`).catch(() => null);
  await w.call(ctx, `g.unstamp(${JSON.stringify(loc.stamp)})`).catch(() => undefined);
  return chk?.ok ? null : 'The field did not take the value (the page may have cleared it). Ask for it again.';
}

// ------------------------------------------------------------------ masking entered values

const SALT = crypto.randomBytes(16).toString('hex');
const scrubs = new Map<string, { hash: string; len: number; until: number }[]>();

/** Remember, as a salted hash only, a value typed into a page, so later results echoing it can be masked. */
export function rememberToScrub(botId: string, value: string) {
  const v = value.trim();
  if (v.length < 4) return;
  const list = (scrubs.get(botId) ?? []).filter((s) => s.until > Date.now());
  list.push({ hash: crypto.createHash('sha256').update(SALT + v).digest('hex'), len: v.length, until: Date.now() + 3600_000 });
  scrubs.set(botId, list.slice(-20));
}

/** Whether a value is one the person entered through a secure-input card in the last hour. */
export function isRememberedSecret(botId: string, value: string): boolean {
  const v = value.trim();
  if (v.length < 4) return false;
  const h = crypto.createHash('sha256').update(SALT + v).digest('hex');
  return (scrubs.get(botId) ?? []).some((s) => s.until > Date.now() && s.hash === h);
}

/** Run a DevTools call on every page and frame session of a bot's Chrome now (teach.ts). Returns how many there were. */
export async function forEachSession(botId: string, fn: (session: string, send: Send) => Promise<void>): Promise<number> {
  const w = await watchFor(botId);
  if (!w) return -1;
  const list = [...w.sessions.values()];
  await Promise.all(list.map(async (s) => { await s.ready; await fn(s.id, (m, p = {}) => w.cdp.send(m, p, s.id).catch(() => undefined)).catch(() => undefined); }));
  return list.length;
}

export function scrubList(botId: string): { salt: string; items: { hash: string; len: number }[] } | null {
  const list = (scrubs.get(botId) ?? []).filter((s) => s.until > Date.now());
  scrubs.set(botId, list);
  return list.length ? { salt: SALT, items: list.map(({ hash, len }) => ({ hash, len })) } : null;
}

/** Notes for the bot since its last browser step (held pay buttons, CAPTCHAs). Taken once. */
export function takeNotes(botId: string): GuardNote[] {
  const w = watches.get(botId);
  if (!w || !w.notes.length) return [];
  const out = w.notes.splice(0);
  return out.filter((n) => Date.now() - n.at < 10 * 60_000);
}

export function notesText(notes: GuardNote[]): string {
  const lines: string[] = [];
  for (const n of notes) {
    if (n.kind === 'held') lines.push(`[Cleft guard] The "${n.label ?? 'pay'}" control on ${n.origin} was held: nothing was bought. Before anything is paid, call request_purchase_approval so the person sees the total, card and merchant; after they approve, click it again.`);
    else if (n.kind === 'changed') lines.push(`[Cleft guard] The checkout on ${n.origin} changed after it was approved (total, card or site), so the "${n.label ?? 'pay'}" click was held and nothing was bought. Call request_purchase_approval again.`);
    else if (n.kind === 'passed') lines.push(`[Cleft guard] The approved purchase click on ${n.origin} went through. Check the page for the order confirmation and tell the person.`);
    else if (n.kind === 'pub_held') lines.push(`[Cleft guard] The "${n.label ?? 'Post'}" press on ${n.origin} was held: nothing was published. Only captions on a posting plan the person approved can go out (request_posting_approval). If the caption was approved, the text in the box must match it exactly; if you changed it, ask again.`);
    else if (n.kind === 'pub_dry') lines.push(`[Cleft guard] Dry run: you reached the final "${n.label ?? 'Post'}" button on ${n.origin}. It was held; nothing was published.`);
    else if (n.kind === 'published') lines.push(`[Cleft guard] The approved "${n.label ?? 'Post'}" press on ${n.origin} went through. Check the page shows it scheduled or posted, then call posting_status to record it.`);
    else if (n.kind === 'kind_held') lines.push(n.action === 'credentials'
      ? `[Cleft guard] The "${n.label ?? 'change password'}" press on ${n.site ?? n.origin} was held: changing a password or security setting on a website is the person's to do. Call request_action_approval so they get a card to do it themselves. Do not try to press it again another way.`
      : `[Cleft guard] The "${n.label ?? KIND_NAME[n.action ?? 'send']}" press on ${n.site ?? n.origin} was held, so nothing was ${n.action === 'delete' ? 'deleted' : n.action === 'share' ? 'shared' : n.action === 'post' ? 'posted' : 'sent'}: it ${n.action === 'delete' ? 'deletes something' : n.action === 'share' ? 'shares something with other people' : n.action === 'post' ? 'posts or publishes something' : 'sends something to other people'}, so the person decides. Call request_action_approval with one line on exactly what it does; after they allow it, press it again. Do not try another way round (scripts, other buttons, keyboard shortcuts).`);
    else if (n.kind === 'kind_passed' && n.via === 'once') lines.push(`[Cleft guard] The allowed "${n.label ?? 'press'}" on ${n.site ?? n.origin} went through. Check the page shows it done and tell the person.`);
    else if (n.kind === 'captcha') lines.push(`[Cleft guard] ${n.origin} is showing a CAPTCHA. Do not try to solve it: call ask_for_help_on_screen so the person can do it on your screen.`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ the gate backstop

/** DevTools calls that only look. Anything else on a pay page waits for an approval. */
const CDP_LOOKS = /^(DOM\.(get|describe|query|resolve|request|performSearch|getSearchResults|discardSearchResults)\w*|Page\.(captureScreenshot|getFrameTree|getLayoutMetrics|getNavigationHistory|getResourceTree)|Accessibility\.\w+|CSS\.get\w+|Network\.get\w+|Target\.get\w+|Browser\.getVersion|Runtime\.getProperties|DOMSnapshot\.captureSnapshot)$/;
/** browser_exec code that could press, submit, run page script or send requests. */
const EXEC_ACTS = /(click|tap\b|press|keyboard|mouse|submit|evaluate|execute_?script|run_?js|\bjs\s*\(|dispatch|fetch|xmlhttprequest|sendbeacon|\bcdp\s*\(|send_?cdp|\.send\s*\(|Input\.|Runtime\.|\beval\b|\bexec\b|\bimport\b|__|getattr|globals|chr\s*\(|base64|b64|decode|\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|requests\.|urllib|socket)/i;

/**
 * Before a browser tool runs: on a page where one more click could pay, tools that can act wait for an
 * armed purchase approval. Covers ways round the in-page guard (form.submit(), fetch, raw DevTools input).
 */
export async function gateBrowserTool(botId: string, tool: string, args: Json, chatId?: string): Promise<{ block: string } | null> {
  // Every browser step makes sure the guard is in the bot's Chrome, so pay buttons are held from the first page.
  const w = await watchFor(botId).catch(() => null);
  // ...and that its pages know which kinds of action the person allowed for the chat making this step.
  if (w) await refreshKindState(botId, chatId).catch(() => undefined);
  if (tool !== 'browser_exec' && tool !== 'browser_cdp') return null;
  // Script and raw DevTools steps go around the in-page holds, so they wait while the guard cannot be put in.
  if (!w) return { block: 'The browser guard could not reach this browser just now, so script and DevTools steps wait. Try again in a moment, or click and type normally.' };
  // A DevTools call aimed at another tab is checked against that tab's page, which is not read here:
  // only looking is allowed there unless a purchase was approved.
  if (tool === 'browser_cdp' && (args?.sessionId || args?.targetId) && !CDP_LOOKS.test(String(args?.method ?? '')) && (!purchaseArmed(botId) || publishStateOf(botId).on)) {
    return { block: 'DevTools steps that change a page work only on the tab you are looking at. Switch to that tab first, then try again.' };
  }
  const pubBlock = await gatePublish(botId, tool, args).catch(() => null);
  if (pubBlock) return pubBlock;
  const kindBlock = await gateKinds(botId, tool, args, chatId).catch(() => null);
  if (kindBlock) return kindBlock;
  if (purchaseArmed(botId)) return null;
  const read = await readPage(botId).catch(() => null);
  if (!isPayPage(read)) return null;
  if (tool === 'browser_cdp') {
    const method = String(args?.method ?? '');
    if (CDP_LOOKS.test(method)) return null;
  } else {
    const code = String(args?.code ?? args?.script ?? JSON.stringify(args ?? {}));
    if (!EXEC_ACTS.test(code)) return null;
  }
  return { block: `This page (${read!.origin}) can take a payment with one more step, so the browser only looks until a purchase is approved. Call request_purchase_approval: the person sees the total, card and merchant read from the page. Until then use page_info() or capture_screenshot() to look. After they approve you have 3 minutes to place the order. To fill a card number, CVC or password, call ask_secure_input; never type those yourself.` };
}

/**
 * Script and raw DevTools steps go around the in-page kinds hold: on a page that shows a Send, Delete, Share,
 * Post or change-password button, an acting one waits until the person allowed that kind on that site (for
 * the conversation or always). Looking is always fine.
 */
async function gateKinds(botId: string, tool: string, args: Json, chatId?: string): Promise<{ block: string } | null> {
  if ((personControl.get(botId) ?? 0) > 0) return null;
  const acts = tool === 'browser_cdp' ? !CDP_LOOKS.test(String(args?.method ?? '')) : EXEC_ACTS.test(String(args?.code ?? args?.script ?? JSON.stringify(args ?? {})));
  if (!acts) return null;
  const read = await readPage(botId).catch(() => null);
  const controls = read?.kindControls ?? [];
  if (!read || !controls.length) return null;
  const site = siteOf(read.origin);
  const open = controls.filter((c) => c.k === 'credentials' || !standingAllow(botId, chatId, browserKindKey(c.k, site)));
  if (!open.length) return null;
  const names = [...new Set(open.map((c) => `"${c.l}"`))].slice(0, 3).join(', ');
  return { block: `This page (${site}) has ${names}, which the person decides on, so script and DevTools steps that could press it are refused here. Click the button itself: if it is held, call request_action_approval. Use page_info() or capture_screenshot() to look.` };
}

/** Ways round the in-page publish hold: script-made submits and requests, synthetic events, raw network. */
const PUB_BYPASS_EXEC = /(fetch\s*\(|xmlhttprequest|sendbeacon|requestsubmit|\.submit\s*\(|dispatchevent|new\s+(mouse|pointer|keyboard)?event|graphql|\/api\/graphql|create_?tweet|atob\s*\(|fromcharcode|\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|requests\.|urllib|socket)/i;
const PUB_BYPASS_CDP = /^(Fetch\.|Network\.(replayXHR|loadNetworkResource)|Runtime\.(evaluate|callFunctionOn|compileScript|runScript)|Page\.(addScriptToEvaluateOnNewDocument|createIsolatedWorld)|DOM\.(set\w*|remove\w*|moveTo|copyTo|undo|redo)$|CSS\.(set\w*|add\w*|createStyleSheet)$)/;
const SOCIAL_HOST = /(^|\.)(facebook\.com|instagram\.com|youtube\.com|x\.com|twitter\.com|tiktok\.com|linkedin\.com|threads\.net|threads\.com)$/i;

/**
 * For bots with the publish hold on, on a social site: refuse browser steps that could post without a real
 * press on the page (form.requestSubmit(), fetch to the site's API, synthetic events, raw script through
 * DevTools). Clicking and typing go through the in-page hold, which checks the caption.
 */
async function gatePublish(botId: string, tool: string, args: Json): Promise<{ block: string } | null> {
  if (!publishStateOf(botId).on) return null;
  const read = await readPage(botId).catch(() => null);
  let host = '';
  try { host = read ? new URL(read.origin).hostname : ''; } catch { /* none */ }
  if (!host || !SOCIAL_HOST.test(host)) return null;
  const bad = tool === 'browser_cdp' ? PUB_BYPASS_CDP.test(String(args?.method ?? '')) : PUB_BYPASS_EXEC.test(String(args?.code ?? args?.script ?? JSON.stringify(args ?? {})));
  if (!bad) return null;
  return { block: `On ${host} posts go out only by pressing the site's own Post / Share / Schedule button, and only for captions on an approved posting plan. Script-made submits, requests and raw DevTools script are refused here. Click and type normally; use page_info() or capture_screenshot() to look.` };
}
