// The A2UI engine (server/src/a2ui.ts): reading A2UI 1.0 messages into one checked surface, bindings, the
// Basic catalog's functions and checks, inputs, actions and the text copy. Runs every official v1.0 example
// (tests/fixtures/a2ui, from @a2ui/web_core 0.16.1, Apache-2.0). Needs a built server:
//   npm run build -w server && node tests/a2ui.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
const a = await import('../server/dist/a2ui.js');

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };
const CAT = a.A2UI_BASIC_CATALOG;
const surf = (components, dataModel = {}, more = {}) => a.applyA2ui(null, [{ version: '1.0', createSurface: { surfaceId: 's', catalogId: CAT, components, dataModel, ...more } }]);

test('the Android copies are identical to the shared files', () => {
  for (const [m, s] of [['a2ui.ts', 'a2ui.ts'], ['a2uiIcons.ts', 'a2ui-icons.ts']]) {
    assert.equal(fs.readFileSync(new URL(`../mobile/src/${m}`, import.meta.url), 'utf8'), fs.readFileSync(new URL(`../server/src/${s}`, import.meta.url), 'utf8'), m);
  }
});

test('every official A2UI 1.0 Basic catalog example reads with no problems and has a text copy', () => {
  const dir = new URL('./fixtures/a2ui/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 40, `${files.length} examples`);
  for (const f of files) {
    const ex = JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'));
    const { surface, problems } = a.applyA2ui(null, ex.messages);
    assert.deepEqual(problems, [], f);
    assert.ok(surface.components.root, `${f} has a root`);
    assert.ok(a.surfaceText(surface).trim(), `${f} has a text copy`);
  }
});

test('every icon name in the catalog has a drawing', async () => {
  const { A2UI_ICON_PATHS } = await import('../server/dist/a2ui-icons.js');
  for (const n of a.A2UI_ICONS) assert.ok(A2UI_ICON_PATHS[n]?.length, n);
});

test('0.9 bindings and checks are read as 1.0', () => {
  const { surface, problems } = a.applyA2ui(null, [
    { version: 'v0.9', createSurface: { surfaceId: 'x', catalogId: CAT } },
    { version: 'v0.9', updateComponents: { surfaceId: 'x', components: [
      { id: 'root', component: 'Column', children: ['f'] },
      { id: 'f', component: 'TextField', label: 'Name', value: { path: '/name' }, checks: [{ call: 'required', args: { value: { path: '/name' } }, message: 'Need a name' }] },
    ] } },
    { version: 'v0.9', updateDataModel: { surfaceId: 'x', path: '/name', value: 'Ada' } },
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(surface.components.f.value, { '@path': '/name' });
  assert.deepEqual(surface.components.f['@checks'][0].condition, { '@call': 'required', args: { value: { '@path': '/name' } } });
  assert.equal(surface.data.name, 'Ada');
});

test('short forms bots write: {components, dataModel}', () => {
  const { surface, problems } = a.applyA2ui(null, { components: [{ id: 'root', component: 'Text', text: { '@path': '/t' } }], dataModel: { t: 'Hi' } });
  assert.deepEqual(problems, []);
  assert.equal(a.surfaceText(surface), 'Hi');
});

test('anything outside the Basic catalog is refused and reported', () => {
  const { surface, problems } = surf([
    { id: 'root', component: 'Column', children: ['ok', 'html', 'x', 'missing'] },
    { id: 'ok', component: 'Text', text: 'fine' },
    { id: 'html', component: 'HtmlView', html: '<script>alert(1)</script>' },
    { id: 'x', component: 'Button', child: 'ok', action: { functionCall: { '@call': 'eval', args: { code: '1' } } } },
    { id: 'old', component: { Text: { text: { literalString: 'v0.8' } } } },
  ]);
  assert.ok(problems.some((p) => /HtmlView" is not in the Basic catalog/.test(p)), problems.join('; '));
  assert.ok(problems.some((p) => /functionCall can only be openUrl|unknown function "eval"/.test(p)), problems.join('; '));
  assert.ok(problems.some((p) => /0\.8 component shape/.test(p)));
  assert.ok(problems.some((p) => /refers to "missing"/.test(p)));
  assert.deepEqual(Object.keys(surface.components).sort(), ['ok', 'root']);
  assert.ok(!JSON.stringify(surface).includes('<script>'));
  assert.match(a.applyA2ui(null, [{ version: '0.8', surfaceUpdate: {} }]).problems.join(), /version|0\.8/);
  assert.match(a.applyA2ui(null, [{ surfaceUpdate: { components: [] } }]).problems.join(), /0\.8 messages/);
});

test('unknown functions and unsafe regexes never run', () => {
  const { surface, problems } = surf([
    { id: 'root', component: 'TextField', label: 'Zip', value: { '@path': '/z' }, '@checks': [
      { condition: { '@call': 'regex', args: { value: { '@path': '/z' }, pattern: '(a+)+$' } }, message: 'bad' },
      { condition: { '@call': 'regex', args: { value: { '@path': '/z' }, pattern: '(?<=x)y' } }, message: 'lookbehind' },
      { condition: { '@call': 'fetch', args: { url: 'https://x' } }, message: 'net' },
    ] },
  ]);
  assert.ok(problems.some((p) => /backtrack/.test(p)));
  assert.ok(problems.some((p) => /lookbehind|dialect/.test(p)));
  assert.ok(problems.some((p) => /unknown function "fetch"/.test(p)));
  assert.equal(a.regexProblem('^[0-9]{5}$'), '');
  assert.equal(a.regexProblem('x'.repeat(300)), 'pattern is longer than 256 characters');
  assert.match(a.regexProblem('(\\w)\\1'), /backreferences/);
  // A refused pattern never matches, so the check fails safe.
  assert.deepEqual(a.failedChecks(surface.components.root, { data: { z: 'aaaa' }, scope: '' }).length, 3);
});

test('paths: relative paths in templates, no prototype keys, copies on write', () => {
  const d = { items: [{ n: 'a' }, { n: 'b' }] };
  assert.equal(a.getAt(d, a.absPath('n', '/items/1')), 'b');
  assert.equal(a.getAt(d, '/items/0/n'), 'a');
  assert.equal(a.pathParts('/__proto__/x'), null);
  const next = a.setAt(d, '/items/1/n', 'c');
  assert.equal(d.items[1].n, 'b');
  assert.equal(next.items[1].n, 'c');
  assert.deepEqual(a.setAt({}, '/list/0/x', 1), { list: [{ x: 1 }] });
  assert.equal(a.setAt({}, '/__proto__/polluted', 1).polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(a.cleanData(JSON.parse('{"__proto__": {"x": 1}, "ok": 2}')), { ok: 2 });
});

test('functions: formatString with nested calls, numbers, money, dates, plurals, logic', () => {
  const ctx = { data: { user: { name: 'Ada' }, n: 3, amt: 1234.5, when: '2026-11-27T14:30:00', items: [1, 2] }, scope: '' };
  const ev = (v) => a.evaluate(v, ctx);
  assert.equal(ev({ '@call': 'formatString', args: { value: 'Hi ${/user/name}, ${formatNumber(value: ${/amt}, decimals: 1)} \\${x}' } }), 'Hi Ada, 1,234.5 ${x}');
  assert.equal(ev({ '@call': 'formatCurrency', args: { value: { '@path': '/amt' }, currency: 'USD' } }), '$1,234.50');
  assert.equal(ev({ '@call': 'formatDate', args: { value: { '@path': '/when' }, format: "EEEE, MMM d 'at' h:mm a" } }), 'Friday, Nov 27 at 2:30 PM');
  assert.equal(ev({ '@call': 'formatDate', args: { value: '2026-01-05', format: 'yyyy-MM-dd' } }), '2026-01-05');
  assert.equal(ev({ '@call': 'pluralize', args: { value: { '@path': '/n' }, one: 'item', other: 'items' } }), 'items');
  assert.equal(ev({ '@call': 'pluralize', args: { value: 1, one: 'item', other: 'items' } }), 'item');
  assert.equal(ev({ '@call': 'and', args: { values: [true, { '@call': 'required', args: { value: { '@path': '/user/name' } } }] } }), true);
  assert.equal(ev({ '@call': 'not', args: { value: { '@call': 'email', args: { value: 'nope' } } } }), true);
  assert.deepEqual(ev({ '@call': 'length', args: { value: 'abc', min: 4 } }), { valid: false });
  assert.deepEqual(ev({ '@call': 'numeric', args: { value: '7', min: 1, max: 10 } }), { valid: true });
  assert.equal(a.evaluate({ '@call': '@index', args: { offset: 1 } }, { ...ctx, index: 2 }), 3);
});

test('templates draw one child per item, capped', () => {
  const { surface } = surf([
    { id: 'root', component: 'List', children: { componentId: 'row', path: '/rows' } },
    { id: 'row', component: 'Text', text: { '@call': 'formatString', args: { value: '${@index(offset: 1)}. ${name}' } } },
  ], { rows: Array.from({ length: 150 }, (_, i) => ({ name: `n${i}` })) });
  const kids = a.childrenOf(surface.components.root, { data: surface.data, scope: '' });
  assert.equal(kids.length, a.A2UI_LIMITS.template);
  assert.equal(kids[3].ctx.scope, '/rows/3');
  assert.equal(a.evalText(surface.components.row.text, kids[3].ctx), '4. n3');
  assert.match(a.surfaceText(surface), /^1\. n0\n2\. n1/);
});

test('inputs: each kind only takes a value of its kind', () => {
  const { surface } = surf([
    { id: 'root', component: 'Column', children: ['t', 'n', 'c', 'p', 'm', 's', 'd'] },
    { id: 't', component: 'TextField', label: 'T', value: { '@path': '/t' } },
    { id: 'n', component: 'TextField', label: 'N', value: { '@path': '/n' }, variant: 'number' },
    { id: 'c', component: 'CheckBox', label: 'C', value: { '@path': '/c' } },
    { id: 'p', component: 'ChoicePicker', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], value: { '@path': '/p' } },
    { id: 'm', component: 'ChoicePicker', variant: 'multipleSelection', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], value: { '@path': '/m' } },
    { id: 's', component: 'Slider', value: { '@path': '/s' }, min: 0, max: 10, steps: 5 },
    { id: 'd', component: 'DateTimeInput', value: { '@path': '/d' }, enableDate: true },
  ]);
  const C = surface.components;
  const ctx = { data: {}, scope: '' };
  assert.equal(a.inputValue(C.t, ctx, 'x'.repeat(5000)).length, 4000);
  assert.equal(a.inputValue(C.n, ctx, '42'), 42);
  assert.equal(a.inputValue(C.n, ctx, 'abc'), null);
  assert.equal(a.inputValue(C.c, ctx, 'yes'), null);
  assert.deepEqual(a.inputValue(C.p, ctx, ['b', 'a', 'zzz']), ['b']);
  assert.deepEqual(a.inputValue(C.m, ctx, ['b', 'a', 'zzz', 'a']), ['b', 'a']);
  assert.equal(a.inputValue(C.s, ctx, 7.1), 8);
  assert.equal(a.inputValue(C.s, ctx, 99), 10);
  assert.equal(a.inputValue(C.d, ctx, '2026-11-27'), '2026-11-27');
  assert.equal(a.inputValue(C.d, ctx, '<img>'), null);
  assert.equal(a.valuePath(C.t, ctx), '/t');
});

test('a button: context resolved, userMessage, label, checks; openUrl only https', () => {
  const { surface } = surf([
    { id: 'root', component: 'Column', children: ['go', 'web', 'bad'] },
    { id: 'lbl', component: 'Text', text: 'Book it' },
    { id: 'go', component: 'Button', child: 'lbl', variant: 'primary', '@checks': [{ condition: { '@call': 'required', args: { value: { '@path': '/when' } } }, message: 'Pick a time' }],
      action: { event: { name: 'book', userMessage: { '@call': 'formatString', args: { value: 'Book ${/when}' } }, context: { when: { '@path': '/when' }, table: 4 } } } },
    { id: 'web', component: 'Button', child: 'lbl', action: { functionCall: { '@call': 'openUrl', args: { url: 'https://example.com/menu' } } } },
    { id: 'bad', component: 'Button', child: 'lbl', action: { functionCall: { '@call': 'openUrl', args: { url: 'javascript:alert(1)' } } } },
  ], {});
  const C = surface.components;
  assert.deepEqual(a.failedChecks(C.go, { data: surface.data, scope: '' }), ['Pick a time']);
  const ctx = { data: { when: '7 PM' }, scope: '' };
  assert.deepEqual(a.failedChecks(C.go, ctx), []);
  assert.deepEqual(a.buttonAction(surface, C.go, ctx), { kind: 'event', name: 'book', context: { when: '7 PM', table: 4 }, userMessage: 'Book 7 PM', label: 'Book it' });
  assert.deepEqual(a.buttonAction(surface, C.web, ctx), { kind: 'open', url: 'https://example.com/menu' });
  assert.deepEqual(a.buttonAction(surface, C.bad, ctx), { kind: 'open', url: null });
  assert.equal(a.safeMediaUrl('http://x.com/a.png', true), null);
  assert.ok(a.safeMediaUrl('data:image/png;base64,iVBORw0KGgo=', true));
  assert.equal(a.safeMediaUrl('data:text/html;base64,PHNjcmlwdD4=', true), null);
});

test('updates: updateComponents replaces by id, updateDataModel null deletes, other surfaces skipped', () => {
  let { surface } = surf([{ id: 'root', component: 'Text', text: { '@path': '/t' } }], { t: 'one', gone: 1 });
  const r = a.applyA2ui(surface, [
    { version: '1.0', updateDataModel: { surfaceId: 's', path: '/t', value: 'two' } },
    { version: '1.0', updateDataModel: { surfaceId: 's', path: '/gone', value: null } },
    { version: '1.0', updateComponents: { surfaceId: 'other', components: [] } },
  ]);
  assert.equal(r.surface.data.t, 'two');
  assert.ok(!('gone' in r.surface.data));
  assert.ok(r.problems.some((p) => /one surface per view/.test(p)));
  assert.equal(surface.data.t, 'one', 'the old surface is not changed in place');
});

test('limits: huge data and too many components are cut', () => {
  const comps = [{ id: 'root', component: 'Column', children: [] }, ...Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, component: 'Text', text: 'x' }))];
  const { surface, problems } = surf(comps, { big: 'x'.repeat(3000) });
  assert.ok(Object.keys(surface.components).length <= a.A2UI_LIMITS.components);
  const big = surf([{ id: 'root', component: 'Text', text: 'x' }], { rows: Array.from({ length: 400 }, () => 'y'.repeat(400)) });
  assert.ok(big.problems.some((p) => /too big/.test(p)));
  void problems;
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
