/**
 * What the server does when it is stopped (systemctl stop/restart sends SIGTERM, a deploy does that).
 * Steps run in the order they were added, each with a time limit, then the process exits. One handler
 * for the whole server, so one module's process.exit() cannot cut another's cleanup short.
 */
type Step = { name: string; run: () => unknown; limitMs: number };
const steps: Step[] = [];
let installed = false;
let stopping = false;

export function onShutdown(name: string, run: () => unknown, limitMs = 3000): void {
  steps.push({ name, run, limitMs });
  if (installed) return;
  installed = true;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { void shutdown(sig); });
}

export async function shutdown(why: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[cleftbot] stopping (${why})`);
  for (const s of steps) {
    try {
      await Promise.race([Promise.resolve().then(s.run), new Promise((r) => setTimeout(r, s.limitMs).unref())]);
    } catch (e) { console.warn(`[cleftbot] shutdown step ${s.name} failed`, e); }
  }
  process.exit(0);
}
