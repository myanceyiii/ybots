/**
 * A2UI (Agent-to-User Interface, https://a2ui.org, Apache-2.0) for answer views: a bot can describe an
 * interface as standard A2UI 1.0 JSON from the Basic catalog (Rows, Columns, Cards, Tabs, text fields,
 * check boxes, choice pickers, sliders, date inputs, buttons...) and every app draws it natively with its
 * own components. This file is the whole engine: it reads the bot's A2UI messages into one checked
 * surface, resolves data bindings and the Basic catalog's functions, runs validation checks, and writes the
 * text copy. The renderers (web ViewCard + A2uiView, Android A2uiView) only draw what it gives them.
 *
 * Shared, word for word, by the server, the web app (as @shared/a2ui) and the Android app
 * (mobile/src/a2ui.ts, a copy; tests/a2ui.mjs fails if the two differ). No imports, so it runs anywhere.
 *
 * Safety: a surface is data, never code. Only Basic catalog components and functions are accepted; there is
 * no HTML, no scripts and no custom catalogs. Media and links must be https (images may also be data:image).
 * Regex checks use a restricted dialect with length caps. A Button's event reaches the bot as an ordinary
 * chat message from the person who pressed it (plus the standard A2UI action JSON), so it is never an
 * approval; openUrl only opens an https link after a tap.
 *
 * The expression syntax inside formatString (`${/path}`, `${fn(arg: value)}`) follows the A2UI web_core
 * expression parser (Copyright 2024 Google LLC, Apache-2.0); this is a smaller re-implementation.
 */

export const A2UI_VERSION = '1.0';
export const A2UI_BASIC_CATALOG = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
export const A2UI_LIMITS = { components: 300, children: 60, template: 100, text: 4000, data: 64_000, depth: 30, valueDepth: 12, options: 60, tabs: 12, checks: 8 } as const;

export type A2uiComponent = { id: string; component: string } & Record<string, any>;
export type A2uiSurface = {
  surfaceId: string;
  catalogId: string;
  components: Record<string, A2uiComponent>;
  data: any;
  /** The bot asked for the data model with every action (createSurface.sendDataModel). */
  sendDataModel?: boolean;
};
/** Where a component is drawn: the data it reads and, inside a template, the item it belongs to. */
export type A2uiCtx = { data: any; scope: string; index?: number };

const ENUMS: Record<string, Record<string, string[]>> = {
  Text: { variant: ['caption', 'body'] },
  Image: { fit: ['contain', 'cover', 'fill', 'none', 'scaleDown'], variant: ['icon', 'avatar', 'smallFeature', 'mediumFeature', 'largeFeature', 'header'] },
  Row: { justify: ['center', 'end', 'spaceAround', 'spaceBetween', 'spaceEvenly', 'start', 'stretch'], align: ['start', 'center', 'end', 'stretch'] },
  Column: { justify: ['start', 'center', 'end', 'spaceBetween', 'spaceAround', 'spaceEvenly', 'stretch'], align: ['center', 'end', 'start', 'stretch'] },
  List: { direction: ['vertical', 'horizontal'], align: ['start', 'center', 'end', 'stretch'] },
  Divider: { axis: ['horizontal', 'vertical'] },
  Button: { variant: ['default', 'primary', 'borderless'] },
  TextField: { variant: ['longText', 'number', 'shortText', 'obscured'] },
  ChoicePicker: { variant: ['multipleSelection', 'mutuallyExclusive'], displayStyle: ['checkbox', 'chips'] },
};
/** Each Basic catalog component: its dynamic props, its child props, plain props, and what it must have. */
const SPEC: Record<string, { dyn?: string[]; child?: string[]; kids?: boolean; plain?: string[]; req: string[]; checks?: boolean }> = {
  Text: { dyn: ['text'], req: ['text'] },
  Image: { dyn: ['url', 'description'], req: ['url'] },
  Icon: { req: ['name'] },
  Video: { dyn: ['url', 'posterUrl'], req: ['url'] },
  AudioPlayer: { dyn: ['url', 'description'], req: ['url'] },
  Row: { kids: true, req: ['children'] },
  Column: { kids: true, req: ['children'] },
  List: { kids: true, req: ['children'] },
  Card: { child: ['child'], req: ['child'] },
  Tabs: { req: ['tabs'] },
  Modal: { child: ['trigger', 'content'], req: ['trigger', 'content'] },
  Divider: { req: [] },
  Button: { child: ['child'], req: ['child', 'action'], checks: true },
  TextField: { dyn: ['label', 'value', 'placeholder'], req: ['label', 'value'], checks: true },
  CheckBox: { dyn: ['label', 'value'], req: ['label', 'value'], checks: true },
  ChoicePicker: { dyn: ['label', 'value'], plain: ['filterable'], req: ['options', 'value'], checks: true },
  Slider: { dyn: ['label', 'value'], plain: ['min', 'max', 'steps'], req: ['value', 'max'], checks: true },
  DateTimeInput: { dyn: ['value', 'label', 'min', 'max'], plain: ['enableDate', 'enableTime'], req: ['value'], checks: true },
};
export const A2UI_COMPONENTS = Object.keys(SPEC);
/** Components a person types into or sets; their `value` binding is the only data a person can change. */
export const A2UI_INPUTS = new Set(['TextField', 'CheckBox', 'ChoicePicker', 'Slider', 'DateTimeInput']);
export const A2UI_FUNCTIONS = ['required', 'regex', 'length', 'numeric', 'email', 'formatString', 'formatNumber', 'formatCurrency', 'formatDate', 'pluralize', 'openUrl', 'and', 'or', 'not', '@index', 'now'];
export const A2UI_ICONS = ['accountCircle', 'add', 'arrowBack', 'arrowForward', 'attachFile', 'calendarToday', 'call', 'camera', 'check', 'close', 'delete', 'download', 'edit', 'event', 'error', 'fastForward', 'favorite', 'favoriteOff', 'folder', 'help', 'home', 'info', 'locationOn', 'lock', 'lockOpen', 'mail', 'menu', 'moreVert', 'moreHoriz', 'notificationsOff', 'notifications', 'pause', 'payment', 'person', 'phone', 'photo', 'play', 'print', 'refresh', 'rewind', 'search', 'send', 'settings', 'share', 'shoppingCart', 'skipNext', 'skipPrevious', 'star', 'starHalf', 'starOff', 'stop', 'upload', 'visibility', 'visibilityOff', 'volumeDown', 'volumeMute', 'volumeOff', 'volumeUp', 'warning'];

