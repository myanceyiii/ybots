// The browser guard's kinds hold (browser-guard-page.ts, action-kinds.ts) in a real Chromium page: Send,
// Delete, Share, Post and password-change presses are held unless allowed on the site; browsing is not.
// Needs Chromium (Playwright) and a built server:  npm run build -w server && node tests/action-kinds-page.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { GUARD_SOURCE } = await import('../server/dist/browser-guard-page.js');

const HTML = `<!doctype html><html><body>
<form id="mail" onsubmit="event.preventDefault(); window.hits.push('mail-submit')">
  <textarea id="body" aria-label="Message body"></textarea>
  <button id="send" type="button" onclick="window.hits.push('send')">Send</button>
</form>
<a id="sent" href="#sent" onclick="window.hits.push('sent')">Sent</a>
<button id="del" onclick="window.hits.push('del')">Move to trash</button>
<button id="rmfilter" onclick="window.hits.push('rmfilter')">Remove filter</button>
<a id="dellink" href="/settings/delete-account" onclick="event.preventDefault(); window.hits.push('dellink')">Delete account</a>
<div role="dialog"><textarea id="reply-box" aria-label="Reply"></textarea><button id="reply" onclick="window.hits.push('reply')">Reply</button></div>
<button id="share" onclick="window.hits.push('share')">Share</button>
<button id="order" onclick="window.hits.push('order')">Place your order</button>
<input id="search" type="search" aria-label="Search mail" onkeydown="if(event.key==='Enter') window.hits.push('search')">
<form id="pw" onsubmit="event.preventDefault(); window.hits.push('pw')">
  <input type="password" autocomplete="current-password"><input type="password" autocomplete="new-password">
  <button id="pwbtn" type="submit">Save</button>
</form>
</body></html>`;

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); } };

const browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
try {
  const page = await browser.newPage();
  const reports = [];
  await page.exposeFunction('cleftGuard', (s) => { reports.push(JSON.parse(s)); });
  await page.route('https://mail.example.test/**', (r) => r.fulfill({ contentType: 'text/html', body: HTML }));
  await page.addInitScript(GUARD_SOURCE);
  await page.addInitScript('window.hits = [];');
  await page.goto('https://mail.example.test/');
  const hits = () => page.evaluate(() => window.hits.splice(0));
  const take = () => reports.splice(0);
  const set = (state) => page.evaluate((s) => window.__cleftGuard.setKinds(JSON.stringify(s)), state);
  const settle = () => page.waitForTimeout(80);

  await test('Send is held and reported; nothing reaches the page', async () => {
    await page.click('#send'); await settle();
    assert.deepEqual(await hits(), []);
    const r = take().filter((x) => x.t === 'kind_held');
    assert.equal(r.length, 1, JSON.stringify(r));
    assert.equal(r[0].kind, 'send'); assert.equal(r[0].label, 'Send'); assert.equal(r[0].site, 'mail.example.test');
  });

  await test('browsing is never held: a Sent folder, Remove filter, a Delete account settings link, a search box', async () => {
    await page.click('#sent'); await page.click('#rmfilter'); await page.click('#dellink');
    await page.fill('#search', 'invoices'); await page.press('#search', 'Enter'); await settle();
    assert.deepEqual(await hits(), ['sent', 'rmfilter', 'dellink', 'search']);
    assert.deepEqual(take().filter((x) => x.t === 'kind_held'), []);
  });

  await test('Move to trash and Share are held; Place your order is the purchase hold\'s', async () => {
    await page.click('#del'); await page.click('#share'); await page.click('#order'); await settle();
    assert.deepEqual(await hits(), []);
    const r = take();
    assert.deepEqual(r.filter((x) => x.t === 'kind_held').map((x) => x.kind), ['delete', 'share']);
    assert.equal(r.filter((x) => x.t === 'held').length, 1, 'the pay button is held by the purchase hold');
  });

  await test('Ctrl+Enter in a text box is a send; Reply counts only with text written', async () => {
    await page.fill('#body', 'Hi Dana'); await page.press('#body', 'Control+Enter'); await settle();
    assert.deepEqual(take().filter((x) => x.t === 'kind_held').map((x) => x.label), ['Ctrl+Enter in Message body']);
    await page.click('#reply'); await settle();
    assert.deepEqual(await hits(), ['reply'], 'an empty Reply only opens a box');
    await page.fill('#reply-box', 'Sounds good'); await page.click('#reply'); await settle();
    assert.deepEqual(await hits(), []);
    assert.deepEqual(take().filter((x) => x.t === 'kind_held').map((x) => x.kind), ['send']);
  });

  await test('allowed for the site (conversation or always): Send goes through and is reported as passed', async () => {
    await set({ control: false, allow: [{ k: 'send', s: 'mail.example.test' }] });
    await page.click('#send'); await settle();
    assert.deepEqual(await hits(), ['send']);
    assert.equal(take().filter((x) => x.t === 'kind_passed' && x.via === 'standing').length, 1);
    await page.click('#del'); await settle();
    assert.deepEqual(await hits(), [], 'a send allow does not reach delete');
    take();
    await set({ control: false, allow: [{ k: 'send', s: 'other.example' }] });
    await page.click('#send'); await settle();
    assert.deepEqual(await hits(), [], 'another site\'s allow does not reach this one');
    take();
  });

  await test('Allow once lets exactly one press through', async () => {
    await set({ control: false, allow: [], once: { k: 'delete', s: 'mail.example.test', ms: 60000 } });
    await page.click('#del'); await settle();
    assert.deepEqual(await hits(), ['del']);
    assert.equal(take().filter((x) => x.t === 'kind_passed' && x.via === 'once').length, 1);
    await page.waitForTimeout(2600);
    await page.click('#del'); await settle();
    assert.deepEqual(await hits(), []);
    assert.equal(take().filter((x) => x.t === 'kind_held').length, 1);
  });

  await test('a password change is held, and no allow lets the bot press it', async () => {
    await set({ control: false, allow: [{ k: 'credentials', s: 'mail.example.test' }], once: { k: 'credentials', s: 'mail.example.test', ms: 60000 } });
    await page.click('#pwbtn'); await settle();
    assert.deepEqual(await hits(), []);
    assert.deepEqual(take().filter((x) => x.t === 'kind_held').map((x) => x.kind), ['credentials']);
  });

  await test('while the person has taken control, their presses are theirs', async () => {
    await set({ control: true, allow: [] });
    await page.click('#send'); await page.click('#del'); await settle();
    assert.deepEqual(await hits(), ['send', 'del']);
    assert.deepEqual(take().filter((x) => x.t === 'kind_held'), []);
    await set({ control: false, allow: [] });
  });

  await test('the page read lists the kind buttons for the script gate', async () => {
    const r = await page.evaluate(() => window.__cleftGuard.read());
    const kinds = r.kindControls.map((c) => `${c.k}:${c.l}`);
    assert.ok(kinds.includes('send:Send') && kinds.includes('delete:Move to trash') && kinds.includes('share:Share'), JSON.stringify(kinds));
    assert.ok(!kinds.some((x) => /Remove filter/.test(x)));
  });
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
