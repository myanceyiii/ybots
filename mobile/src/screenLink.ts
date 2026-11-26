import { fromByteArray, toByteArray } from 'base64-js';

/**
 * The phone's end of a bot's screen: a WebSocket to the server's VNC relay opened by the app, because only
 * the app holds the sign-in token and the Cloudflare Access headers (a web page's WebSocket cannot send
 * headers). Bytes go to and from the noVNC page in the WebView as base64. Incoming bytes are gathered for
 * a few milliseconds so a burst of small socket messages crosses into the WebView in one call.
 */
export type ToPage =
  | { t: 'open' }
  | { t: 'data'; d: string[] }
  | { t: 'closed'; code: number; reason: string };

/** How a screen socket ended: whether it ever opened, its close code and reason, and the socket's own error text. */
export interface LinkEnd { opened: boolean; code: number; reason: string; error: string | null; ms: number }

export class ScreenLink {
  private ws: WebSocket;
  private queue: Uint8Array[] = [];
  private queued = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private done = false;
  private opened = false;
  private error: string | null = null;
  private started = Date.now();

  constructor(url: string, headers: Record<string, string>, private toPage: (m: ToPage) => void, private onEnd?: (e: LinkEnd) => void) {
    // React Native's WebSocket takes headers as a third argument (not in the DOM typings).
    const WS = WebSocket as unknown as new (url: string, protocols: string[], opts: { headers: Record<string, string> }) => WebSocket;
    this.ws = new WS(url, ['binary'], { headers });
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => { this.opened = true; if (!this.done) toPage({ t: 'open' }); };
    // Android's socket says what went wrong here (for example "Expected HTTP 101 response but was '403'").
    this.ws.onerror = (e: any) => { this.error = String(e?.message ?? '') || this.error; };
    this.ws.onmessage = (e) => {
      if (this.done || !(e.data instanceof ArrayBuffer)) return;
      const b = new Uint8Array(e.data);
      this.queue.push(b);
      this.queued += b.length;
      // Big updates go at once; small ones wait a frame for company.
      if (this.queued > 512 * 1024) this.flush();
      else if (!this.timer) this.timer = setTimeout(() => this.flush(), 12);
    };
    this.ws.onclose = (e) => {
      if (this.done) return;
      this.flush();
      this.done = true;
      // The app hears first, so it knows why before the page reports the screen gone.
      this.onEnd?.({ opened: this.opened, code: e.code ?? 1006, reason: e.reason ?? '', error: this.error, ms: Date.now() - this.started });
      toPage({ t: 'closed', code: e.code ?? 1006, reason: e.reason ?? '' });
    };
  }

  private flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.queue.length || this.done) return;
    const d = this.queue.map((b) => fromByteArray(b));
    this.queue = [];
    this.queued = 0;
    this.toPage({ t: 'data', d });
  }

  /** Bytes from noVNC (base64) to the server. */
  send(b64: string) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(toByteArray(b64).buffer as ArrayBuffer);
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    const was = this.done;
    this.done = true;
    try { this.ws.close(); } catch { /* already closed */ }
    // noVNC waits for the close to finish disconnecting.
    if (!was) this.toPage({ t: 'closed', code: 1000, reason: '' });
  }
}