const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ID_RE = /^[\w.:-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (v: unknown, max: number) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);

/** A copy of JSON data with nothing but JSON in it: no prototype keys, bounded depth and string length. */
export function cleanData(v: unknown, depth = 0): any {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.slice(0, A2UI_LIMITS.text);
  if (depth > 20) return null;
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => cleanData(x, depth + 1));
  if (isObj(v)) {
    const out: Record<string, any> = {};
    for (const [k, x] of Object.entries(v).slice(0, 500)) if (!BAD_KEYS.has(k) && x !== undefined) out[k] = cleanData(x, depth + 1);
    return out;
  }
  return null;
}

// ---- JSON Pointer paths ------------------------------------------------------------------------------

/** A path's segments (RFC 6901), or null when it names a key nobody may touch. */
export function pathParts(p: string): string[] | null {
  if (p === '' || p === '/') return [];
  const parts = p.replace(/^\//, '').split('/').map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'));
  return parts.some((x) => BAD_KEYS.has(x)) || parts.length > 32 ? null : parts;
}
/** An absolute path for `p`: absolute paths stay, relative ones hang off the template item (`scope`). */
export function absPath(p: string, scope: string): string {
  const s = String(p ?? '').trim();
  if (s.startsWith('/')) return s;
  if (!s || s === '.') return scope || '/';
  return `${scope.replace(/\/$/, '')}/${s.replace(/^\.\//, '')}`;
}
export function getAt(data: any, p: string): any {
  const parts = pathParts(p);
  if (!parts) return undefined;
  let cur = data;
  for (const k of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[Number(k)] : Object.prototype.hasOwnProperty.call(cur, k) ? cur[k] : undefined;
  }
  return cur;
}
/** `data` with `value` at `p` (copied along the way; undefined deletes). Missing objects are made. */
export function setAt(data: any, p: string, value: any): any {
  const parts = pathParts(p);
  if (!parts) return data;
  if (!parts.length) return value === undefined ? {} : value;
  const put = (cur: any, i: number): any => {
    const k = parts[i];
    const last = i === parts.length - 1;
    const asArray = Array.isArray(cur) || (cur == null && /^\d+$/.test(k));
    const base: any = asArray ? (Array.isArray(cur) ? [...cur] : []) : isObj(cur) ? { ...cur } : {};
    if (asArray) {
      const n = Number(k);
      if (!Number.isInteger(n) || n < 0 || n > 1000) return base;
      if (last) { if (value === undefined) base.splice(n, 1); else base[n] = value; }
      else base[n] = put(base[n], i + 1);
    } else if (last) { if (value === undefined) delete base[k]; else base[k] = value; }
    else base[k] = put(base[k], i + 1);
    return base;
  };
  return put(data, 0);
}

// ---- Reading the bot's messages ------------------------------------------------------------------------

/** One dynamic value in 1.0 form: `{path}` and `{call}` from 0.9 become `{@path}` and `{@call}`. */
function dynValue(v: any, problems: string[], where: string, depth = 0): any {
  if (depth > A2UI_LIMITS.valueDepth) { problems.push(`${where}: nested too deeply`); return ''; }
  if (typeof v === 'string') return v.slice(0, A2UI_LIMITS.text);
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean' || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => dynValue(x, problems, where, depth + 1));
  if (!isObj(v)) return '';
  const path = v['@path'] ?? (v.call === undefined ? v.path : undefined);
  if (typeof path === 'string' && Object.keys(v).length === 1) return pathParts(absPath(path, '/x')) ? { '@path': path.slice(0, 300) } : '';
  const call = v['@call'] ?? v.call;
  if (typeof call === 'string') {
    if (!A2UI_FUNCTIONS.includes(call)) { problems.push(`${where}: unknown function "${clip(call, 30)}" (only the Basic catalog's)`); return ''; }
    const args: Record<string, any> = {};
    for (const [k, x] of Object.entries(isObj(v.args) ? v.args : {})) if (!BAD_KEYS.has(k)) args[k] = dynValue(x, problems, where, depth + 1);
    if (call === 'regex') {
      const bad = regexProblem(args.pattern);
      if (bad) { problems.push(`${where}: regex ${bad}`); args.pattern = '(?!)'; }
    }
    return { '@call': call, args };
  }
  // A literal object (DynamicValue allows one): kept as data.
  return cleanData(Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('@'))));
}

