// A2UI interfaces drawn in the web and Windows app (web/src/components/cards/A2uiView.tsx): a bot shows a
// booking form with show_a2ui, the person types and taps in a real browser, the Book button stays off until
// its check passes, and the press posts the person's message. Also draws a Tabs + template + Modal view.
// Needs a built server and web app (`npm run build`) and Chromium:  node tests/a2ui-web-e2e.mjs
// SHOT_DIR=dir saves light and dark screenshots.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { runner, startServer, until } from './lib/server.mjs';

const { test, done } = runner();
const CAT = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
const booking = [
  { version: '1.0', createSurface: { surfaceId: 'booking', catalogId: CAT, dataModel: { party: 4, seating: ['patio'], name: '' } } },
  { version: '1.0', updateComponents: { surfaceId: 'booking', components: [
    { id: 'root', component: 'Column', children: ['head', 'name', 'party', 'seat', 'veg', 'btns'] },
    { id: 'head', component: 'Row', align: 'center', children: ['ic', 'title'] },
    { id: 'ic', component: 'Icon', name: 'event' },
    { id: 'title', component: 'Text', text: "**Table at Luigi's** · Friday" },
    { id: 'name', component: 'TextField', label: 'Name on the booking', placeholder: 'Your name', value: { '@path': '/name' }, '@checks': [{ condition: { '@call': 'required', args: { value: { '@path': '/name' } } }, message: 'Add a name' }] },
    { id: 'party', component: 'Slider', label: 'Party size', value: { '@path': '/party' }, min: 1, max: 8, steps: 7 },
    { id: 'seat', component: 'ChoicePicker', label: 'Seating', displayStyle: 'chips', options: [{ label: 'Inside', value: 'inside' }, { label: 'Patio', value: 'patio' }, { label: 'Bar', value: 'bar' }], value: { '@path': '/seating' } },
    { id: 'veg', component: 'CheckBox', label: 'Someone is vegetarian', value: { '@path': '/veg' } },
    { id: 'btns', component: 'Row', justify: 'end', children: ['menu', 'go'] },
    { id: 'menu_l', component: 'Text', text: 'See menu' },
    { id: 'menu', component: 'Button', variant: 'borderless', child: 'menu_l', action: { functionCall: { '@call': 'openUrl', args: { url: 'https://example.com/menu' } } } },
    { id: 'go_l', component: 'Text', text: 'Book it' },
    { id: 'go', component: 'Button', variant: 'primary', child: 'go_l', '@checks': [{ condition: { '@call': 'required', args: { value: { '@path': '/name' } } }, message: 'Add a name first' }],
      action: { event: { name: 'book', userMessage: { '@call': 'formatString', args: { value: 'Book a table for ${/party} under ${/name}' } }, context: { party: { '@path': '/party' }, seating: { '@path': '/seating' } } } } },
  ] } },
];
const plans = [
  { version: '1.0', createSurface: { surfaceId: 'plans', catalogId: CAT, dataModel: { plans: [
    { name: 'Mint Unlimited', price: 30, note: 'T-Mobile network' }, { name: 'Visible+', price: 45, note: 'Verizon network' }, { name: 'Verizon Welcome', price: 65, note: 'Two lines, autopay' },
  ] } } },
  { version: '1.0', updateComponents: { surfaceId: 'plans', components: [
    { id: 'root', component: 'Tabs', tabs: [{ title: 'Plans', child: 'list' }, { title: 'Why switch', child: 'why' }] },
    { id: 'list', component: 'Column', children: { componentId: 'card', path: '/plans' } },
    { id: 'card', component: 'Card', child: 'row' },
    { id: 'row', component: 'Row', align: 'center', justify: 'spaceBetween', children: ['info', 'price'] },
    { id: 'info', component: 'Column', weight: 1, children: ['pname', 'pnote'] },
    { id: 'pname', component: 'Text', text: { '@call': 'formatString', args: { value: '**${name}**' } } },
    { id: 'pnote', component: 'Text', variant: 'caption', text: { '@path': 'note' } },
    { id: 'price', component: 'Text', text: { '@call': 'formatCurrency', args: { value: { '@path': 'price' }, currency: 'USD', decimals: 0 } } },
    { id: 'why', component: 'Column', children: ['whyt', 'more'] },
    { id: 'whyt', component: 'Text', text: 'You pay **$140** for two lines now. Mint would be **$60**, about **$960 a year** less.' },
    { id: 'more', component: 'Modal', trigger: 'more_b', content: 'more_c' },
    { id: 'more_l', component: 'Text', text: 'How porting works' },
    { id: 'more_b', component: 'Button', child: 'more_l', action: { event: { name: 'noop' } } },
    { id: 'more_c', component: 'Text', text: '### Porting your number\nThe new carrier asks for your account and transfer PIN; the switch takes about an hour.' },
  ] } },
];

