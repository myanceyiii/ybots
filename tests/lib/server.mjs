// A throwaway server for end-to-end suites: the built server on a random port with its own database and
// folders, and a fake Hermes that answers every turn with a short reply. Nothing outside 127.0.0.1.
//   const s = await startServer({ env: {...} });  ...  await s.stop();
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake Hermes: records each turn's input and streams `reply(n, body)` back. */
export function fakeHermes(port, reply = (n) => `answer ${n}`) {
  const inputs = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
      if (req.url === '/v1/responses') {
        const parsed = JSON.parse(body);
        inputs.push(JSON.stringify(parsed.input));
        const answer = reply(inputs.length, parsed);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        send('response.output_text.delta', { delta: answer });
        send('response.output_item.done', { item: { type: 'message', content: [{ text: answer }] } });
        send('response.completed', { response: { usage: { input_tokens: 100, output_tokens: 20 } } });
        return res.end();
      }
      res.statusCode = 404; res.end('{}');
    });
  }).listen(port, '127.0.0.1');
  return { inputs, close: () => server.close() };
}

export async function startServer(opts = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `${opts.name ?? 'e2e'}-`));
  const PORT = opts.port ?? 19600 + Math.floor(Math.random() * 300);
  const HERMES_PORT = PORT + 600;
  const BASE = `http://127.0.0.1:${PORT}`;
  const SECRET = opts.secret ?? crypto.randomBytes(32).toString('hex');
  const hermes = opts.noHermes ? null : fakeHermes(HERMES_PORT, opts.reply);
  const hermesHome = path.join(dir, 'hermes');
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(path.join(hermesHome, '.env'), 'API_SERVER_KEY=test-key\n');
  const state = { log: '', exit: null };
  const child = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
    cwd: path.join(root, 'server'),
    env: {
      PATH: process.env.PATH, HOME: dir,
      PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET,
      ORGO_API_KEY: 'unused', DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'),
      HERMES_BIN: '/bin/false', HERMES_URL: `http://127.0.0.1:${HERMES_PORT}`, HERMES_HOME_PRIMARY: hermesHome,
      APPS_CONFIG: path.join(dir, 'apps.json'), BOTHQ_NO_SCHEDULER: '1', HQ_LOCAL: '1', OWNER_EMAIL: 'owner@example.com',
      BACKUP_HISTORY_FILE: path.join(dir, 'no-backup-history.log'),
      ...(opts.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { state.log += d; });
  child.stderr.on('data', (d) => { state.log += d; });
  child.on('exit', (code) => { state.exit = code; });
  const stop = async () => {
    if (state.exit === null) { child.kill(); for (let i = 0; i < 100 && state.exit === null; i++) await sleep(50); }
    hermes?.close();
    if (!opts.keepDir) fs.rmSync(dir, { recursive: true, force: true });
  };
  if (opts.expectExit) {
    for (let i = 0; i < 150 && state.exit === null; i++) await sleep(100);
    return { dir, BASE, state, stop, child };
  }
  for (let i = 0; ; i++) {
    if (state.exit !== null) { await stop(); throw new Error(`server stopped while starting (exit ${state.exit}):\n${state.log}`); }
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 150) { await stop(); throw new Error(`server did not start:\n${state.log}`); } await sleep(200); }
  }
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const owner = (body) => fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  /** A person's sign-in (through a link, as a phone does). Returns { token, api }. */
  const signIn = async (email = 'owner@example.com', headers = {}) => {
    const linked = await (await owner({ email, link: true })).json();
    const { token } = await (await fetch(linked.url.replace(/^https?:\/\/[^/]+/, BASE), { headers: { accept: 'application/json', ...headers } })).json();
    return { token, api: apiFor({ authorization: `Bearer ${token}`, ...headers }) };
  };
  /** A script's sign-in (the owner key without a link). */
  const signInScript = async (agent = 'Claude: test', email = 'owner@example.com') => {
    const r = await owner({ email, agent });
    const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    return { cookie, api: apiFor({ cookie }) };
  };
  const apiFor = (auth) => async (method, p, body, extra = {}) => {
    const r = await fetch(`${BASE}/api${p}`, { method, headers: { ...auth, 'content-type': 'application/json', origin: BASE, ...extra }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { dir, BASE, PORT, SECRET, state, hermes, owner, signIn, signInScript, apiFor, stop, child, dbPath: path.join(dir, 'test.db') };
}

/** `test(name, fn)` that counts failures, and `done()` that prints the result and exits. */
export function runner() {
  let failures = 0;
  const test = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack ?? e.message}`); }
  };
  const done = () => { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); };
  return { test, done };
}

export async function until(what, fn, tries = 100) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}