function childRef(v: unknown): string | null { return typeof v === 'string' && ID_RE.test(v) ? v : null; }

/** One component, checked against the Basic catalog. A string is the reason it was left out. */
function oneComponent(raw: any, problems: string[]): A2uiComponent | string {
  if (!isObj(raw)) return 'not an object';
  const id = childRef(raw.id);
  if (!id) return `bad id "${clip(raw.id, 40)}"`;
  // 0.8 wrapped each component as {component: {Text: {...}}}; it is not supported, so say so plainly.
  if (isObj(raw.component)) return `${id}: A2UI 0.8 component shape; use 1.0 ("component": "Text", props alongside)`;
  const kind = String(raw.component ?? '');
  const spec = SPEC[kind];
  if (!spec) return `${id}: "${clip(kind, 30)}" is not in the Basic catalog`;
  if (raw['@catalogId'] && raw['@catalogId'] !== A2UI_BASIC_CATALOG) return `${id}: only the Basic catalog is supported`;
  for (const r of spec.req) if (raw[r] === undefined) return `${id}: ${kind} needs "${r}"`;
  const c: A2uiComponent = { id, component: kind };
  const where = `${id} (${kind})`;
  for (const k of spec.dyn ?? []) if (raw[k] !== undefined) c[k] = dynValue(raw[k], problems, where);
  for (const k of spec.child ?? []) { const r = childRef(raw[k]); if (!r) return `${id}: "${k}" must be a component id`; c[k] = r; }
  for (const k of spec.plain ?? []) if (raw[k] !== undefined) c[k] = typeof raw[k] === 'number' ? (Number.isFinite(raw[k]) ? raw[k] : 0) : !!raw[k];
  for (const [k, vals] of Object.entries(ENUMS[kind] ?? {})) if (typeof raw[k] === 'string' && vals.includes(raw[k])) c[k] = raw[k];
  if (typeof raw.weight === 'number' && raw.weight > 0 && raw.weight <= 100) c.weight = raw.weight;
  if (isObj(raw['@accessibility'])) {
    const a = raw['@accessibility'];
    c['@accessibility'] = { ...(a.label !== undefined ? { label: dynValue(a.label, problems, where) } : {}), ...(a.description !== undefined ? { description: dynValue(a.description, problems, where) } : {}), ...(a.hidden === true ? { hidden: true } : {}) };
  }
  if (spec.kids) {
    const ch = raw.children;
    if (Array.isArray(ch)) c.children = ch.map(childRef).filter(Boolean).slice(0, A2UI_LIMITS.children);
    else if (isObj(ch) && childRef(ch.componentId) && typeof ch.path === 'string' && pathParts(absPath(ch.path, '/x'))) c.children = { componentId: ch.componentId, path: ch.path.slice(0, 300) };
    else return `${id}: children must be a list of ids or {componentId, path}`;
  }
  switch (kind) {
    case 'Icon': {
      const n = raw.name;
      if (typeof n === 'string') c.name = A2UI_ICONS.includes(n) ? n : 'help';
      else if (isObj(n) && n.svgPath !== undefined) {
        const d = typeof n.svgPath === 'string' ? n.svgPath : '';
        c.name = d ? (svgPathOk(d) ? { svgPath: d } : 'help') : { svgPath: dynValue(n.svgPath, problems, where) };
      } else c.name = dynValue(n, problems, where);
      break;
    }
    case 'Tabs': {
      const tabs = (Array.isArray(raw.tabs) ? raw.tabs : []).slice(0, A2UI_LIMITS.tabs)
        .map((t: any) => (isObj(t) && childRef(t.child) ? { title: dynValue(t.title ?? '', problems, where), child: t.child } : null)).filter(Boolean);
      if (!tabs.length) return `${id}: Tabs need tabs with a title and child`;
      c.tabs = tabs;
      break;
    }
    case 'Button': {
      const a = raw.action;
      if (isObj(a?.event) && typeof a.event.name === 'string' && a.event.name.trim()) {
        const ctx: Record<string, any> = {};
        for (const [k, x] of Object.entries(isObj(a.event.context) ? a.event.context : {}).slice(0, 30)) if (!BAD_KEYS.has(k)) ctx[k] = dynValue(x, problems, where);
        c.action = { event: { name: clip(a.event.name, 80), ...(a.event.userMessage !== undefined ? { userMessage: dynValue(a.event.userMessage, problems, where) } : {}), context: ctx } };
      } else if (isObj(a?.functionCall)) {
        const f = dynValue(a.functionCall, problems, where);
        if (!isObj(f) || f['@call'] !== 'openUrl') return `${id}: a Button's functionCall can only be openUrl`;
        c.action = { functionCall: f };
      } else return `${id}: a Button needs action {event: {name}} or {functionCall: openUrl}`;
      break;
    }
    case 'ChoicePicker': {
      const opts = (Array.isArray(raw.options) ? raw.options : []).slice(0, A2UI_LIMITS.options)
        .map((o: any) => (isObj(o) && o.value != null ? { label: dynValue(o.label ?? String(o.value), problems, where), value: clip(o.value, 200) } : null)).filter(Boolean);
      if (!opts.length) return `${id}: a ChoicePicker needs options with label and value`;
      c.options = opts;
      break;
    }
  }
  if (spec.checks) {
    const list = raw['@checks'] ?? raw.checks;
    if (Array.isArray(list)) {
      c['@checks'] = list.slice(0, A2UI_LIMITS.checks).map((r: any) => {
        // 0.9.1: {call, args, message}; 1.0: {condition, message}.
        const cond = r?.condition ?? (r?.call || r?.['@call'] ? { '@call': r.call ?? r['@call'], args: r.args } : undefined);
        return cond === undefined ? null : { condition: dynValue(cond, problems, where), ...(r.message ? { message: clip(r.message, 200) } : {}) };
      }).filter(Boolean);
    }
  }
  return c;
}

