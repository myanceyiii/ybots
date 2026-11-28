import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import { requireUser, type AuthVars } from './lib/auth.js';
import { getBotRow } from './store.js';
import { isOwner } from './plugins/owner.js';
import { isMaintainer } from './maintainer-guard.js';
import { expireApproval, requestApproval } from './agent/loop.js';
import { changeTimer, readHostTimers, validateTarget } from './systemd-timers.js';
import { timerHostIds, timerHosts } from './systemd-timer-hosts.js';

const exec = promisify(execFile);
const hostLabel = (id: string) => timerHosts().find((h) => h.id === id)?.label ?? id;
const hosts = () => timerHostIds(timerHosts());
const args = { timers: ['list-timers', '--all', '--output=json', '--no-pager'], files: ['list-unit-files', '--type=timer', '--output=json', '--no-pager'] } as const;
async function run(host: string, parts: string[]): Promise<string> {
  if (!hosts().includes(host)) throw new Error('Unknown host');
  if (host === 'local') return (await exec('/usr/bin/systemctl', parts, { timeout: 15000, maxBuffer: 2_000_000 })).stdout;
  const user = process.env.CONNECTOR_SCAN_USER ?? '';
  if (user && !/^[a-z_][a-z0-9_-]*$/.test(user)) throw new Error('Invalid remote scan user');
  const elevated = parts[0] === 'enable' || parts[0] === 'disable';
  const remote = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', host, ...(elevated ? ['sudo', '-n'] : []), 'systemctl', ...parts];
  if (user && process.getuid?.() === 0) return (await exec('/usr/bin/sudo', ['-n', '-u', user, ...remote], { timeout: 20000, maxBuffer: 2_000_000 })).stdout;
  return (await exec('/usr/bin/ssh', remote.slice(1), { timeout: 20000, maxBuffer: 2_000_000 })).stdout;
}

async function unitState(host: string, unit: string): Promise<string> {
  if (!validateTarget(hosts(), host, unit)) throw new Error('Invalid timer target');
  try { return (await run(host, ['is-enabled', '--', unit])).trim(); }
  catch (e) {
    const out = String((e as { stdout?: string }).stdout ?? '').trim();
    if (['disabled', 'masked', 'static', 'indirect'].includes(out)) return out;
    throw e;
  }
}

export const systemdTimersApi = new Hono<AuthVars>();
systemdTimersApi.use('/bots/*', requireUser);
function allowed(c: any) {
  const bot = getBotRow(c.req.param('id'));
  return !!bot && bot.user_id === c.get('user').id && isMaintainer(bot.id) && isOwner(c.get('user').id) && !c.get('scope') && !c.get('agent');
}
systemdTimersApi.get('/bots/:id/systemd-timers', async (c) => {
  if (!allowed(c)) return c.json({ error: 'Not available on this sign-in.' }, 403);
  // ?probe=1 lets an app decide whether to show the panel without reaching every machine over ssh.
  if (c.req.query('probe')) return c.json({ ok: true, hosts: [] });
  const list = timerHosts();
  const read = await Promise.all(list.map((h) => readHostTimers(h.id, (host, command, unit) => command === 'is-enabled' ? unitState(host, unit ?? '') : run(host, [...args[command]]))));
  return c.json({ hosts: read.map((r, i) => ({ ...r, label: list[i].label })), checkedAt: Date.now() });
});
systemdTimersApi.post('/bots/:id/systemd-timers/change', async (c) => {
  if (!allowed(c)) return c.json({ error: 'Not available on this sign-in.' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const host = String(body.host ?? ''), unit = String(body.unit ?? ''), action = body.action;
  if (!validateTarget(hosts(), host, unit) || !['enable', 'disable'].includes(action)) return c.json({ error: 'Invalid timer target.' }, 400);
  try {
    const result = await changeTimer(hosts(), { host, unit, action }, {
      // The card expires if the page that asked goes away (a proxy timeout, a closed tab): nothing waits to run it.
      approve: async (change) => {
        const meta: { approvalId?: string } = {};
        const gone = () => { if (meta.approvalId) expireApproval(meta.approvalId); };
        c.req.raw.signal?.addEventListener('abort', gone, { once: true });
        try {
          return await requestApproval({ userId: c.get('user').id, botId: c.req.param('id') }, { decision: 'ask', key: 'systemctl', asks: [], title: `System timer: ${action} ${unit} on ${hostLabel(host)}`, detail: `Change ${unit} on ${hostLabel(host)}: ${action} and ${action === 'enable' ? 'start' : 'stop'} the timer.` }, change, null, meta);
        } finally { c.req.raw.signal?.removeEventListener('abort', gone); }
      },
      run: async (h, u, a) => { await run(h, [a, '--now', '--', u]); },
      inspect: unitState,
    });
    return c.json(result);
  } catch { return c.json({ error: 'Change not completed or could not be verified. Refresh to check the current state.' }, 409); }
});
