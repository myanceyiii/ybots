/**
 * The calculator language for answer views (views.ts `calc` blocks): small arithmetic formulas a bot writes,
 * worked out by the apps as the person drags a slider or types a number. It is a tiny parser and evaluator
 * for numbers only. No names reach JavaScript, nothing is looked up on objects, and there are no loops, so a
 * formula can only ever give back a number (or nothing).
 *
 * Shared, word for word, by the server (checks and the text copy), the web app (as @shared/calc) and the
 * Android app (mobile/src/calc.ts, a copy; tests/calc.mjs fails if the two differ).
 *
 *   numbers 12, 3.5, 1e3     names of inputs and earlier outputs (a-z, 0-9, _)
 *   + - * / % ^ ( )          < <= > >= == != && || !     cond ? a : b
 *   min max round(x, d) floor ceil abs sqrt pow log exp if(cond, a, b) sum avg clamp(x, lo, hi)
 */

export type CalcAst =
  | { k: 'n'; v: number }
  | { k: 'v'; name: string }
  | { k: 'u'; op: '-' | '!'; a: CalcAst }
  | { k: 'b'; op: string; a: CalcAst; b: CalcAst }
  | { k: 't'; c: CalcAst; a: CalcAst; b: CalcAst }
  | { k: 'f'; name: string; args: CalcAst[] };

export const CALC_FUNCS: Record<string, [number, number]> = {
  min: [1, 20], max: [1, 20], round: [1, 2], floor: [1, 1], ceil: [1, 1], abs: [1, 1], sqrt: [1, 1], pow: [2, 2],
  log: [1, 1], exp: [1, 1], if: [3, 3], sum: [1, 20], avg: [1, 20], clamp: [3, 3],
};
const MAX_LEN = 400;
const MAX_DEPTH = 40;

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i));
    if (id) { out.push({ t: 'id', v: id[0].toLowerCase() }); i += id[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%^()<>!?:,'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
    throw new Error(`can't read "${ch}"`);
  }
  return out;
}

