// End-to-end check of Download in the web app (also what the Windows app shows): a bot writes a file during
// a turn, the chat shows its chip with a download arrow, the file viewer has a Download button, and both
// save the file under its own name with its exact bytes. Fake Hermes, throwaway database, Playwright.
// Writes into /root/bothq/files/<bot id> like tests/files.mjs (removed at the end).
// Run after `npm run build -w web && npm run build -w server`:   node tests/download-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-e2e-'));
const PORT = 19500 + Math.floor(Math.random() * 400);
const HERMES_PORT = PORT + 600;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = crypto.randomBytes(32).toString('hex');
const SHOTS = process.env.SHOTS || '';

// ---- fake Hermes ----
const inputs = [];
let onTurn = null;
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', version: 'fake' }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [] }));
    if (req.url === '/v1/responses') {
      inputs.push(JSON.parse(body).input);
      if (onTurn) onTurn();
      const answer = `answer ${inputs.length}`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      // One tool step (a file write), so the server adds the turn's files card.
      send('response.output_item.added', { item: { type: 'function_call', call_id: 'c1', name: 'write_file', arguments: '{"path":"howard-access-request.md"}' } });
      send('response.output_item.done', { item: { type: 'function_call_output', call_id: 'c1', output: 'ok' } });
      send('response.output_text.delta', { delta: answer });
      send('response.output_item.done', { item: { type: 'message', content: [{ text: answer }] } });
      send('response.completed', { response: {} });
      return res.end();
    }
    res.statusCode = 404; res.end('{}');
  });
}).listen(HERMES_PORT, '127.0.0.1');

const hermesHome = path.join(dir, 'hermes');
fs.mkdirSync(hermesHome, { recursive: true });
fs.writeFileSync(path.join(hermesHome, '.env'), 'API_SERVER_KEY=test-key\n');

const server = spawn(process.execPath, [path.join(root, 'server/dist/index.js')], {
  cwd: path.join(root, 'server'),
  env: {
    PATH: process.env.PATH, HOME: dir,
    PORT: String(PORT), APP_URL: BASE, SERVER_URL: BASE, SESSION_SECRET: SECRET,
    ORGO_API_KEY: 'unused', DB_PATH: path.join(dir, 'test.db'), ENGINES_DIR: path.join(dir, 'engines'),
    HERMES_BIN: '/bin/false', HERMES_URL: `http://127.0.0.1:${HERMES_PORT}`, HERMES_HOME_PRIMARY: hermesHome,
    APPS_CONFIG: path.join(dir, 'apps.json'), BOTHQ_NO_SCHEDULER: '1', HQ_LOCAL: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
let workspace;

try {
  for (let i = 0; ; i++) {
    try { await fetch(`${BASE}/api/auth/me`); break; } catch { if (i > 100) throw new Error(`server did not start:\n${log}`); await sleep(200); }
  }
  const ownerKey = crypto.createHmac('sha256', SECRET).update('owner-login').digest('hex');
  const owner = (body) => fetch(`${BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const linked = await (await owner({ email: 'owner@example.com', link: true })).json();
  const { token } = await (await fetch(linked.url.replace(/^https?:\/\/[^/]+/, BASE), { headers: { accept: 'application/json' } })).json();
  const api = async (m, p, b) => {
    const r = await fetch(`${BASE}/api${p}`, { method: m, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: BASE }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const { json: { bots } } = await api('GET', '/bots');
  const bot = bots.find((b) => b.isPrimary);
  workspace = path.join('/root/bothq/files', bot.id);
  fs.mkdirSync(workspace, { recursive: true });
  const md = '# Access request\n\nHoward never sees passwords.\n';
  onTurn = () => fs.writeFileSync(path.join(workspace, 'howard-access-request.md'), md);

  await api('POST', `/bots/${bot.id}/messages`, { text: 'write the request' });
  for (let i = 0; ; i++) {
    const rows = (await api('GET', `/bots/${bot.id}/rows`)).json.rows;
    if (rows.some((x) => x.body.type === 'card' && x.body.card === 'files')) break;
    if (i > 100) throw new Error(`no files card\n${log.slice(-1500)}`);
    await sleep(100);
  }

  browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  // A second one-time link for the browser (the first one became the API token above).
  const link2 = await (await owner({ email: 'owner@example.com', link: true })).json();
  await page.goto(link2.url.replace(/^https?:\/\/[^/]+/, BASE));
  await page.goto(BASE);
  const chip = page.locator('.file-chip--split').first();
  await chip.waitFor({ timeout: 15000 });

  await test('the chat chip has a Download arrow that saves the file as it is', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download howard-access-request.md' }).click()]);
    assert.equal(dl.suggestedFilename(), 'howard-access-request.md');
    assert.equal(fs.readFileSync(await dl.path(), 'utf8'), md);
  });
  if (SHOTS) await chip.screenshot({ path: path.join(SHOTS, 'web-chip.png') });

  await test('the file viewer has Download beside Edit, and it saves the same file', async () => {
    await page.locator('.file-chip__open').first().click();
    const actions = page.locator('.files-pane__actions');
    await actions.getByRole('button', { name: 'Edit' }).waitFor({ timeout: 15000 });
    const [dl] = await Promise.all([page.waitForEvent('download'), actions.getByRole('button', { name: 'Download' }).click()]);
    assert.equal(dl.suggestedFilename(), 'howard-access-request.md');
    assert.equal(fs.readFileSync(await dl.path(), 'utf8'), md);
  });
  if (SHOTS) await page.locator('.files-pane').screenshot({ path: path.join(SHOTS, 'web-viewer.png') });
} catch (e) {
  failures++;
  console.log(`FAIL ${e.stack}\n${log.slice(-2000)}`);
} finally {
  await browser?.close();
  server.kill();
  hermes.close();
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