/** Version strings A2UI renderers accept here. 0.8 used other message names and is turned away. */
const VERSIONS = new Set(['1.0', 'v1.0', '0.9', 'v0.9', '0.9.1', 'v0.9.1']);

/**
 * Applies a bot's A2UI messages (createSurface, updateComponents, updateDataModel) to a surface, or makes
 * one. Also takes the short forms bots tend to write: {components, dataModel} or {surface: {...}}.
 * Everything wrong is reported in `problems` so the bot can fix it.
 */
export function applyA2ui(prev: A2uiSurface | null, input: unknown): { surface: A2uiSurface | null; problems: string[] } {
  const problems: string[] = [];
  let surface: A2uiSurface | null = prev ? { ...prev, components: { ...prev.components } } : null;
  let msgs: any[] = [];
  if (Array.isArray(input)) msgs = input;
  else if (isObj(input) && Array.isArray(input.messages)) msgs = input.messages;
  else if (isObj(input)) {
    const s = isObj(input.surface) ? input.surface : input;
    msgs = [{ createSurface: { surfaceId: s.surfaceId ?? prev?.surfaceId ?? 'main', components: s.components, dataModel: s.dataModel ?? s.data, sendDataModel: s.sendDataModel } }];
  }
  const ensure = (id: unknown) => {
    if (!surface) surface = { surfaceId: childRef(id) ?? 'main', catalogId: A2UI_BASIC_CATALOG, components: {}, data: {} };
    return surface;
  };
  const addComponents = (list: unknown) => {
    const s = ensure(undefined);
    for (const raw of (Array.isArray(list) ? list : []).slice(0, A2UI_LIMITS.components)) {
      const c = oneComponent(raw, problems);
      if (typeof c === 'string') problems.push(c);
      else s.components[c.id] = c;
    }
    if (Object.keys(s.components).length > A2UI_LIMITS.components) problems.push(`only ${A2UI_LIMITS.components} components are kept`);
  };
  msgs.slice(0, 50).forEach((m: any, i: number) => {
    if (!isObj(m)) { problems.push(`message ${i + 1}: not an object`); return; }
    if (m.version !== undefined && !VERSIONS.has(String(m.version))) { problems.push(`message ${i + 1}: version "${clip(m.version, 10)}" (use "1.0")`); return; }
    if (m.surfaceUpdate || m.dataModelUpdate || m.beginRendering) { problems.push(`message ${i + 1}: A2UI 0.8 messages aren't supported; send 1.0 createSurface/updateComponents/updateDataModel`); return; }
    const body = m.createSurface ?? m.updateComponents ?? m.updateDataModel ?? m.deleteSurface;
    if (!isObj(body)) { problems.push(`message ${i + 1}: expected createSurface, updateComponents or updateDataModel`); return; }
    if (surface && body.surfaceId !== undefined && body.surfaceId !== surface.surfaceId) { problems.push(`message ${i + 1}: one surface per view ("${surface.surfaceId}"); "${clip(body.surfaceId, 40)}" skipped`); return; }
    if (m.createSurface) {
      if (body.catalogId && body.catalogId !== A2UI_BASIC_CATALOG && !String(body.catalogId).includes('/catalogs/basic/')) problems.push(`only the Basic catalog is supported; drawing with it anyway`);
      // A createSurface again starts the surface over (a bot redrawing it), rather than failing.
      surface = { surfaceId: childRef(body.surfaceId) ?? surface?.surfaceId ?? 'main', catalogId: A2UI_BASIC_CATALOG, components: {}, data: cleanData(isObj(body.dataModel) ? body.dataModel : {}), ...(body.sendDataModel === true ? { sendDataModel: true } : {}) };
      if (body.components) addComponents(body.components);
    } else if (m.updateComponents) addComponents(body.components);
    else if (m.updateDataModel) {
      const s = ensure(body.surfaceId);
      const p = typeof body.path === 'string' ? body.path : '/';
      if (!pathParts(p)) { problems.push(`message ${i + 1}: bad path`); return; }
      // 1.0: value null deletes the key; 0.9 deleted when value was left out.
      const value = body.value === null || body.value === undefined ? undefined : cleanData(body.value);
      s.data = setAt(s.data, p, value);
      if (!isObj(s.data) && !Array.isArray(s.data)) s.data = {};
    } else problems.push(`message ${i + 1}: deleteSurface is ignored; the bot's view stays in the chat`);
  });
  if (surface) {
    const s: A2uiSurface = surface;
    if (JSON.stringify(s.data).length > A2UI_LIMITS.data) { problems.push('the data model is too big (64 KB at most)'); s.data = {}; }
    if (!s.components.root) problems.push('no component has id "root", so nothing shows');
    for (const c of Object.values(s.components)) {
      for (const ref of refsOf(c)) if (!s.components[ref]) problems.push(`${c.id} refers to "${ref}", which doesn't exist`);
    }
  }
  return { surface, problems: [...new Set(problems)].slice(0, 20) };
}

