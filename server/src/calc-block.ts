import { calcNames, formatCalc, parseCalc, runCalc, type CalcInput, type CalcOutput } from './calc.js';

/**
 * Calculator blocks (a `calc` in an answer view or on a Page): checking a bot's definition, the person's
 * values, and the calculator as text. Shared by views.ts and pages.ts so a calculator opened as a Page
 * keeps working there exactly as it did in the chat.
 */

const LIMITS = { calcInputs: 10, calcOutputs: 8, options: 12 } as const;
const s = (v: unknown, max: number) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
export type CalcBlock = { id: string; type: 'calc'; title?: string; inputs: CalcInput[]; outputs: CalcOutput[]; sendLabel?: string; values?: Record<string, number> };

const num = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);
const CALC_ID = /^[a-z_][a-z0-9_]{0,30}$/;

/**
 * A calculator: inputs the person changes (numbers, sliders, picks, switches) and outputs worked out from
 * formulas in the calc language (calc.ts). Every formula is parsed here, and may only read inputs and
 * earlier outputs, so a broken one is reported to the bot instead of showing a dash.
 */
export function calcBlock(raw: any, id: string): CalcBlock | string {
  const names = new Set<string>();
  const inputs: CalcInput[] = [];
  for (const [i, x] of (Array.isArray(raw?.inputs) ? raw.inputs : []).slice(0, LIMITS.calcInputs).entries()) {
    const iid = String(x?.id ?? '').toLowerCase();
    if (!CALC_ID.test(iid) || names.has(iid)) return `calc input ${i + 1} needs a unique id (letters, digits, _)`;
    names.add(iid);
    const kind = (['number', 'slider', 'choice', 'toggle'] as const).includes(x?.kind) ? x.kind : 'number';
    const options = kind === 'choice' ? (Array.isArray(x?.options) ? x.options : []).slice(0, LIMITS.options)
      .map((o: any) => ({ label: s(o?.label ?? o?.value, 80), value: num(o?.value) ?? 0 })) : undefined;
    if (kind === 'choice' && (!options || options.length < 2)) return `calc input "${iid}" (choice) needs at least two options with a number value`;
    let min = num(x?.min); let max = num(x?.max);
    if (kind === 'slider') { min ??= 0; max ??= 100; if (max <= min) return `calc input "${iid}": max must be above min`; }
    let value = num(x?.value) ?? (kind === 'choice' ? options![0].value : min ?? 0);
    if (kind === 'toggle') value = value ? 1 : 0;
    if (min !== undefined) value = Math.max(min, value);
    if (max !== undefined) value = Math.min(max, value);
    const step = num(x?.step);
    inputs.push({ id: iid, label: s(x?.label, 80) || iid, kind, value,
      ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(step && step > 0 ? { step } : {}),
      ...(x?.prefix ? { prefix: s(x.prefix, 6) } : {}), ...(x?.unit ? { unit: s(x.unit, 16) } : {}), ...(options ? { options } : {}) });
  }
  if (!inputs.length) return 'a calc needs inputs';
  const outputs: CalcOutput[] = [];
  for (const [i, x] of (Array.isArray(raw?.outputs) ? raw.outputs : []).slice(0, LIMITS.calcOutputs).entries()) {
    const oid = String(x?.id ?? `out${i + 1}`).toLowerCase();
    if (!CALC_ID.test(oid) || names.has(oid)) return `calc output ${i + 1} needs a unique id`;
    const formula = s(x?.formula, 400);
    try {
      const missing = [...calcNames(parseCalc(formula))].filter((n) => !names.has(n));
      if (missing.length) return `calc output "${oid}": unknown name ${missing.map((m) => `"${m}"`).join(', ')} (use input ids or earlier output ids)`;
    } catch (e) { return `calc output "${oid}": ${(e as Error).message}`; }
    names.add(oid);
    const format = (['number', 'money', 'percent'] as const).includes(x?.format) ? x.format : 'number';
    const decimals = num(x?.decimals);
    outputs.push({ id: oid, label: s(x?.label, 80) || oid, formula, format,
      ...(decimals !== undefined ? { decimals: Math.max(0, Math.min(6, Math.round(decimals))) } : {}),
      ...(x?.prefix ? { prefix: s(x.prefix, 6) } : {}), ...(x?.unit ? { unit: s(x.unit, 16) } : {}), ...(x?.big ? { big: true } : {}) });
  }
  if (!outputs.length) return 'a calc needs outputs with formulas';
  return { id, type: 'calc', ...(raw?.title ? { title: s(raw.title, 120) } : {}), inputs, outputs, ...(raw?.sendLabel ?? raw?.send_label ? { sendLabel: s(raw.sendLabel ?? raw.send_label, 60) } : {}) };
}

/** A calculator's current values: what the person set, or the starting values. */
export const calcValues = (b: any): Record<string, number> => Object.fromEntries(b.inputs.map((i: CalcInput) => [i.id, Number.isFinite(b.values?.[i.id]) ? b.values[i.id] : i.value]));
export const inputText = (i: CalcInput, v: number) => (i.kind === 'choice' ? i.options?.find((o) => o.value === v)?.label ?? String(v) : i.kind === 'toggle' ? (v ? 'yes' : 'no') : formatCalc(v, { prefix: i.prefix ?? '', unit: i.unit }));

/** A person's calculator values, kept inside each input's range and options. */
export function cleanCalcValues(b: any, raw: unknown): Record<string, number> {
  const given = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const out: Record<string, number> = {};
  for (const i of b.inputs as CalcInput[]) {
    let v = num(given[i.id]) ?? (Number.isFinite(b.values?.[i.id]) ? b.values[i.id] : i.value);
    if (i.kind === 'toggle') v = v ? 1 : 0;
    if (i.kind === 'choice' && !i.options?.some((o) => o.value === v)) v = i.value;
    if (i.min !== undefined) v = Math.max(i.min, v);
    if (i.max !== undefined) v = Math.min(i.max, v);
    out[i.id] = v;
  }
  return out;
}

/** The chat message "Send these numbers" posts: the inputs and the results as they are now. */
export function calcMessage(b: any, where = ''): string {
  const vals = calcValues(b);
  const res = runCalc(b.inputs, b.outputs, vals);
  return `${b.title ? `${b.title}${where}` : `Calculator${where}`}:\n${b.inputs.map((i: CalcInput) => `- ${i.label}: ${inputText(i, vals[i.id])}`).join('\n')}\n${res.map((r) => `- ${r.label}: ${r.text}`).join('\n')}`;
}

/** The calculator as table rows (label, value, how), for exports. */
export function calcRows(b: any): string[][] {
  const vals = calcValues(b);
  const res = runCalc(b.inputs, b.outputs, vals);
  return [...b.inputs.map((i: CalcInput) => [i.label, inputText(i, vals[i.id]), 'input']), ...res.map((r, k) => [r.label, r.text, b.outputs[k].formula])];
}
