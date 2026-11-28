// A2UI interfaces in answer views, end to end through the real server: a bot calls show_a2ui over /mcp with
// standard A2UI 1.0 messages, a person types into the fields (a2ui-set), a Button's checks hold it back until
// they pass, and a press (a2ui-action) becomes the person's chat message plus the standard A2UI action JSON
// for the bot. update_view applies updateDataModel on top of what the person typed. Nothing a bot sends can
// make the card run code or approve anything. Throwaway database, fake Hermes.
//   npm run build -w server && node tests/a2ui-e2e.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { runner, startServer, until } from './lib/server.mjs';

const { test, done } = runner();
const CAT = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
const s = await startServer({ name: 'a2ui-e2e' });
try {
  const { api } = await s.signInScript('Claude: a2ui test');
  const bot = (await api('GET', '/bots')).json.bots.find((b) => b.isPrimary);
  const rows = async () => (await api('GET', `/bots/${bot.id}/rows`)).json.rows;
  const token = crypto.createHmac('sha256', s.SECRET).update(`mcp:${bot.id}`).digest('hex');
  let rpc = 0;
  const mcp = async (method, params) => (await (await fetch(`${s.BASE}/mcp/${bot.id}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, params }) })).json());
  const tool = async (name, args) => (await mcp('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';

  const messages = [
    { version: '1.0', createSurface: { surfaceId: 'booking', catalogId: CAT, sendDataModel: true, dataModel: { party: 2, seating: ['inside'] } } },
    { version: '1.0', updateComponents: { surfaceId: 'booking', components: [
      { id: 'root', component: 'Card', child: 'col' },
      { id: 'col', component: 'Column', children: ['title', 'name', 'party', 'seat', 'when', 'go', 'menu'] },
      { id: 'title', component: 'Text', text: '### Table at Luigi’s' },
      { id: 'name', component: 'TextField', label: 'Name', value: { '@path': '/name' }, '@checks': [{ condition: { '@call': 'required', args: { value: { '@path': '/name' } } }, message: 'Add a name' }] },
      { id: 'party', component: 'Slider', label: 'Party size', value: { '@path': '/party' }, min: 1, max: 8, steps: 7 },
      { id: 'seat', component: 'ChoicePicker', label: 'Seating', options: [{ label: 'Inside', value: 'inside' }, { label: 'Patio', value: 'patio' }], value: { '@path': '/seating' }, displayStyle: 'chips' },
      { id: 'when', component: 'DateTimeInput', label: 'When', value: { '@path': '/when' }, enableDate: true, enableTime: true },
      { id: 'go_l', component: 'Text', text: 'Book it' },
      { id: 'go', component: 'Button', child: 'go_l', variant: 'primary',
        '@checks': [{ condition: { '@call': 'required', args: { value: { '@path': '/name' } } }, message: 'Add a name first' }],
        action: { event: { name: 'book_table', userMessage: { '@call': 'formatString', args: { value: 'Book a table for ${/party} under ${/name}' } }, context: { name: { '@path': '/name' }, party: { '@path': '/party' }, seating: { '@path': '/seating' } } } } },
      { id: 'menu_l', component: 'Text', text: 'Menu' },
      { id: 'menu', component: 'Button', child: 'menu_l', variant: 'borderless', action: { functionCall: { '@call': 'openUrl', args: { url: 'https://example.com/menu' } } } },
    ] } },
  ];

  await test('bots are offered show_a2ui, and show_view lists the a2ui block', async () => {
    const tools = (await mcp('tools/list')).result.tools;
    const t = tools.find((x) => x.name === 'show_a2ui');
    assert.ok(t, 'show_a2ui offered');
    assert.match(t.description, /A2UI 1\.0/);
    assert.match(tools.find((x) => x.name === 'show_view').description, /a2ui \{messages\}/);
  });

  let card;
  await test('a bot shows an A2UI interface: checked, stored as an a2ui block, with a text copy', async () => {
    const out = await tool('show_a2ui', { title: 'Dinner booking', messages });
    assert.match(out, /^Shown as view vw_\w+ \(block ids: v1=a2ui\)/, out);
    assert.doesNotMatch(out, /Left out/);
    card = (await rows()).find((r) => r.body.card === 'view');
    const b = card.body.blocks[0];
    assert.equal(b.type, 'a2ui');
    assert.equal(b.surface.surfaceId, 'booking');
    assert.equal(b.surface.components.name.component, 'TextField');
    assert.match(card.body.text, /\*\*Dinner booking\*\*/);
    assert.match(card.body.text, /- Name: \(blank\)/);
    assert.match(card.body.text, /\[Book it\]/);
  });

  await test('a bad interface is refused with reasons; bad parts are reported', async () => {
    const out = await tool('show_a2ui', { messages: [{ version: '1.0', createSurface: { surfaceId: 'x', catalogId: CAT, components: [{ id: 'nope', component: 'Text', text: 'no root' }] } }] });
    assert.match(out, /Nothing to show: block 1: a2ui: no component has id "root"/);
    const out2 = await tool('show_a2ui', { messages: [{ version: '1.0', createSurface: { surfaceId: 'y', catalogId: CAT, components: [
      { id: 'root', component: 'Column', children: ['t', 'h'] }, { id: 't', component: 'Text', text: 'ok' }, { id: 'h', component: 'WebView', url: 'https://evil.example' },
    ] } }] });
    assert.match(out2, /Shown/);
    assert.match(out2, /"WebView" is not in the Basic catalog/);
    assert.equal((await rows()).filter((r) => r.body.card === 'view').length, 2);
  });

  const view = (b) => api('POST', `/bots/${bot.id}/cards/${card.seq}/view`, { block: 'v1', ...b });
  const current = async () => (await rows()).find((r) => r.seq === card.seq).body.blocks[0];

  await test('the Button is held back until its checks pass, and nothing reaches the bot', async () => {
    const before = s.hermes.inputs.length;
    const r = await view({ op: 'a2ui-action', component: 'go', scope: '' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'Add a name first');
    assert.equal(s.hermes.inputs.length, before);
  });

  await test('a person sets inputs: each saved at its binding, checked for its kind', async () => {
    assert.equal((await view({ op: 'a2ui-set', component: 'name', scope: '', value: 'Ada' })).status, 200);
    assert.equal((await view({ op: 'a2ui-set', component: 'party', scope: '', value: 4.4 })).status, 200);
    assert.equal((await view({ op: 'a2ui-set', component: 'seat', scope: '', value: ['patio', 'roof'] })).status, 200);
    const b = await current();
    assert.equal(b.surface.data.name, 'Ada');
    assert.equal(b.surface.data.party, 4);
    assert.deepEqual(b.surface.data.seating, ['patio']);
    assert.equal((await view({ op: 'a2ui-set', component: 'party', scope: '', value: 'lots' })).status, 400);
    assert.equal((await view({ op: 'a2ui-set', component: 'title', scope: '', value: 'hacked' })).status, 400, 'a Text is not an input');
    assert.equal((await view({ op: 'a2ui-set', component: 'name', scope: '/__proto__', value: 'x' })).status, 400);
    const text = (await rows()).find((r) => r.seq === card.seq).body.text;
    assert.match(text, /- Name: Ada/);
  });

  await test('a press posts the person’s message and gives the bot the standard A2UI action', async () => {
    const before = s.hermes.inputs.length;
    const r = await view({ op: 'a2ui-action', component: 'go', scope: '', edits: [{ component: 'when', scope: '', value: '2026-11-28T19:30' }] });
    assert.equal(r.status, 200, r.text);
    const msg = (await rows()).filter((x) => x.kind === 'message' && x.body.role === 'user').at(-1);
    assert.equal(msg.body.text, 'Book a table for 4 under Ada');
    const told = await until('the bot to be told', () => s.hermes.inputs.slice(before).find((x) => x.includes('A2UI action')));
    const json = JSON.parse(JSON.parse(told).at(-1)?.content?.[0]?.text?.match?.(/\[A2UI action from your view \("Dinner booking"\): (\{.*\})\]/s)?.[1] ?? told.match(/(\{\\"version\\":\\"1\.0\\",\\"action\\".*?\}\})\]/)?.[1]?.replace(/\\"/g, '"') ?? 'null');
    assert.ok(json, `action JSON in: ${told.slice(0, 400)}`);
    assert.equal(json.action.name, 'book_table');
    assert.equal(json.action.surfaceId, 'booking');
    assert.equal(json.action.sourceComponentId, 'go');
    assert.deepEqual(json.action.context, { name: 'Ada', party: 4, seating: ['patio'] });
    assert.equal(json.action.metadata.a2uiRendererDataModel.surfaces.booking.when, '2026-11-28T19:30');
    assert.ok(!/approv/i.test(JSON.stringify(json)), 'no approval id or digest');
    assert.equal((await current()).sent.component, 'go');
  });

  await test('an openUrl button only opens a link; it never posts', async () => {
    const r = await view({ op: 'a2ui-action', component: 'menu', scope: '' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /only opens a link/);
  });

  await test('update_view applies the bot’s A2UI messages on top of what the person typed', async () => {
    const viewId = card.body.viewId;
    const out = await tool('update_view', { view_id: viewId, changes: [{ id: 'v1', messages: [
      { version: '1.0', updateDataModel: { surfaceId: 'booking', path: '/status', value: 'Booked for 7:30' } },
      { version: '1.0', updateComponents: { surfaceId: 'booking', components: [{ id: 'col', component: 'Column', children: ['title', 'status', 'name'] }, { id: 'status', component: 'Text', text: { '@path': '/status' } }] } },
    ] }] });
    assert.match(out, /^Updated/, out);
    const b = await current();
    assert.equal(b.surface.data.name, 'Ada', 'the person’s typing stays');
    assert.equal(b.surface.data.status, 'Booked for 7:30');
    const text = (await rows()).find((r) => r.seq === card.seq).body.text;
    assert.match(text, /Booked for 7:30/);
    assert.doesNotMatch(text, /Book it/, 'the button is gone from the layout');
    // A component no longer in the layout can't be pressed.
    assert.equal((await view({ op: 'a2ui-action', component: 'go', scope: '' })).status, 400);
  });

  await test('Open as Page keeps the interface as text', async () => {
    const r = await api('POST', `/bots/${bot.id}/cards/${card.seq}/page`, {});
    assert.equal(r.status, 200, r.text);
  });
} finally {
  if (process.exitCode) console.log(s.state.log.slice(-2000));
  await s.stop();
}
done();