function refsOf(c: A2uiComponent): string[] {
  const out: string[] = [];
  if (Array.isArray(c.children)) out.push(...c.children);
  else if (isObj(c.children)) out.push(c.children.componentId);
  for (const k of ['child', 'trigger', 'content']) if (typeof c[k] === 'string') out.push(c[k]);
  if (Array.isArray(c.tabs)) out.push(...c.tabs.map((t: any) => t.child));
  return out;
}

function svgPathOk(d: string): boolean { return d.length <= 4000 && /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-eE]*$/.test(d); }

/**
 * Why a regex check's pattern is refused, or '' when it is fine. The A2UI dialect: ECMAScript in unicode
 * mode without backreferences, lookbehind, named groups, \p{...} or inline flags, at most 256 characters,
 * and no quantified group that itself holds a quantifier (the usual catastrophic-backtracking shape).
 */
export function regexProblem(pattern: unknown): string {
  if (typeof pattern !== 'string') return 'needs a pattern string';
  if ([...pattern].length > 256) return 'pattern is longer than 256 characters';
  if (/\\[1-9]|\\k<|\(\?<[=!]|\(\?<[A-Za-z]|\\[pP]\{|\(\?[a-z]/.test(pattern)) return 'uses a feature the A2UI dialect leaves out (backreferences, lookbehind, named groups, \\p{} or flags)';
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) return 'could backtrack catastrophically (a repeated group that repeats inside)';
  try { new RegExp(pattern, 'u'); } catch { return 'is not a valid pattern'; }
  return '';
}

// ---- Resolving values -----------------------------------------------------------------------------------

const truthy = (v: any): boolean => (isObj(v) && typeof v.valid === 'boolean' ? v.valid : !!v);
const num = (v: any): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN);
const valid = (ok: boolean) => ({ valid: ok });

/** A dynamic value worked out for one place in the surface: a literal, a data binding or a function call. */
export function evaluate(v: any, ctx: A2uiCtx, depth = 0): any {
  if (depth > A2UI_LIMITS.valueDepth) return undefined;
  if (Array.isArray(v)) return v.map((x) => evaluate(x, ctx, depth + 1));
  if (!isObj(v)) return v;
  if (typeof v['@path'] === 'string') return getAt(ctx.data, absPath(v['@path'], ctx.scope));
  if (typeof v['@call'] === 'string') return callFn(v['@call'], isObj(v.args) ? v.args : {}, ctx, depth);
  return v;
}

/** A value as display text. */
export function evalText(v: any, ctx: A2uiCtx): string {
  const r = evaluate(v, ctx);
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r === 'number' || typeof r === 'boolean') return String(r);
  return JSON.stringify(r).slice(0, 500);
}

function callFn(name: string, rawArgs: Record<string, any>, ctx: A2uiCtx, depth: number): any {
  const a = (k: string) => evaluate(rawArgs[k], ctx, depth + 1);
  switch (name) {
    case 'required': { const v = a('value'); return valid(!(v == null || v === '' || (Array.isArray(v) && !v.length))); }
    case 'regex': {
      const v = a('value');
      const p = rawArgs.pattern;
      if (typeof v !== 'string' || [...v].length > 4096 || regexProblem(p)) return valid(false);
      try { return valid(new RegExp(p, 'u').test(v)); } catch { return valid(false); }
    }
    case 'length': {
      const n = [...String(a('value') ?? '')].length;
      const min = num(a('min')); const max = num(a('max'));
      return valid((Number.isNaN(min) || n >= min) && (Number.isNaN(max) || n <= max));
    }
    case 'numeric': {
      const n = num(a('value'));
      const min = num(a('min')); const max = num(a('max'));
      return valid(!Number.isNaN(n) && (Number.isNaN(min) || n >= min) && (Number.isNaN(max) || n <= max));
    }
    case 'email': { const v = a('value'); return valid(typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)); }
    case 'and': { const vs = rawArgs.values; return Array.isArray(vs) && vs.length > 0 && vs.every((x) => truthy(evaluate(x, ctx, depth + 1))); }
    case 'or': { const vs = rawArgs.values; return Array.isArray(vs) && vs.some((x) => truthy(evaluate(x, ctx, depth + 1))); }
    case 'not': return !truthy(a('value'));
    case '@index': return (ctx.index ?? 0) + (Number.isFinite(num(a('offset'))) ? num(a('offset')) : 0);
    case 'now': return new Date().toISOString();
    case 'formatString': { const v = a('value'); return typeof v === 'string' ? interpolate(v, ctx, depth) : evalText(v, ctx); }
    case 'formatNumber': return formatNumber(num(a('value')), a('decimals'), a('grouping'));
    case 'formatCurrency': return formatCurrency(num(a('value')), String(a('currency') ?? 'USD'), a('decimals'), a('grouping'));
    case 'formatDate': return formatDate(a('value'), String(a('format') ?? 'MMM d, yyyy'));
    case 'pluralize': {
      const n = num(a('value'));
      let cat = 'other';
      try { cat = new Intl.PluralRules('en-US').select(n); } catch { cat = n === 1 ? 'one' : 'other'; }
      if (n === 0 && rawArgs.zero !== undefined) cat = 'zero';
      const pick = rawArgs[cat] !== undefined ? cat : 'other';
      return evalText(rawArgs[pick] ?? '', ctx);
    }
    case 'openUrl': return undefined;
  }
  return undefined;
}

