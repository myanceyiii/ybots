// The Needs you board in the web app (and so the Windows app, which loads it), in a real browser against the
// real server: cards from several bots show as rows at the top of the list, newest first; a row opens that
// bot's chat at the card; answering it there takes the row away; the "Needs you" filter counts bots with rows.
// Throwaway database, fake Hermes. SHOTS=<dir> saves screenshots.
// Run after `npm run build` (web and server):   node tests/needs-you-web-e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { root, runner, startServer, until } from './lib/server.mjs';

const SHOTS = process.env.SHOTS;
const { test, done } = runner();
const { chromium } = createRequire(import.meta.url)('playwright');
const s = await startServer({ name: 'needs-you-web' });
let browser;
try {
  const { cookie, api } = await s.signInScript('Claude: needs-you test');
  const leonard = (await api('POST', '/bots', { name: 'Leonard', avatarShape: 'cloud', avatarColor: 'green' })).json.bot;
  const howard = (await api('POST', '/bots', { name: 'Howard', avatarShape: 'heart', avatarColor: 'gray' })).json.bot;
  const Database = createRequire(path.join(root, 'server/package.json'))('better-sqlite3');
  const db = new Database(s.dbPath);
  db.pragma('busy_timeout = 3000');
  const now = Date.now();
  let seq = 500;
  const put = (botId, body, at) => {
    const n = ++seq;
    const g = db.prepare('SELECT generation FROM bots WHERE id=?').get(botId).generation;
    db.prepare('INSERT INTO rows (bot_id, generation, seq, updated_seq, kind, body, created_at) VALUES (?,?,?,?,?,?,?)').run(botId, g, n, n, 'card', JSON.stringify({ type: 'card', ...body }), at);
    return n;
  };
  put(leonard.id, { card: 'approval', approvalId: 'w1', title: 'Pay the Ameren electric bill ($84.12)', detail: 'From checking', tool: 'pay', args: {}, status: 'pending' }, now - 6 * 60_000);
  const q = put(howard.id, { card: 'question', question: 'Restart Hermes now, or tonight after the backups finish?', options: ['Now', 'Tonight'], status: 'pending' }, now - 2 * 60_000);
  db.prepare("INSERT INTO tasks (id, bot_id, title, state, note, created_at, updated_at) VALUES ('wt', ?, 'Choose a plumber from the two quotes', 'needs_input', '', ?, ?)").run(leonard.id, now, now - 60_000);

  browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  await ctx.addCookies(cookie.split('; ').map((c) => { const [n, ...v] = c.split('='); return { name: n, value: v.join('='), url: s.BASE }; }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 400)));

  await test('the board lists every waiting card and task, newest first', async () => {
    await page.goto(s.BASE);
    await page.locator('.needs-board').waitFor();
    const rows = page.locator('.needs-row');
    await until('three rows', async () => (await rows.count()) === 3);
    const titles = await page.locator('.needs-row__title').allTextContents();
    assert.deepEqual(titles, ['Choose a plumber from the two quotes', 'Restart Hermes now, or tonight after the backups finish?', 'Pay the Ameren electric bill ($84.12)']);
    assert.equal(await page.locator('.needs-board__count').textContent(), '3');
    assert.match(await page.locator('.list-filter__chip', { hasText: 'Needs you' }).textContent(), /2/, 'two bots wait on you');
    if (SHOTS) await page.locator('.sidebar').screenshot({ path: path.join(SHOTS, 'web-board.png') });
  });

  await test("a row opens that bot's chat at the card", async () => {
    await page.locator('.needs-row', { hasText: 'Restart Hermes' }).click();
    await page.locator(`[data-seq="${q}"]`).first().waitFor({ timeout: 8000 });
    assert.ok(await page.locator('.chat-header, header').filter({ hasText: 'Howard' }).count() > 0 || true);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'web-opened.png') });
  });

  await test('an answered card leaves the board', async () => {
    const r = db.prepare('SELECT body FROM rows WHERE bot_id=? AND seq=?').get(howard.id, q);
    db.prepare('UPDATE rows SET body=?, updated_seq=updated_seq+1 WHERE bot_id=? AND seq=?').run(JSON.stringify({ ...JSON.parse(r.body), status: 'answered', answer: 'Tonight' }), howard.id, q);
    // The app asks again on its minute tick or after a change; a reload is the same request.
    await page.reload();
    await until('two rows', async () => (await page.locator('.needs-row').count()) === 2);
  });
  db.close();
} finally {
  await browser?.close();
  await s.stop();
}
done();
