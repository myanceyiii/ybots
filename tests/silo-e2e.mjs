// End-to-end check of Sheldon's silo with the real app server and the real container.
// Needs Docker and the images (docker compose -f silo/sheldon/compose.yaml build; SILO_BROWSER=none is fine).
// Usage: npm run build -w server && sudo node tests/silo-e2e.mjs
// It brings the silo up from silo/sheldon/compose.yaml with throwaway secrets and data in a temp
// folder, runs the host relay, starts the app on 127.0.0.1:8787, and checks:
//   - the app treats the bot as siloed from the moment it is created (no Hermes home on the host),
//   - the app reaches the container's agent (health and model list) with the agent's key,
//   - the agent inside reaches the app's MCP endpoint only through gate + relay, with its token,
//   - send_to_bot from the siloed bot: allowed types arrive rebuilt, everything else is refused,
//   - the siloed bot cannot create, join or post in a group chat,
//   - the live view answers with a VNC banner on the published loopback port.
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const SILO = path.join(ROOT, 'silo/sheldon');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cleft-silo-e2e-'));
const SECRET = crypto.randomBytes(32).toString('hex');
const BASE = 'http://127.0.0.1:8787';
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
};

// ---- throwaway silo settings ----
const sec = path.join(TMP, 'secrets');
const data = path.join(TMP, 'data');
fs.mkdirSync(sec); fs.mkdirSync(data);
fs.writeFileSync(path.join(sec, 'api_key'), crypto.randomBytes(24).toString('hex'));
fs.writeFileSync(path.join(sec, 'vnc_password'), 'e2epass1');
fs.writeFileSync(path.join(sec, 'mcp_token'), 'not-yet');
fs.writeFileSync(path.join(TMP, 'allowlist'), '(^|\\.)example\\.com$\n');
sh('chown', ['-R', '10101:10101', data]);
sh('chown', ['root:10101', ...fs.readdirSync(sec).map((f) => path.join(sec, f))]);
for (const f of fs.readdirSync(sec)) fs.chmodSync(path.join(sec, f), 0o440);
const siloEnv = (botId) => {
  fs.writeFileSync(path.join(TMP, 'silo.env'), `SHELDON_BOT_ID=${botId}\nSILO_DATA=${data}\nSILO_ALLOWLIST=${path.join(TMP, 'allowlist')}\nSECRETS_DIR=${sec}\nSILO_BROWSER=none\n`);
  return ['compose', '-f', path.join(SILO, 'compose.yaml'), '--env-file', path.join(TMP, 'silo.env')];
};

const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(true); console.log(`PASS ${name}`); }
  catch (e) { results.push(false); console.log(`FAIL ${name}\n  ${e?.stack ?? e}`); }
};
const until = async (fn, ms = 120_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error(`timed out waiting for ${what}`);
};

// ---- app ----
const SILO_BOTS = JSON.stringify({ 'name:Sheldon': {
  url: 'http://127.0.0.1:8653', keyFile: path.join(sec, 'api_key'), vnc: '127.0.0.1:5953', vncPasswordFile: path.join(sec, 'vnc_password'),
  allow: { Leonard: ['CAL', 'ITINERARY', 'RECEIPT', 'Q', 'A'], Robin: ['CAL'] },
} });
let log = '';
const app = spawn(process.execPath, [path.join(ROOT, 'server/dist/index.js')], {
  cwd: path.join(ROOT, 'server'), stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH, HOME: TMP, NODE_ENV: 'test', PORT: '8787', HOST: '127.0.0.1', SESSION_SECRET: SECRET,
    DB_PATH: path.join(TMP, 'hq.db'), APP_URL: 'http://localhost:5173', SERVER_URL: BASE, DEV_LOGIN: '1',
    HERMES_URL: 'http://127.0.0.1:9', HERMES_HOME_PRIMARY: path.join(TMP, 'hermes'), HERMES_BIN: path.join(TMP, 'no-hermes'),
    ENGINES_DIR: path.join(TMP, 'engines'), BOTHQ_NO_SCHEDULER: '1', COMPUTER: 'local', SILO_BOTS },
});
app.stdout.on('data', (d) => { log += d; });
app.stderr.on('data', (d) => { log += d; });
let relay = null;
const cleanup = () => {
  try { app.kill(); } catch {}
  try { relay?.kill(); } catch {}
  spawnSync('docker', [...siloEnv('cleanup'), 'down', '-v'], { stdio: 'ignore' });
  fs.rmSync(TMP, { recursive: true, force: true });
};
process.on('exit', cleanup);

