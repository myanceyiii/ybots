import { setPersonControl } from './browser-guard.js';
import type { IncomingMessage, Server } from 'node:http';
import net from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { env } from './env.js';
import { vncTarget } from './local-computer.js';
import { isSilo, siloVnc } from './silo.js';
import { db } from './db.js';
import { isSameOriginRequest, sessionAgent, sessionPerson, tokenFromCookieHeader, userFromCookieHeader, userFromToken } from './lib/auth.js';
import { scopeFor } from './lib/scope.js';
import { machineViewable, openMachineScreen } from './machines.js';
import { vncAuthResponse } from './lib/des.js';
import { orgo } from './orgo.js';
import { readyScreen, screenFor } from './computer.js';
import { viewerClosed, viewerOpened } from './idle.js';

/**
 * VNC relay: browser <-> our server <-> Orgo websockify, or <-> x11vnc on this machine (COMPUTER=local).
 * The server performs the RFB handshake upstream with the computer's VNC password
 * (which is root-equivalent and never reaches the browser), then offers the browser
 * an unauthenticated RFB session. In "watch" mode, client input messages
 * (KeyEvent, PointerEvent, ClientCutText) are dropped server-side.
 */

const QUEUE_MAX = 64 * 1024 * 1024;
/** Longest clipboard text a viewer may send (it is dropped anyway, but its bytes are held until whole). */
const CUT_MAX = 1024 * 1024;

class ByteQueue {
  private buf = Buffer.alloc(0);
  private waiters: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  private closed: Error | null = null;
  push(b: Buffer) {
    if (this.closed) return;
    // A peer that sends far more than anyone reads is stuck or hostile: stop holding it in memory.
    if (this.buf.length + b.length > QUEUE_MAX) { this.buf = Buffer.alloc(0); this.close(new Error('Screen sent too much at once')); return; }
    this.buf = Buffer.concat([this.buf, b]); this.drain();
  }
  close(e: Error) { this.closed = e; for (const w of this.waiters) w.reject(e); this.waiters = []; }
  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(this.closed);
      this.waiters.push({ n, resolve, reject });
      this.drain();
    });
  }
  /** Empty and usable again (a fresh connection after a failed one). */
  reset() { this.buf = Buffer.alloc(0); this.closed = null; this.waiters = []; }
  takeAll(): Buffer { const b = this.buf; this.buf = Buffer.alloc(0); return b; }
  private drain() {
    while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
      const w = this.waiters.shift()!;
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(Buffer.from(out));
    }
  }
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

async function upstreamHandshake(q: ByteQueue, send: (b: Buffer) => void, password: string): Promise<Buffer> {
  await q.read(12); // server ProtocolVersion
  send(Buffer.from('RFB 003.008\n'));
  const n = (await q.read(1))[0];
  if (n === 0) {
    const len = (await q.read(4)).readUInt32BE();
    throw new Error(`VNC refused: ${(await q.read(len)).toString()}`);
  }
  const types = [...(await q.read(n))];
  const choice = types.includes(2) ? 2 : types.includes(1) ? 1 : -1;
  if (choice < 0) throw new Error(`Unsupported VNC security types: ${types.join(',')}`);
  send(Buffer.from([choice]));
  if (choice === 2) {
    const challenge = await q.read(16);
    send(vncAuthResponse(password, challenge));
  }
  const result = (await q.read(4)).readUInt32BE();
  if (result !== 0) {
    let reason = '';
    try { const len = (await q.read(4)).readUInt32BE(); reason = (await q.read(len)).toString(); } catch { /* none */ }
    throw new Error(`VNC auth failed ${reason}`);
  }
  send(Buffer.from([1])); // ClientInit: shared
  const head = await q.read(24); // w,h,pixfmt(16),nameLen
  const nameLen = head.readUInt32BE(20);
  const name = await q.read(nameLen);
  return Buffer.concat([head, name]);
}

/**
 * The viewer's side of the handshake up to its ClientInit. It needs nothing from the VNC server, so it runs
 * while the server side is still being set up: the viewer hears from us at once instead of waiting in
 * silence, and the two handshakes overlap. The caller sends ServerInit after.
 */