function formatNumber(n: number, decimals: any, grouping: any): string {
  if (Number.isNaN(n)) return '';
  const d = Number.isFinite(num(decimals)) ? Math.max(0, Math.min(10, num(decimals))) : undefined;
  try { return new Intl.NumberFormat('en-US', { useGrouping: grouping !== false, ...(d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : { maximumFractionDigits: 2 }) }).format(n); }
  catch { return d !== undefined ? n.toFixed(d) : String(n); }
}
function formatCurrency(n: number, currency: string, decimals: any, grouping: any): string {
  if (Number.isNaN(n)) return '';
  const d = Number.isFinite(num(decimals)) ? Math.max(0, Math.min(10, num(decimals))) : undefined;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: /^[A-Z]{3}$/.test(currency) ? currency : 'USD', useGrouping: grouping !== false, ...(d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : {}) }).format(n); }
  catch { return `${currency} ${n.toFixed(d ?? 2)}`; }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** A date as a Unicode TR35 pattern (the common tokens: y M d E h H m s a), in this device's time zone. */
export function formatDate(v: any, pattern: string): string {
  let d: Date;
  if (v instanceof Date) d = v;
  else if (typeof v === 'number') d = new Date(v);
  else if (typeof v === 'string' && /^\d{1,2}:\d{2}/.test(v)) d = new Date(`1970-01-01T${v}`);
  else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) d = new Date(`${v}T00:00:00`);
  else d = new Date(String(v ?? ''));
  if (Number.isNaN(d.getTime())) return typeof v === 'string' ? v : '';
  const p2 = (n: number) => String(n).padStart(2, '0');
  const h12 = d.getHours() % 12 || 12;
  const tok: Record<string, () => string> = {
    yyyy: () => String(d.getFullYear()), yy: () => String(d.getFullYear()).slice(-2), y: () => String(d.getFullYear()),
    MMMM: () => MONTHS[d.getMonth()], MMM: () => MONTHS[d.getMonth()].slice(0, 3), MM: () => p2(d.getMonth() + 1), M: () => String(d.getMonth() + 1),
    dd: () => p2(d.getDate()), d: () => String(d.getDate()),
    EEEE: () => DAYS[d.getDay()], EEE: () => DAYS[d.getDay()].slice(0, 3), E: () => DAYS[d.getDay()].slice(0, 3),
    HH: () => p2(d.getHours()), H: () => String(d.getHours()), hh: () => p2(h12), h: () => String(h12),
    mm: () => p2(d.getMinutes()), m: () => String(d.getMinutes()), ss: () => p2(d.getSeconds()), s: () => String(d.getSeconds()),
    a: () => (d.getHours() < 12 ? 'AM' : 'PM'),
  };
  let out = '';
  for (let i = 0; i < pattern.length && i < 200;) {
    const ch = pattern[i];
    if (ch === "'") {
      const end = pattern.indexOf("'", i + 1);
      out += end < 0 ? pattern.slice(i + 1) : end === i + 1 ? "'" : pattern.slice(i + 1, end);
      i = end < 0 ? pattern.length : end + 1;
      continue;
    }
    let j = i;
    while (j < pattern.length && pattern[j] === ch) j++;
    let run = pattern.slice(i, j);
    if (/[yMdEHhmsa]/.test(ch)) {
      while (run && !tok[run]) run = run.slice(0, -1);
      if (run) { out += tok[run](); i += run.length; continue; }
    }
    out += pattern.slice(i, j);
    i = j;
  }
  return out;
}

// formatString: `${/path}`, `${relative/path}`, `${fn(name: value, ...)}`, `\${` for a literal `${`.
function interpolate(src: string, ctx: A2uiCtx, depth: number): string {
  if (src.length > 10_000) return src.slice(0, A2UI_LIMITS.text);
  let out = '';
  let i = 0;
  let parts = 0;
  while (i < src.length && parts++ < 1000) {
    if (src.startsWith('\\${', i)) { out += '${'; i += 3; continue; }
    if (src.startsWith('${', i)) {
      const end = closeBrace(src, i + 2);
      if (end < 0) { out += src.slice(i); break; }
      const expr = new Expr(src.slice(i + 2, end));
      try { const v = expr.value(ctx, depth + 1); out += v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); } catch { /* a broken placeholder shows nothing */ }
      i = end + 1;
      continue;
    }
    // Plain text up to the next `${` or `\${`.
    let stop = i + 1;
    while (stop < src.length && !src.startsWith('${', stop) && !src.startsWith('\\${', stop)) stop++;
    out += src.slice(i, stop);
    i = stop;
  }
  return out.slice(0, A2UI_LIMITS.text);
}
function closeBrace(s: string, from: number): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') { for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}
/** One expression inside `${...}`: a string or number literal, true/false/null, a path, or fn(name: expr, ...). */
class Expr {
  i = 0;
  constructor(public s: string) {}
  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  value(ctx: A2uiCtx, depth: number): any {
    if (depth > A2UI_LIMITS.valueDepth) throw new Error('deep');
    this.ws();
    const s = this.s;
    if (s.startsWith('${', this.i)) {
      const end = closeBrace(s, this.i + 2);
      if (end < 0) throw new Error('unclosed');
      const inner = new Expr(s.slice(this.i + 2, end));
      this.i = end + 1;
      return inner.value(ctx, depth + 1);
    }
    const c = s[this.i];
    if (c === "'" || c === '"') {
      let out = '';
      for (this.i++; this.i < s.length && s[this.i] !== c; this.i++) {
        if (s[this.i] === '\\') { this.i++; const e = s[this.i]; out += e === 'n' ? '\n' : e === 't' ? '\t' : e ?? ''; } else out += s[this.i];
      }
      this.i++;
      return out;
    }
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(this.i));
    if (m && /[\d.+-]/.test(c)) { this.i += m[0].length; return Number(m[0]); }
    const t = /^@?[\w/.~-]*/.exec(s.slice(this.i))?.[0] ?? '';
    this.i += t.length;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null' || !t) return '';
    this.ws();
    if (s[this.i] === '(') {
      this.i++;
      const args: Record<string, any> = {};
      for (let n = 0; n < 20; n++) {
        this.ws();
        if (s[this.i] === ')') break;
        const name = /^\w+/.exec(s.slice(this.i))?.[0] ?? '';
        if (!name) throw new Error('arg');
        this.i += name.length;
        this.ws();
        if (s[this.i] !== ':') throw new Error(':');
        this.i++;
        // Arguments are worked out here, so the function gets plain values.
        args[name] = this.value(ctx, depth + 1);
        this.ws();
        if (s[this.i] === ',') this.i++;
      }
      if (s[this.i] !== ')') throw new Error(')');
      this.i++;
      if (!A2UI_FUNCTIONS.includes(t) || t === 'openUrl') return '';
      return callFn(t, args, ctx, depth + 1);
    }
    return getAt(ctx.data, absPath(t, ctx.scope));
  }
}