await until(async () => (await fetch(`${BASE}/api/health`)).ok, 30_000, 'the app');
const signin = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@test.invalid', name: 'Owner' }) });
const cookie = signin.headers.get('set-cookie').split(';')[0];
const api = async (method, p, body) => {
  const r = await fetch(`${BASE}/api${p}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const mk = async (name) => (await api('POST', '/bots', { name })).json.bot.id;
const leonard = await mk('Leonard');
const robin = await mk('Robin');
const sheldon = await mk('Sheldon');
const token = crypto.createHmac('sha256', SECRET).update(`mcp:${sheldon}`).digest('hex');
fs.chmodSync(path.join(sec, 'mcp_token'), 0o640);
fs.writeFileSync(path.join(sec, 'mcp_token'), token);
fs.chmodSync(path.join(sec, 'mcp_token'), 0o440);

relay = spawn('python3', [path.join(SILO, 'host/sheldon-mcp-relay.py')], { stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, RELAY_LISTEN: '172.30.53.1:8789', GATE_IP: '172.30.53.2', APP: '127.0.0.1:8787', SHELDON_BOT_ID: sheldon } });
let relayLog = '';
relay.stderr.on('data', (d) => { relayLog += d; });
sh('docker', [...siloEnv(sheldon), 'up', '-d', '--no-build', '--force-recreate']);

await step('a bot named in SILO_BOTS gets no Hermes home on the host', async () => {
  assert.equal(fs.existsSync(path.join(TMP, 'engines', sheldon)), false);
});

await step('the app reaches the agent in the container (engine ready, Hermes version)', async () => {
  const e = await until(async () => { const r = await api('GET', `/bots/${sheldon}/engine`); return r.json?.engine?.status === 'ready' && r.json.engine; }, 180_000, 'engine ready');
  assert.match(String(e.version), /^\d+\.\d+\.\d+/);
});

await step('the agent inside connects to the app\'s MCP endpoint through gate and relay', async () => {
  await until(async () => /POST \/mcp\/[^ ]+ HTTP\/1\.1" 200/.test(relayLog), 120_000, 'an MCP call through the relay');
  const gw = fs.readFileSync(path.join(data, 'hermes/logs/gateway.out.log'), 'utf8');
  assert.doesNotMatch(gw.split('\n').slice(-40).join('\n'), /MCP server 'hq' failed initial connection/);
});

const call = async (name, args) => {
  const r = await fetch(`${BASE}/mcp/${sheldon}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const text = await r.text();
  const m = /\{.*\}/s.exec(text);
  const j = JSON.parse(m[0]);
  return (j.result?.content ?? []).map((c) => c.text).join('\n') || JSON.stringify(j.error ?? j);
};
const lastFrom = async (botId) => {
  const r = await api('GET', `/bots/${botId}/rows`);
  const rows = r.json?.rows ?? [];
  return rows.filter((x) => x.body?.from?.id === sheldon).map((x) => x.body.text);
};

await step('send_to_bot: free text, a wrong type or a non-listed bot is refused', async () => {
  assert.match(await call('send_to_bot', { bot_name: 'Leonard', message: 'The Jones deposition moved to Friday.' }), /Not sent\. Give a type/);
  assert.match(await call('send_to_bot', { bot_name: 'Robin', message: 'Is Alex free?', type: 'Q' }), /Not sent\. Q may not be sent to Robin/);
  assert.match(await call('send_to_bot', { bot_name: 'Robin', message: 'x', type: 'CAL', data: { start: '2026-11-23T09:00', end: '2026-11-23T11:00', status: 'busy', title: 'Jones deposition' } }), /Not sent\. CAL: fields not allowed: title/);
});

await step('send_to_bot: an allowed CAL arrives at Robin rebuilt from its fields', async () => {
  const out = await call('send_to_bot', { bot_name: 'Robin', message: 'ignored', type: 'CAL', data: { start: '2026-11-23T09:00', end: '2026-11-23T11:00', status: 'busy' } });
  assert.match(out, /Sent to Robin/);
  const got = await until(async () => { const t = await lastFrom(robin); return t.length && t; }, 10_000, 'the row at Robin');
  assert.deepEqual(got, ['CAL busy 2026-11-23T09:00 to 2026-11-23T11:00']);
});

await step('group chats are closed to the siloed bot', async () => {
  assert.match(await call('create_group', { name: 'Team', bot_names: ['Leonard', 'Robin'] }), /cannot create group chats/);
  const room = await api('POST', '/rooms', { name: 'Household', botIds: [leonard, robin, sheldon] });
  const members = (await api('GET', `/rooms/${room.json.id}/members`)).json.members.map((m) => m.id);
  assert.equal(members.includes(sheldon), false);
  assert.match(await call('post_to_group', { group_name: 'Household', text: 'hi' }), /cannot post in group chats/);
});

await step('model sign-in and restart from the app are refused with a pointer to the container', async () => {
  assert.equal((await api('POST', `/bots/${sheldon}/engine/login`, {})).status, 409);
  assert.equal((await api('POST', `/bots/${sheldon}/engine/restart`, {})).status, 409);
});

await step('the approval gate for Hermes\' own tools is installed and reaches the app from inside', async () => {
  const cfg = fs.readFileSync(path.join(data, 'hermes/config.yaml'), 'utf8');
  assert.match(cfg, /cleft-bot-gate/);
  const out = sh('docker', ['exec', 'cleft-sheldon-sheldon-1', 'sh', '-c',
    `curl -s --noproxy '*' -X POST -H "Authorization: Bearer $(cat /run/secrets/mcp_token)" -H 'Content-Type: application/json' -d '{"tool":"read_file","args":{}}' "$(python3 -c 'import json;print(json.load(open("/data/hermes/plugins/cleft-bot-gate/gate.json"))["url"])')"`]);
  assert.match(out, /"action":"allow"/, `${out}\n${relayLog.split("\n").slice(-3).join("\n")}`);
});

await step('the live view port answers with a VNC banner', async () => {
  const banner = await new Promise((res, rej) => {
    const s = net.connect(5953, '127.0.0.1');
    s.once('data', (d) => { res(String(d)); s.destroy(); });
    s.once('error', rej);
    setTimeout(() => rej(new Error('no banner')), 5000);
  });
  assert.match(banner, /^RFB 003\.00\d/);
});

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