const s = await startServer({ name: 'a2ui-web-e2e' });
let browser;
try {
  const { api } = await s.signInScript('Claude: a2ui web test');
  const bot = (await api('GET', '/bots')).json.bots.find((b) => b.isPrimary);
  const token = crypto.createHmac('sha256', s.SECRET).update(`mcp:${bot.id}`).digest('hex');
  const tool = async (name, args) => (await (await fetch(`${s.BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result?.content?.[0]?.text ?? '';
  assert.match(await tool('show_a2ui', { title: 'Phone plans', messages: plans }), /^Shown/);
  assert.match(await tool('show_a2ui', { title: 'Dinner booking', messages: booking }), /^Shown/);

  const ownerKey = crypto.createHmac('sha256', s.SECRET).update('owner-login').digest('hex');
  const link = (await (await fetch(`${s.BASE}/api/auth/owner`, { method: 'POST', headers: { authorization: `Bearer ${ownerKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', link: true }) })).json()).url.replace(/^https?:\/\/[^/]+/, s.BASE);
  const { chromium } = await import('playwright');
  browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: process.env.SHOT_DIR ? 2 : 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(link);
  const card = page.locator('.view-card', { has: page.locator('[data-surface="booking"]') });
  await card.waitFor({ timeout: 20_000 });
  const shot = async (name, loc = card) => { if (process.env.SHOT_DIR) await loc.screenshot({ path: path.join(process.env.SHOT_DIR, `${name}.png`) }); };

  await test('the booking form draws natively: icon, field, slider, chips, check box, buttons', async () => {
    await card.locator('.a2ui-icon').first().waitFor();
    assert.equal(await card.locator('input[placeholder="Your name"]').count(), 1);
    assert.equal(await card.locator('input[type="range"]').inputValue(), '4');
    assert.equal(await card.locator('.quick-choice.is-chosen').innerText().then((t) => t.trim()), 'Patio');
    assert.equal(await card.getByRole('button', { name: 'Book it' }).isDisabled(), true, 'held back until the check passes');
    await shot('booking-light');
  });

  await test('typing a name turns the check on, and Book it posts the person’s message', async () => {
    await card.locator('input[placeholder="Your name"]').fill('Ada');
    await card.locator('.quick-choice', { hasText: 'Inside' }).click();
    await until('the button to turn on', async () => !(await card.getByRole('button', { name: 'Book it' }).isDisabled()));
    await card.getByRole('button', { name: 'Book it' }).click();
    await page.getByText('Book a table for 4 under Ada').first().waitFor({ timeout: 10_000 });
    const rows = (await api('GET', `/bots/${bot.id}/rows`)).json.rows;
    const b = rows.find((r) => r.body.card === 'view' && r.body.title === 'Dinner booking').body.blocks[0];
    assert.equal(b.surface.data.name, 'Ada');
    assert.deepEqual(b.surface.data.seating, ['inside']);
  });

  const plansCard = page.locator('.view-card', { has: page.locator('[data-surface="plans"]') });
  await test('tabs, a template list of cards with currency, and a modal', async () => {
    await plansCard.scrollIntoViewIfNeeded();
    assert.equal(await plansCard.locator('.a2ui-card').count(), 3);
    assert.match(await plansCard.innerText(), /Mint Unlimited[\s\S]*\$30/);
    await shot('plans-light', plansCard);
    await plansCard.getByRole('tab', { name: 'Why switch' }).click();
    await plansCard.getByRole('button', { name: 'How porting works' }).click();
    await page.locator('.a2ui-modal').waitFor();
    assert.match(await page.locator('.a2ui-modal').innerText(), /Porting your number/);
    await page.locator('.a2ui-modal__close').click();
    assert.equal(await page.locator('.a2ui-modal').count(), 0);
  });

  await test('dark theme draws too, with no page errors', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await card.scrollIntoViewIfNeeded();
    await shot('booking-dark');
    await plansCard.getByRole('tab', { name: 'Plans' }).click();
    await shot('plans-dark', plansCard);
    assert.deepEqual(errors, []);
  });
} finally {
  await browser?.close();
  await s.stop();
}
done();
