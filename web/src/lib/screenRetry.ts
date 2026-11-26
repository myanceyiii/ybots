// A bot's (or PC's) live screen: quiet automatic retries before an error shows, and what to say when they
// run out. The link can fail for a moment for reasons nobody needs to see (a proxy, a network switch, the
// screen service waking up), so the view tries again a few times on its own and only then asks.
//
// No browser- or phone-only code: web/src/lib/screenRetry.ts and mobile/src/screenRetry.ts are the same
// file; keep them so.

/** Waits before each quiet retry, in ms: about 11 s in all before the error shows. */
export const SCREEN_RETRY_DELAYS = [300, 800, 1600, 3000, 5000];

/** How long to wait before quiet retry number `failures + 1`, or null when it is time to show the error. */
export function screenRetryDelay(failures: number): number | null {
  return failures < SCREEN_RETRY_DELAYS.length ? SCREEN_RETRY_DELAYS[failures] : null;
}

export interface ScreenFailure {
  /** The socket opened (the server was reached). Unknown when the viewer can't tell. */
  opened?: boolean;
  /** WebSocket close code and reason. */
  code?: number;
  reason?: string;
  /** The socket's own error text (the phone's says, for example, "Expected HTTP 101 response but was '403'"). */
  error?: string | null;
  /** The viewer's (noVNC's) last failure line. */
  why?: string | null;
}

const first = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const dot = (s: string) => (/[.!?)]$/.test(s) ? s : `${s}.`);

/** What went wrong, as one short sentence a person can act on. */
export function screenFailureText(f: ScreenFailure): string {
  const why = (f.why ?? '').replace(/^(Failed (when connecting|while connected|when disconnecting)|RFB failure):\s*/, '').trim();
  // A browser viewer only learns the socket's close from noVNC's line: "Connection closed (code: 1011, reason: …)".
  const closed = /^Connection closed \(code: (\d+)(?:, reason: (.*))?\)$/.exec(why);
  const code = f.code ?? (closed ? Number(closed[1]) : undefined);
  const reason = (f.reason || closed?.[2] || '').trim();
  const error = (f.error ?? '').trim();
  if (/\b(401|403)\b/.test(error) || /\b(401|403)\b/.test(reason)) return 'The server turned the screen link away. Signing in again usually fixes this.';
  if (reason) return dot(first(reason));
  if (f.opened === false) return error ? `The link to the server didn’t open (${error.slice(0, 120)}).` : 'The link to the server didn’t open. Check the connection.';
  if (why && !/^Connection closed/i.test(why)) return dot(`The viewer stopped: ${why.slice(0, 140)}`);
  if (code === 1006 || !code) return 'The connection dropped without a reason, which is usually the network or a proxy on the way.';
  return `The connection closed (code ${code}).`;
}