async function browserGreeting(q: ByteQueue, send: (b: Buffer) => void) {
  // A viewer that never answers must not hold the screen open forever.
  const t = setTimeout(() => q.close(new Error('The viewer did not answer')), 15_000);
  try { await greet(q, send); } finally { clearTimeout(t); }
}

async function greet(q: ByteQueue, send: (b: Buffer) => void) {
  send(Buffer.from('RFB 003.008\n'));
  await q.read(12);
  send(Buffer.from([1, 1])); // one security type: None
  await q.read(1);
  send(u32(0)); // SecurityResult OK
  await q.read(1); // ClientInit
}

/**
 * Pings the viewer every 20 s and drops a connection that stops answering. Proxies on the way (Cloudflare,
 * Tailscale Serve, a phone's network) close a WebSocket that carries nothing for a while, and a still screen
 * sends nothing; a dead link is found within 45 s instead of hanging. Returns the stop function.
 */
export function keepAlive(ws: WebSocket, everyMs = 20_000): () => void {
  let answered = true;
  ws.on('pong', () => { answered = true; });
  const t = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!answered) { ws.terminate(); return; }
    answered = false;
    try { ws.ping(); } catch { /* closing */ }
  }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

/** One line per screen connection when it ends, so a flaky view can be told apart from a broken one. */
function logEnd(what: string, started: number, stage: string, how: string) {
  const ms = Date.now() - started;
  // A watched screen that ran for a while and was closed by its viewer is the normal case: keep it short.
  if (stage === 'live' && how.startsWith('viewer closed')) console.log(`[vnc] ${what}: ${how} after ${Math.round(ms / 1000)} s`);
  else console.warn(`[vnc] ${what}: ${how} after ${ms} ms (${stage})`);
}

/**
 * Filters a client->server RFB stream, dropping input events (and with `allowInput`, still the
 * clipboard, which a PC never takes from a viewer). Returns bytes to forward.
 */