// ---- Structure ----------------------------------------------------------------------------------------

/** The children a container shows here: fixed ids, or one copy of the template per item in a data list. */
export function childrenOf(c: A2uiComponent, ctx: A2uiCtx): { id: string; ctx: A2uiCtx; key: string }[] {
  const ch = c.children;
  if (Array.isArray(ch)) return ch.map((id: string) => ({ id, ctx, key: id }));
  if (!isObj(ch)) return [];
  const base = absPath(ch.path, ctx.scope);
  const list = getAt(ctx.data, base);
  const keys = Array.isArray(list) ? list.map((_, i) => String(i)) : isObj(list) ? Object.keys(list) : [];
  return keys.slice(0, A2UI_LIMITS.template).map((k, i) => ({ id: ch.componentId, ctx: { data: ctx.data, scope: `${base.replace(/\/$/, '')}/${k}`, index: i }, key: `${ch.componentId}@${k}` }));
}

/** The messages of this component's checks that fail right now (empty when all pass). */
export function failedChecks(c: A2uiComponent, ctx: A2uiCtx): string[] {
  const out: string[] = [];
  for (const r of (c['@checks'] ?? []) as any[]) if (!truthy(evaluate(r.condition, ctx))) out.push(r.message || 'Check this field');
  return out;
}

/** Where an input's value lives in the data, or null when it is a literal (then it is only local). */
export function valuePath(c: A2uiComponent, ctx: A2uiCtx): string | null {
  const v = c.value;
  return isObj(v) && typeof v['@path'] === 'string' ? absPath(v['@path'], ctx.scope) : null;
}

/**
 * A person's new value for an input, checked for its kind: text (at most 4000 characters; numbers for a
 * number field), true or false, a list of the picker's option values, a slider number kept in range and on
 * its steps, or an ISO date or time. Null when it doesn't fit.
 */
export function inputValue(c: A2uiComponent, ctx: A2uiCtx, v: unknown): any {
  switch (c.component) {
    case 'TextField':
      if (c.variant === 'number') { if (v === '' || v == null) return ''; const n = num(v); return Number.isNaN(n) ? null : n; }
      return typeof v === 'string' ? v.slice(0, A2UI_LIMITS.text) : typeof v === 'number' ? String(v) : null;
    case 'CheckBox': return typeof v === 'boolean' ? v : null;
    case 'ChoicePicker': {
      if (!Array.isArray(v)) return null;
      const allowed = new Set((c.options as any[]).map((o) => o.value));
      const picked = [...new Set(v.filter((x) => typeof x === 'string' && allowed.has(x)))] as string[];
      return c.variant === 'multipleSelection' ? picked : picked.slice(0, 1);
    }
    case 'Slider': {
      const n = num(v);
      if (Number.isNaN(n)) return null;
      const lo = sliderMin(c); const hi = sliderMax(c);
      let x = Math.min(hi, Math.max(lo, n));
      if (Number.isInteger(c.steps) && c.steps >= 1 && hi > lo) { const step = (hi - lo) / c.steps; x = lo + Math.round((x - lo) / step) * step; }
      return +x.toFixed(6);
    }
    case 'DateTimeInput': return typeof v === 'string' && (v === '' || /^[\d:T.+\-Z ]{4,40}$/.test(v)) ? v : null;
  }
  void ctx;
  return null;
}
export const sliderMin = (c: A2uiComponent) => (typeof c.min === 'number' ? c.min : 0);
export const sliderMax = (c: A2uiComponent) => (typeof c.max === 'number' && c.max > sliderMin(c) ? c.max : sliderMin(c) + 100);

/** https links only (and data:image for pictures): the apps never load anything else from a surface. */
export function safeMediaUrl(u: unknown, image = false): string | null {
  if (typeof u !== 'string') return null;
  if (image && /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(u) && u.length < 200_000) return u;
  try { return new URL(u).protocol === 'https:' ? u : null; } catch { return null; }
}

