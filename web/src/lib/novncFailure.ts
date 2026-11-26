/**
 * noVNC says why it gave up only in its log (console.error, "Failed when connecting: …"). This keeps the
 * last such line so a screen view can say what actually failed (screenRetry.ts). Installed once, on first use.
 */
let last = '';
let installed = false;

export function watchNoVncFailures() {
  if (installed) return;
  installed = true;
  const original = console.error.bind(console);
  console.error = (...a: unknown[]) => {
    const m = a.map(String).join(' ');
    if (/^(Failed (when|while)|RFB failure)/.test(m)) last = m.slice(0, 200);
    original(...a);
  };
}

/** The last failure line, and forget it (so the next connection starts clean). */
export function takeNoVncFailure(): string {
  const m = last;
  last = '';
  return m;
}