class WatchFilter {
  private pending = Buffer.alloc(0);
  constructor(private allowInput = false) {}
  feed(chunk: Buffer): Buffer {
    this.pending = Buffer.concat([this.pending, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      const b = this.pending;
      if (!b.length) break;
      const len = msgLength(b);
      if (len === -1) { this.pending = Buffer.alloc(0); break; } // unknown: fail closed
      if (len === 0 || b.length < len) break; // need more bytes
      const msg = b.subarray(0, len);
      const t = b[0];
      if (t === 6 || ((t === 4 || t === 5) && !this.allowInput)) { /* dropped */ } else out.push(Buffer.from(msg));
      this.pending = b.subarray(len);
    }
    return Buffer.concat(out);
  }
}

/** Length of the client message at the head of `b`, 0 if more bytes are needed to know, -1 if unknown. */
function msgLength(b: Buffer): number {
  const t = b[0];
  switch (t) {
    case 0: return 20; // SetPixelFormat
    case 2: return b.length < 4 ? 0 : 4 + 4 * b.readUInt16BE(2); // SetEncodings
    case 3: return 10; // FramebufferUpdateRequest
    case 4: return 8; // KeyEvent
    case 5: return 6; // PointerEvent
    case 6: { // ClientCutText (+extended); an oversized one is refused rather than buffered
      if (b.length < 8) return 0;
      const n = Math.abs(b.readInt32BE(4));
      return n > CUT_MAX ? -1 : 8 + n;
    }
    case 150: return 10; // EnableContinuousUpdates
    case 248: return b.length < 9 ? 0 : 9 + b[8]; // ClientFence
    case 251: return b.length < 8 ? 0 : 8 + 16 * b[6]; // SetDesktopSize
    default: return -1;
  }
}

/** Close a screen or dictation socket once its session is signed out (Settings > Devices, sign out others). */
export function endWhenSignedOut(client: WebSocket, token: string | undefined) {
  if (!token) return;
  const t = setInterval(() => { if (!userFromToken(token)) { clearInterval(t); try { client.close(4401, 'signed out'); } catch { /* gone */ } } }, 30_000);
  t.unref?.();
  client.once('close', () => clearInterval(t));
}

export function attachVncRelay(server: Server) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false) });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    try { upgrade(req, socket, head); } catch (e) {
      console.warn('[vnc] bad upgrade', String((e as Error)?.message ?? e).slice(0, 200));
      socket.destroy();
    }
  });

  function upgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/api\/bots\/([^/]+)\/screen$/);
    const pc = url.pathname.match(/^\/api\/machines\/([^/]+)\/screen$/);
    if (!m && !pc) return; // not ours
    // A page on another site must not be able to open (and in control mode, drive) a bot's screen
    // with the user's cookie: browsers send Origin on every WebSocket handshake.
    const header = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h);
    // The phone app signs in with `Authorization: Bearer <session token>`. A browser cannot put that header
    // on a WebSocket, so another site cannot ride on it: such a request is judged on its token alone.
    const bearer = /^Bearer\s+(\S+)$/i.exec(header(req.headers.authorization) ?? '')?.[1];
    if (bearer === undefined && !isSameOriginRequest(header(req.headers.origin), header(req.headers['sec-fetch-site']))) {
      console.warn(`[vnc] refused (cross-site): origin=${header(req.headers.origin) ?? '-'} sec-fetch-site=${header(req.headers['sec-fetch-site']) ?? '-'}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const user = bearer !== undefined ? userFromToken(bearer) : userFromCookieHeader(req.headers.cookie);
    // A scoped sign-in (lib/scope.ts) sees no PCs and only its own bots' screens.
    const scope = user ? scopeFor(user.id, sessionPerson(bearer ?? tokenFromCookieHeader(req.headers.cookie))) : null;
    if (scope && (pc || (m && !scope.bots.has(m[1])))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    // A script session (POST /api/auth/owner with an agent name) is never a person: it may watch a bot's
    // screen, but never take control of one or open a paired PC, where every change otherwise needs a card.
    const agent = user ? sessionAgent(bearer ?? tokenFromCookieHeader(req.headers.cookie)) : null;
    if (agent && (pc || url.searchParams.get('mode') === 'control')) {
      console.warn(`[vnc] refused (script session ${agent}): ${pc ? `pc=${pc[1]}` : `bot=${m?.[1]} control`}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (pc) {
      // A paired PC's screen: only for whoever may see that PC. Watch by default; ?mode=control takes
      // over the mouse and keyboard, which the PC must allow on its own page (docs/remote-pc.md).
      const person = sessionPerson(bearer ?? tokenFromCookieHeader(req.headers.cookie));
      if (!user || !machineViewable(pc[1], user.id, person)) {
        console.warn(`[vnc] refused (${user ? 'not your PC' : 'not signed in'}): pc=${pc[1]}`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const pcMode = url.searchParams.get('mode') === 'control' ? 'control' : 'watch';
      wss.handleUpgrade(req, socket, head, (client) => { endWhenSignedOut(client, bearer ?? tokenFromCookieHeader(req.headers.cookie)); relayPc(client, user.id, pc[1], pcMode); });
      return;
    }
    if (!m) return;
    const bot = user ? (db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(m[1], user.id) as any) : null;
    if (!user || !bot) {
      // Names only, never values: the cookie header carries the session token.
      const names = (req.headers.cookie ?? '').split(/;\s*/).map((p) => p.split('=')[0]).filter(Boolean).join(',') || '-';
      console.warn(`[vnc] refused (${user ? 'not your bot' : 'not signed in'}): bot=${m[1]} ${bearer !== undefined ? 'bearer' : `cookies=${names}`}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const mode = url.searchParams.get('mode') === 'control' ? 'control' : 'watch';
    wss.handleUpgrade(req, socket, head, (client) => { endWhenSignedOut(client, bearer ?? tokenFromCookieHeader(req.headers.cookie)); relay(client, user.id, bot.id, mode); });
  }
}

/** The VNC server end of the relay: Orgo's websockify, or a TCP connection to x11vnc here. */
interface Upstream {
  send(b: Buffer): void;
  close(): void;
  readonly open: boolean;
}

/** A plain TCP connection to a VNC server on this machine (x11vnc here, or a siloed bot's gate). */
async function connectTcp(host: string, port: number, onData: (b: Buffer) => void, onClose: (why: string) => void, password: string): Promise<{ up: Upstream; password: string }> {
  const sock = net.connect({ host, port });
  sock.on('data', (d: Buffer) => onData(d));
  sock.on('close', () => onClose('vnc closed'));
  sock.on('error', (e) => onClose(String(e.message)));
  await new Promise<void>((res, rej) => { sock.once('connect', () => res()); sock.once('error', rej); });
  return { up: { send: (b) => { sock.write(b); }, close: () => sock.destroy(), get open() { return !sock.destroyed; } }, password };
}

async function connectUpstream(computerId: string, screenId: string, onData: (b: Buffer) => void, onClose: (why: string) => void): Promise<{ up: Upstream; password: string }> {
  if (env.computer === 'local') {
    const t = await vncTarget(screenId);
    return connectTcp(t.host, t.port, onData, onClose, t.password);
  }
  const { password } = await orgo.vncPassword(computerId);
  const upUrl = `wss://www.orgo.ai/desktops/${computerId}/ws/websockify?token=${encodeURIComponent(password)}${screenId !== 'default' ? `&screen=${encodeURIComponent(screenId)}` : ''}`;
  const ws = new WebSocket(upUrl, ['binary']);
  ws.on('message', (data: Buffer) => onData(Buffer.from(data)));
  ws.on('close', (code, reason) => onClose(`upstream ${code} ${reason}`));
  ws.on('error', (e) => onClose(String(e)));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  return { up: { send: (b) => ws.send(b), close: () => ws.close(), get open() { return ws.readyState === WebSocket.OPEN; } }, password };
}

async function relay(client: WebSocket, userId: string, botId: string, mode: 'watch' | 'control') {
  const fromClient = new ByteQueue();
  const fromUp = new ByteQueue();
  let upstream: Upstream | null = null;
  let piping = false;
  let stage = 'opening the screen';
  let ended = false;
  const started = Date.now();
  const what = `screen bot=${botId} ${mode}`;
  const filter = new WatchFilter();
  const stopPings = keepAlive(client);
  const end = (how: string) => { if (!ended) { ended = true; logEnd(what, started, stage, how); } };
  const closeAll = (code = 1000, reason = '') => {
    try { client.close(code, reason.slice(0, 120)); } catch { /* */ }
    try { upstream?.close(); } catch { /* */ }
  };

  client.on('message', (data: Buffer) => {
    if (!piping) return fromClient.push(Buffer.from(data));
    const fwd = mode === 'watch' ? filter.feed(Buffer.from(data)) : Buffer.from(data);
    if (fwd.length && upstream?.open) upstream.send(fwd);
  });
  client.on('close', (code, reason) => {
    stopPings();
    end(`viewer closed (code ${code}${reason?.length ? ` ${reason.toString().slice(0, 80)}` : ''})`);
    viewerClosed(userId);
    fromClient.close(new Error('client closed'));
    try { upstream?.close(); } catch { /* */ }
  });
  viewerOpened(userId); // keeps the computer awake while someone is watching (see idle.ts)
  // A person in control presses Send or Delete themselves: the browser guard never holds their presses.
  if (mode === 'control') {
    setPersonControl(botId, true);
    client.once('close', () => setPersonControl(botId, false));
  }

  const onData = (data: Buffer) => {
    if (!piping) return fromUp.push(data);
    if (client.readyState === WebSocket.OPEN) client.send(data);
  };
  const onUpClose = (why: string) => {
    fromUp.close(new Error(why));
    if (client.readyState !== WebSocket.OPEN) return;
    end(`the screen closed (${why})`);
    // 1011 so the viewer tries again; a clean 1000 would read as "you closed it".
    closeAll(1011, piping ? 'The screen stopped sending.' : `The screen did not answer (${why}).`);
  };

  // Before piping, a closed screen fails the handshake (which then may try again); after, it ends the view.
  const upClosed = (why: string) => (piping ? onUpClose(why) : fromUp.close(new Error(why)));

  /** Connect to the VNC server and finish its handshake; with local screens, once more after restarting x11vnc. */
  const openUpstream = async (): Promise<Buffer> => {
    let tries = 0;
    for (;;) {
      // A socket from a failed try still reports its close later; only the current one counts.
      const mine = tries;
      const closed = (why: string) => { if (mine === tries) upClosed(why); };
      try {
        let conn: { up: Upstream; password: string };
        if (isSilo(botId)) {
          // The screen inside the bot's container, published on this machine's loopback by its gate.
          const t = siloVnc(botId);
          if (!t) throw new Error("This bot's container has no screen configured (SILO_BOTS vnc).");
          conn = await connectTcp(t.host, t.port, onData, closed, t.password);
        } else {
          const { computerId, screenId } = await screenFor(userId, botId);
          // A screen nobody has used yet is bare; set it up while the person is already watching.
          if (!tries) readyScreen(userId, botId).catch(() => {});
          conn = env.computer === 'local'
            ? await (async () => { const t = await vncTarget(screenId, { restart: tries > 0 }); return connectTcp(t.host, t.port, onData, closed, t.password); })()
            : await connectUpstream(computerId, screenId, onData, closed);
        }
        upstream = conn.up;
        if (ended) { conn.up.close(); throw new Error('client closed'); }
        stage = 'VNC handshake';
        const init = await withTimeout(upstreamHandshake(fromUp, (b) => conn.up.send(b), conn.password), 8000, 'the screen took too long to answer');
        return init;
      } catch (e: any) {
        try { upstream?.close(); } catch { /* */ }
        upstream = null;
        const msg = String(e?.message ?? e);
        // Only a screen that stopped answering is worth a second try; a refusal or a closed viewer is not.
        if (ended || tries || env.computer !== 'local' || isSilo(botId) || /refused|auth failed|Unsupported|no screen|viewer did not answer|too much at once/i.test(msg)) throw e;
        console.warn(`[vnc] ${what}: ${msg}; restarting its x11vnc and trying once more`);
        tries++;
        fromUp.reset();
      }
    }
  };

  try {
    const [serverInit] = await Promise.all([
      openUpstream(),
      browserGreeting(fromClient, (b) => client.send(b)).then(() => { if (stage === 'opening the screen') stage = 'waiting for the screen'; }),
    ]);
    stage = 'live';
    client.send(serverInit);
    // Flush anything that arrived during the handshake, then switch to piping.
    piping = true;
    const leftoverUp = fromUp.takeAll();
    if (leftoverUp.length) client.send(leftoverUp);
    const leftoverClient = fromClient.takeAll();
    if (leftoverClient.length) {
      const fwd = mode === 'watch' ? filter.feed(leftoverClient) : leftoverClient;
      if (fwd.length) upstream!.send(fwd);
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg === 'client closed') return; // already logged by the close handler
    end(`failed: ${msg}`);
    closeAll(1011, msg);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(why)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** A paired PC's screen: the PC streams RFB over its link (machines.ts). Input passes only in control mode. */
async function relayPc(client: WebSocket, userId: string, machineId: string, mode: 'watch' | 'control') {
  const fromClient = new ByteQueue();
  const fromUp = new ByteQueue();
  let up: Awaited<ReturnType<typeof openMachineScreen>> | null = null;
  let piping = false;
  const filter = new WatchFilter(mode === 'control');
  const closeAll = (code = 1000, reason = '') => {
    try { client.close(code, reason.slice(0, 120)); } catch { /* */ }
    try { up?.close(); } catch { /* */ }
  };
  client.on('message', (data: Buffer) => {
    if (!piping) return fromClient.push(Buffer.from(data));
    const fwd = filter.feed(Buffer.from(data));
    if (fwd.length && up?.open) up.send(fwd);
  });
  const stopPings = keepAlive(client);
  client.on('close', () => { stopPings(); fromClient.close(new Error('client closed')); try { up?.close(); } catch { /* */ } });
  try {
    up = await openMachineScreen(machineId, (data) => {
      if (!piping) return fromUp.push(data);
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }, (why) => { fromUp.close(new Error(why)); closeAll(1000, why); }, mode === 'control');
    const [serverInit] = await Promise.all([upstreamHandshake(fromUp, (b) => up!.send(b), ''), browserGreeting(fromClient, (b) => client.send(b))]);
    client.send(serverInit);
    piping = true;
    const leftoverUp = fromUp.takeAll();
    if (leftoverUp.length) client.send(leftoverUp);
    const leftoverClient = filter.feed(fromClient.takeAll());
    if (leftoverClient.length) up.send(leftoverClient);
  } catch (e: any) {
    console.warn('[vnc] PC relay failed', e?.message ?? e);
    closeAll(1011, String(e?.message ?? e));
  }
}