/** What a Button sends: the standard A2UI action (context resolved), the chat line and the button's words. */
export function buttonAction(s: A2uiSurface, c: A2uiComponent, ctx: A2uiCtx): { kind: 'event'; name: string; context: Record<string, any>; userMessage?: string; label: string } | { kind: 'open'; url: string | null } | null {
  if (c.component !== 'Button' || !c.action) return null;
  if (c.action.functionCall) return { kind: 'open', url: safeMediaUrl(evaluate(c.action.functionCall.args?.url, ctx)) };
  const e = c.action.event;
  if (!e) return null;
  const context: Record<string, any> = {};
  for (const [k, v] of Object.entries(e.context ?? {})) context[k] = cleanData(evaluate(v, ctx)) ?? null;
  const um = e.userMessage !== undefined ? evalText(e.userMessage, ctx).trim() : '';
  return { kind: 'event', name: e.name, context, ...(um ? { userMessage: um.slice(0, 500) } : {}), label: labelOf(s, c.child, ctx) };
}

/** The words on a component (a Button's Text child, say), for messages and the text copy. */
export function labelOf(s: A2uiSurface, id: string, ctx: A2uiCtx, depth = 0): string {
  const c = s.components[id];
  if (!c || depth > 6) return '';
  if (c.component === 'Text') return stripMd(evalText(c.text, ctx));
  if (c.component === 'Icon') return typeof c.name === 'string' ? c.name : '';
  if (c['@accessibility']?.label !== undefined) return evalText(c['@accessibility'].label, ctx);
  return [...childrenOf(c, ctx).map((k) => labelOf(s, k.id, k.ctx, depth + 1)), ...(['child'].map((k) => (typeof c[k] === 'string' ? labelOf(s, c[k], ctx, depth + 1) : '')))].filter(Boolean).join(' ');
}
const stripMd = (t: string) => t.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();

/** The surface as plain markdown: previews, notifications, voice, Simple mode, other bots and older apps. */
export function surfaceText(s: A2uiSurface): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string, ctx: A2uiCtx, depth: number) => {
    const c = s.components[id];
    const key = `${id}@${ctx.scope}`;
    if (!c || depth > A2UI_LIMITS.depth || seen.has(key) || out.length > 400) return;
    seen.add(key);
    const t = (v: any) => evalText(v, ctx);
    switch (c.component) {
      case 'Text': { const x = t(c.text).trim(); if (x) out.push(x); return; }
      case 'Image': { const x = c.description !== undefined ? t(c.description) : ''; if (x) out.push(`(picture: ${x})`); return; }
      case 'Video': out.push('(video)'); return;
      case 'AudioPlayer': out.push(`(audio${c.description !== undefined ? `: ${t(c.description)}` : ''})`); return;
      case 'Icon': case 'Divider': return;
      case 'Button': { const l = labelOf(s, c.child, ctx); if (l) out.push(`[${l}]`); return; }
      case 'TextField': { const v = c.variant === 'obscured' ? '••••' : t(c.value); out.push(`- ${t(c.label)}: ${v || '(blank)'}`); return; }
      case 'CheckBox': out.push(`- [${truthy(evaluate(c.value, ctx)) ? 'x' : ' '}] ${t(c.label)}`); return;
      case 'Slider': out.push(`- ${c.label !== undefined ? t(c.label) : 'Value'}: ${t(c.value)}`); return;
      case 'DateTimeInput': out.push(`- ${c.label !== undefined ? t(c.label) : 'Date'}: ${t(c.value) || '(not set)'}`); return;
      case 'ChoicePicker': {
        const picked = evaluate(c.value, ctx);
        const set = new Set(Array.isArray(picked) ? picked : []);
        if (c.label !== undefined) out.push(t(c.label));
        out.push((c.options as any[]).map((o) => `- ${set.has(o.value) ? '(picked) ' : ''}${t(o.label)}`).join('\n'));
        return;
      }
      case 'Tabs': for (const tab of c.tabs) { out.push(`**${t(tab.title)}**`); walk(tab.child, ctx, depth + 1); } return;
      case 'Modal': walk(c.trigger, ctx, depth + 1); return;
      case 'Card': walk(c.child, ctx, depth + 1); return;
      default: {
        const at = out.length;
        for (const k of childrenOf(c, ctx)) walk(k.id, k.ctx, depth + 1);
        // A Row of short bits (a name and a price, an icon's label and a number) reads as one line.
        const bits = out.slice(at);
        const flat = bits.map((x) => x.replace(/^#+\s+/, ''));
        if ((c.component === 'Row' || c.direction === 'horizontal') && bits.length > 1 && flat.every((x) => !x.includes('\n') && !x.startsWith('- ')) && flat.join(' · ').length <= 140) out.splice(at, bits.length, flat.join(' · '));
      }
    }
  };
  walk('root', { data: s.data, scope: '' }, 0);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 20_000);
}

/** Every component id reachable from root, so a component nobody shows can't be pressed. */
export function reachable(s: A2uiSurface): Set<string> {
  const seen = new Set<string>();
  const go = (id: string, depth: number) => {
    const c = s.components[id];
    if (!c || seen.has(id) || depth > A2UI_LIMITS.depth) return;
    seen.add(id);
    for (const r of refsOf(c)) go(r, depth + 1);
  };
  go('root', 0);
  return seen;
}

/** A template item's scope as a person's app sends it back: an absolute path ending in a list position or key. */
export function scopeOk(scope: unknown): scope is string {
  return typeof scope === 'string' && (scope === '' || (scope.length <= 300 && scope.startsWith('/') && !!pathParts(scope)));
}
