import os from 'node:os';

/** One machine the systemd timer panel reads. `id` is what the API and approval cards use. */
export type TimerHost = { id: string; label: string };

const SSH_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

/**
 * Machines for the timer panel: this server first, then SYSTEMD_TIMER_HOSTS (or, when that is
 * unset, the connector scanner's CONNECTOR_SCAN_HOSTS). Remote names are ssh host names, so they
 * must match the safe pattern; duplicates, "local" and names of this machine are dropped.
 */
export function timerHosts(env: NodeJS.ProcessEnv = process.env, hostname = os.hostname()): TimerHost[] {
  const local = hostname.split('.')[0] || 'this server';
  const raw = env.SYSTEMD_TIMER_HOSTS ?? env.CONNECTOR_SCAN_HOSTS ?? '';
  const self = new Set(['local', 'localhost', local.toLowerCase(), ...(env.SYSTEMD_TIMER_SELF ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean)]);
  const seen = new Set<string>();
  const remote: TimerHost[] = [];
  for (const name of raw.split(/[\s,]+/)) {
    if (!name || !SSH_HOST.test(name) || name.includes('..')) continue;
    const key = name.toLowerCase();
    if (self.has(key) || seen.has(key)) continue;
    seen.add(key);
    remote.push({ id: name, label: name });
  }
  return [{ id: 'local', label: `This server (${local})` }, ...remote];
}

export const timerHostIds = (hosts: TimerHost[]) => hosts.map((h) => h.id);