/** Parse a formula. Throws an Error with a short reason when it isn't one. */
export function parseCalc(src: string): CalcAst {
  if (typeof src !== 'string' || !src.trim()) throw new Error('empty formula');
  if (src.length > MAX_LEN) throw new Error('formula too long');
  const toks = lex(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const expect = (v: string) => { if (!isOp(v)) throw new Error(`expected "${v}"`); p++; };
  const deeper = <T>(f: () => T): T => { if (++depth > MAX_DEPTH) throw new Error('formula too deep'); try { return f(); } finally { depth--; } };

  const ternary = (): CalcAst => deeper(() => {
    const c = or();
    if (!isOp('?')) return c;
    p++;
    const a = ternary();
    expect(':');
    return { k: 't', c, a, b: ternary() };
  });
  const binary = (next: () => CalcAst, ops: string[]) => (): CalcAst => {
    let a = next();
    while (peek()?.t === 'op' && ops.includes(String(peek()!.v))) { const op = String(toks[p++].v); a = { k: 'b', op, a, b: next() }; }
    return a;
  };
  const unary = (): CalcAst => deeper(() => {
    if (isOp('-') || isOp('!')) { const op = toks[p++].v as '-' | '!'; return { k: 'u', op, a: unary() }; }
    if (isOp('+')) { p++; return unary(); }
    return power();
  });
  // Right-associative, and tighter than a leading minus: -2^2 is -4, 2^3^2 is 2^9.
  const power = (): CalcAst => {
    const a = primary();
    if (!isOp('^')) return a;
    p++;
    return { k: 'b', op: '^', a, b: unary() };
  };
  const mul = binary(unary, ['*', '/', '%']);
  const add = binary(mul, ['+', '-']);
  const cmp = binary(add, ['<', '<=', '>', '>=', '==', '!=']);
  const and = binary(cmp, ['&&']);
  const or = binary(and, ['||']);
  const primary = (): CalcAst => {
    const t = toks[p++];
    if (!t) throw new Error('formula ends too soon');
    if (t.t === 'num') return { k: 'n', v: t.v };
    if (t.t === 'id') {
      if (isOp('(')) {
        const arity = Object.prototype.hasOwnProperty.call(CALC_FUNCS, t.v) ? CALC_FUNCS[t.v] : null;
        if (!arity) throw new Error(`unknown function "${t.v}"`);
        p++;
        const args: CalcAst[] = [];
        if (!isOp(')')) { args.push(ternary()); while (isOp(',')) { p++; args.push(ternary()); } }
        expect(')');
        if (args.length < arity[0] || args.length > arity[1]) throw new Error(`${t.v} takes ${arity[0] === arity[1] ? arity[0] : `${arity[0]} to ${arity[1]}`} values`);
        return { k: 'f', name: t.v, args };
      }
      return { k: 'v', name: t.v };
    }
    if (t.v === '(') { const e = ternary(); expect(')'); return e; }
    throw new Error(`unexpected "${t.v}"`);
  };

  const ast = ternary();
  if (p < toks.length) throw new Error(`unexpected "${(toks[p] as any).v}"`);
  return ast;
}

/** Names a formula reads. */
export function calcNames(ast: CalcAst, out = new Set<string>()): Set<string> {
  switch (ast.k) {
    case 'v': out.add(ast.name); break;
    case 'u': calcNames(ast.a, out); break;
    case 'b': calcNames(ast.a, out); calcNames(ast.b, out); break;
    case 't': calcNames(ast.c, out); calcNames(ast.a, out); calcNames(ast.b, out); break;
    case 'f': ast.args.forEach((x) => calcNames(x, out)); break;
  }
  return out;
}

/** Work a parsed formula out. Unknown names count as 0; anything that isn't a finite number gives NaN. */
export function evalCalc(ast: CalcAst, vars: Record<string, number>): number {
  const ev = (n: CalcAst): number => {
    switch (n.k) {
      case 'n': return n.v;
      case 'v': { const v = Object.prototype.hasOwnProperty.call(vars, n.name) ? vars[n.name] : 0; return typeof v === 'number' ? v : Number.NaN; }
      case 'u': return n.op === '-' ? -ev(n.a) : (ev(n.a) ? 0 : 1);
      case 't': return ev(n.c) ? ev(n.a) : ev(n.b);
      case 'b': {
        if (n.op === '&&') return ev(n.a) && ev(n.b) ? 1 : 0;
        if (n.op === '||') return ev(n.a) || ev(n.b) ? 1 : 0;
        const a = ev(n.a);
        const b = ev(n.b);
        switch (n.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return a / b;
          case '%': return a % b;
          case '^': return a ** b;
          case '<': return a < b ? 1 : 0;
          case '<=': return a <= b ? 1 : 0;
          case '>': return a > b ? 1 : 0;
          case '>=': return a >= b ? 1 : 0;
          case '==': return a === b ? 1 : 0;
          case '!=': return a !== b ? 1 : 0;
        }
        return Number.NaN;
      }
      case 'f': {
        if (n.name === 'if') return ev(n.args[0]) ? ev(n.args[1]) : ev(n.args[2]);
        const x = n.args.map(ev);
        switch (n.name) {
          case 'min': return Math.min(...x);
          case 'max': return Math.max(...x);
          case 'round': { const d = Math.max(0, Math.min(10, Math.round(x[1] ?? 0))); const m = 10 ** d; return Math.round(x[0] * m) / m; }
          case 'floor': return Math.floor(x[0]);
          case 'ceil': return Math.ceil(x[0]);
          case 'abs': return Math.abs(x[0]);
          case 'sqrt': return Math.sqrt(x[0]);
          case 'pow': return x[0] ** x[1];
          case 'log': return Math.log(x[0]);
          case 'exp': return Math.exp(x[0]);
          case 'sum': return x.reduce((s, v) => s + v, 0);
          case 'avg': return x.reduce((s, v) => s + v, 0) / x.length;
          case 'clamp': return Math.min(Math.max(x[0], x[1]), x[2]);
        }
        return Number.NaN;
      }
    }
  };
  return ev(ast);
}

export interface CalcInput { id: string; label: string; kind: 'number' | 'slider' | 'choice' | 'toggle'; value: number; min?: number; max?: number; step?: number; prefix?: string; unit?: string; options?: { label: string; value: number }[] }
export interface CalcOutput { id: string; label: string; formula: string; format?: 'number' | 'money' | 'percent'; decimals?: number; prefix?: string; unit?: string; big?: boolean }

/** A number as the person reads it: money with commas and 2 places, percent (0.25 → 25%), or plain. */
export function formatCalc(v: number | null, o: { format?: string; decimals?: number; prefix?: string; unit?: string }): string {
  if (v === null || !Number.isFinite(v)) return '–';
  const fmt = o.format ?? 'number';
  const d = o.decimals ?? (fmt === 'money' ? 2 : fmt === 'percent' ? 1 : (Number.isInteger(v) ? 0 : 2));
  const n = fmt === 'percent' ? v * 100 : v;
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sign = n < 0 ? '-' : '';
  const prefix = o.prefix ?? (fmt === 'money' ? '$' : '');
  const unit = fmt === 'percent' ? '%' : !o.unit ? '' : o.unit === '%' ? '%' : ` ${o.unit}`;
  return `${sign}${prefix}${s}${unit}`;
}

/** Every output of a calculator for these input values, in order; later outputs may use earlier ones. */
export function runCalc(inputs: CalcInput[], outputs: CalcOutput[], values: Record<string, number>): { id: string; label: string; value: number | null; text: string }[] {
  const vars: Record<string, number> = {};
  for (const i of inputs) vars[i.id] = Number.isFinite(values[i.id]) ? values[i.id] : i.value;
  return outputs.map((o) => {
    let value: number | null = null;
    try { const v = evalCalc(parseCalc(o.formula), vars); value = Number.isFinite(v) ? v : null; } catch { value = null; }
    vars[o.id] = value ?? Number.NaN;
    return { id: o.id, label: o.label, value, text: formatCalc(value, o) };
  });
}
