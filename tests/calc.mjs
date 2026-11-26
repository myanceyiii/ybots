// The calculator formula language (server/src/calc.ts). Needs a built server:
// `npm run build -w server`, then `node tests/calc.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const c = await import('../server/dist/calc.js');

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };
const run = (src, vars = {}) => c.evalCalc(c.parseCalc(src), vars);

test('the Android copy is identical to the shared file', () => {
  assert.equal(fs.readFileSync(new URL('../mobile/src/calc.ts', import.meta.url), 'utf8'), fs.readFileSync(new URL('../server/src/calc.ts', import.meta.url), 'utf8'));
});
test('arithmetic and precedence', () => {
  assert.equal(run('1 + 2 * 3'), 7);
  assert.equal(run('(1 + 2) * 3'), 9);
  assert.equal(run('-2 ^ 2'), -4);
  assert.equal(run('2 ^ 3 ^ 2'), 512);
  assert.equal(run('10 % 4'), 2);
  assert.equal(run('1e3 / 4'), 250);
  assert.equal(run('.5 + 1.25'), 1.75);
});
test('comparisons, logic and conditions', () => {
  assert.equal(run('3 > 2 && 1 == 1'), 1);
  assert.equal(run('!(3 > 2) || 0'), 0);
  assert.equal(run('x > 10 ? 1 : 2', { x: 11 }), 1);
  assert.equal(run('if(x > 10, 1, 2)', { x: 3 }), 2);
  assert.equal(run('a ? b ? 1 : 2 : 3', { a: 1, b: 0 }), 2);
});
test('functions', () => {
  assert.equal(run('round(2.345, 2)'), 2.35);
  assert.equal(run('round(2.5)'), 3);
  assert.equal(run('min(4, 2, 9) + max(1, 7)'), 9);
  assert.equal(run('sum(1, 2, 3) + avg(2, 4)'), 9);
  assert.equal(run('clamp(15, 0, 10)'), 10);
  assert.equal(run('sqrt(16) + abs(-1) + floor(1.9) + ceil(1.1) + pow(2, 3)'), 16);
  assert.ok(Math.abs(run('log(exp(2))') - 2) < 1e-12);
});
test('names: case-insensitive, unknown counts as 0, no object lookups', () => {
  assert.equal(run('Balance * 2', { balance: 5 }), 10);
  assert.equal(run('missing + 1'), 1);
  assert.equal(run('constructor + 1'), 1);
  assert.equal(run('__proto__ + 1'), 1);
  assert.ok(Number.isNaN(run('toString', Object.create({ tostring: 'x' }))) === false);
  assert.deepEqual([...c.calcNames(c.parseCalc('a + b * min(c, 2)'))].sort(), ['a', 'b', 'c']);
});
test('bad formulas are refused with a reason', () => {
  const bad = { '': /empty/, '1 +': /ends too soon/, '(1': /expected "\)"/, 'foo(1)': /unknown function "foo"/, 'round()': /round takes 1 to 2 values/,
    'pow(1)': /pow takes 2 values/, '1 $ 2': /can't read "\$"/, '1 2': /unexpected "2"/, 'x = 1': /can't read "="/, 'a.b': /can't read|unexpected/,
    'constructor(1)': /unknown function/, 'x["y"]': /can't read/ };
  for (const [src, re] of Object.entries(bad)) assert.throws(() => c.parseCalc(src), re, src);
  assert.throws(() => c.parseCalc('1+'.repeat(250) + '1'), /too long/);
  assert.throws(() => c.parseCalc('('.repeat(60) + '1' + ')'.repeat(60)), /too deep/);
});
test('division by zero and the like give nothing, not Infinity', () => {
  const out = c.runCalc([{ id: 'x', label: 'X', kind: 'number', value: 0 }], [{ id: 'y', label: 'Y', formula: '1 / x' }, { id: 'z', label: 'Z', formula: 'y + 1' }], {});
  assert.equal(out[0].value, null); assert.equal(out[0].text, '–');
  assert.equal(out[1].value, null);
});
test('runCalc: later outputs use earlier ones; values override defaults', () => {
  const inputs = [{ id: 'balance', label: 'Balance', kind: 'slider', value: 18000, min: 1000, max: 40000 }, { id: 'rate', label: 'Rate', kind: 'number', value: 6 }, { id: 'months', label: 'Term', kind: 'choice', value: 48 }];
  const outputs = [
    { id: 'pay', label: 'Monthly', formula: 'balance * (rate / 1200) / (1 - (1 + rate / 1200) ^ -months)', format: 'money' },
    { id: 'total', label: 'Total', formula: 'pay * months', format: 'money' },
  ];
  const out = c.runCalc(inputs, outputs, { months: 60 });
  assert.equal(out[0].text, '$347.99');
  assert.equal(out[1].text, '$20,879.43');
});
test('formatting', () => {
  assert.equal(c.formatCalc(1234.5, { format: 'money' }), '$1,234.50');
  assert.equal(c.formatCalc(-12, { format: 'money' }), '-$12.00');
  assert.equal(c.formatCalc(0.256, { format: 'percent' }), '25.6%');
  assert.equal(c.formatCalc(7, {}), '7');
  assert.equal(c.formatCalc(7.123, {}), '7.12');
  assert.equal(c.formatCalc(6.75, { decimals: 2, unit: '%' }), '6.75%');
  assert.equal(c.formatCalc(3, { unit: 'kWh' }), '3 kWh');
  assert.equal(c.formatCalc(2, { prefix: '€', decimals: 2 }), '€2.00');
  assert.equal(c.formatCalc(null, {}), '–');
  assert.equal(c.formatCalc(Number.NaN, {}), '–');
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
