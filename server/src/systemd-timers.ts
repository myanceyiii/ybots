type RunningTimer = { unit: string; next?: number | null; last?: number | null; activates?: string };
type TimerFile = { unit_file: string; state: string };
type TimerReader = (host: string, command: 'timers' | 'files' | 'is-enabled', unit?: string) => Promise<string>;
type TimerChange = { host: string; unit: string; action: 'enable' | 'disable' };
type ChangeDeps = { approve: (change: TimerChange) => Promise<string>; run: (host: string, unit: string, action: TimerChange['action']) => Promise<void>; inspect: (host: string, unit: string) => Promise<string> };

export async function changeTimer(hosts: string[], change: TimerChange, deps: ChangeDeps) {
  if (!validateTarget(hosts, change.host, change.unit) || !['enable', 'disable'].includes(change.action)) throw new Error('Invalid timer target');
  if (await deps.approve(change) !== 'allow') throw new Error('Not approved');
  await deps.run(change.host, change.unit, change.action);
  const state = await deps.inspect(change.host, change.unit);
  if (state !== (change.action === 'enable' ? 'enabled' : 'disabled')) throw new Error('Timer state did not match requested state');
  return { state };
}

export async function readHostTimers(host: string, read: TimerReader) {
  try {
    const running = JSON.parse(await read(host, 'timers'));
    const files = JSON.parse(await read(host, 'files'));
    if (!Array.isArray(running) || !Array.isArray(files)) throw new Error('invalid response');
    const timers = mergeTimers(running, files);
    await Promise.all(timers.filter((timer) => timer.name.includes('@') && !timer.name.includes('@.') && validateTarget([host], host, timer.name)).map(async (timer) => {
      try { timer.state = (await read(host, 'is-enabled', timer.name)).trim(); } catch { timer.state = 'unknown'; }
    }));
    return { host, reachable: true, timers };
  } catch {
    return { host, reachable: false, timers: [] };
  }
}

export function validateTarget(hosts: string[], host: string, unit: string): boolean {
  return hosts.includes(host) && /^[A-Za-z0-9_][A-Za-z0-9_.:@-]*\.timer$/.test(unit) && !unit.includes('@.');
}

/** Join loaded timers and installed timer files, retaining disabled timers. systemd reports microseconds. */
export function mergeTimers(running: RunningTimer[], files: TimerFile[]) {
  const loaded = new Map(running.map((timer) => [timer.unit, timer]));
  const states = new Map(files.map((file) => [file.unit_file, file.state]));
  const names = [...new Set([...loaded.keys(), ...states.keys()])].sort();
  const ms = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value / 1000) : null;
  return names.map((name) => {
    const timer = loaded.get(name);
    return { name, state: states.get(name) ?? 'unknown', next: ms(timer?.next), last: ms(timer?.last), activates: timer?.activates ?? null };
  });
}
