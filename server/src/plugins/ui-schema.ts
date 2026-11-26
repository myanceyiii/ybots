/**
 * What a plugin may show in the apps, as data. Shared by the server (which validates it) and every
 * app (web imports it as @shared/plugins/ui-schema; Windows and Android through client-core). No
 * imports, no Node APIs, no code from the plugin: an app only ever renders these shapes.
 *
 * Two things a plugin can add:
 *  - a card in a conversation: a tool returns `structuredContent: { cleftbot_card: PluginCard }`;
 *  - a settings form: `settings` in its cleftbot-plugin.json, filled in by the owner on the Plugins page.
 *
 * A plugin card has no buttons that do anything but open an https link. Approval cards are never
 * plugin-defined: only the server makes them, and only the signed-in owner answers them.
 */

export type PluginBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'fields'; items: { label: string; value: string }[] }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'link'; label: string; url: string }
  | { kind: 'image'; url: string; alt: string }
  | { kind: 'progress'; label: string; value: number; max: number }
  | { kind: 'badge'; text: string; tone: 'neutral' | 'good' | 'warn' | 'bad' };

export interface PluginCard {
  title: string;
  subtitle?: string;
  blocks: PluginBlock[];
}

export type SettingField =
  | { key: string; label: string; type: 'text'; help?: string; required?: boolean; placeholder?: string }
  | { key: string; label: string; type: 'secret'; help?: string; required?: boolean }
  | { key: string; label: string; type: 'boolean'; help?: string }
  | { key: string; label: string; type: 'number'; help?: string; required?: boolean; min?: number; max?: number }
  | { key: string; label: string; type: 'select'; help?: string; required?: boolean; options: { value: string; label: string }[] };

export type SettingValues = Record<string, string | number | boolean>;

export const LIMITS = { title: 120, text: 4000, blocks: 30, cells: 50, rows: 50, columns: 8, fields: 30, settings: 20, image: 200_000 } as const;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = <T>(error: string): Result<T> => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const KEY = /^[a-z][a-z0-9_]{0,31}$/;

/** https links only (and data:image for small pictures): no javascript:, no plain http, no file:. */
export function safeUrl(u: unknown, image = false): string | null {
  if (typeof u !== 'string' || u.length > (image ? LIMITS.image : 2000)) return null;
  if (image && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(u)) return u;
  try { return new URL(u).protocol === 'https:' ? u : null; } catch { return null; }
}

function block(b: unknown): PluginBlock | string {
  if (!isObj(b)) return 'a block is not an object';
  switch (b.kind) {
    case 'heading': case 'text': {
      const text = str(b.text, b.kind === 'heading' ? LIMITS.title : LIMITS.text);
      return text === null ? `${b.kind}: text too long or missing` : { kind: b.kind, text };
    }
    case 'fields': {
      if (!Array.isArray(b.items) || b.items.length > LIMITS.fields) return 'fields: items must be a list (30 at most)';
      const items = [];
      for (const i of b.items) {
        const label = isObj(i) ? str(i.label, LIMITS.title) : null;
        const value = isObj(i) ? str(i.value, 500) : null;
        if (label === null || value === null) return 'fields: each item needs a label and a value';
        items.push({ label, value });
      }
      return { kind: 'fields', items };
    }
    case 'table': {
      if (!Array.isArray(b.columns) || !b.columns.length || b.columns.length > LIMITS.columns || !b.columns.every((c) => str(c, LIMITS.cells) !== null)) return 'table: 1 to 8 column names';
      if (!Array.isArray(b.rows) || b.rows.length > LIMITS.rows) return 'table: 50 rows at most';
      const rows: string[][] = [];
      for (const r of b.rows) {
        if (!Array.isArray(r) || r.length !== b.columns.length || !r.every((c) => str(c, 200) !== null)) return 'table: every row needs one short text per column';
        rows.push(r as string[]);
      }
      return { kind: 'table', columns: b.columns as string[], rows };
    }
    case 'link': {
      const label = str(b.label, LIMITS.title);
      const url = safeUrl(b.url);
      return label === null || url === null ? 'link: needs a label and an https URL' : { kind: 'link', label, url };
    }
    case 'image': {
      const url = safeUrl(b.url, true);
      const alt = str(b.alt, 300);
      return url === null || alt === null ? 'image: needs an https or small data:image URL and alt text' : { kind: 'image', url, alt };
    }
    case 'progress': {
      const label = str(b.label, LIMITS.title);
      const max = typeof b.max === 'number' && b.max > 0 && Number.isFinite(b.max) ? b.max : null;
      const value = typeof b.value === 'number' && Number.isFinite(b.value) ? b.value : null;
      return label === null || max === null || value === null ? 'progress: needs a label, a value and a max above 0' : { kind: 'progress', label, value: Math.min(Math.max(value, 0), max), max };
    }
    case 'badge': {
      const text = str(b.text, 40);
      const tone = ['neutral', 'good', 'warn', 'bad'].includes(b.tone as string) ? (b.tone as 'neutral') : 'neutral';
      return text === null ? 'badge: text too long or missing' : { kind: 'badge', text, tone };
    }
    default:
      return `unknown block kind ${JSON.stringify(b.kind)}`;
  }
}

/** Check a card a plugin sent. Returns a clean copy (unknown keys dropped) or why it was refused. */
export function validatePluginCard(v: unknown): Result<PluginCard> {
  if (!isObj(v)) return fail('the card is not an object');
  const title = str(v.title, LIMITS.title);
  if (!title) return fail('the card needs a title');
  const subtitle = v.subtitle === undefined ? undefined : str(v.subtitle, LIMITS.title);
  if (subtitle === null) return fail('subtitle too long');
  if (!Array.isArray(v.blocks) || v.blocks.length > LIMITS.blocks) return fail('blocks must be a list (30 at most)');
  const blocks: PluginBlock[] = [];
  for (const b of v.blocks) {
    const r = block(b);
    if (typeof r === 'string') return fail(r);
    blocks.push(r);
  }
  return { ok: true, value: { title, ...(subtitle ? { subtitle } : {}), blocks } };
}

/** Check the `settings` list in a plugin's manifest. */
export function validateSettingsSpec(v: unknown): Result<SettingField[]> {
  if (v === undefined) return { ok: true, value: [] };
  if (!Array.isArray(v) || v.length > LIMITS.settings) return fail('settings must be a list (20 at most)');
  const out: SettingField[] = [];
  const seen = new Set<string>();
  for (const f of v) {
    if (!isObj(f) || typeof f.key !== 'string' || !KEY.test(f.key) || seen.has(f.key)) return fail('each setting needs a unique key (lower-case letters, digits, _)');
    seen.add(f.key);
    const label = str(f.label, LIMITS.title);
    if (!label) return fail(`setting ${f.key} needs a label`);
    const help = f.help === undefined ? undefined : str(f.help, 300) ?? undefined;
    const required = f.required === true;
    switch (f.type) {
      case 'text': out.push({ key: f.key, label, type: 'text', help, required, placeholder: str(f.placeholder, 120) ?? undefined }); break;
      case 'secret': out.push({ key: f.key, label, type: 'secret', help, required }); break;
      case 'boolean': out.push({ key: f.key, label, type: 'boolean', help }); break;
      case 'number': out.push({ key: f.key, label, type: 'number', help, required, min: typeof f.min === 'number' ? f.min : undefined, max: typeof f.max === 'number' ? f.max : undefined }); break;
      case 'select': {
        if (!Array.isArray(f.options) || !f.options.length || f.options.length > 30) return fail(`setting ${f.key} needs 1 to 30 options`);
        const options = [];
        for (const o of f.options) {
          const value = isObj(o) ? str(o.value, 100) : null;
          const ol = isObj(o) ? str(o.label, LIMITS.title) : null;
          if (value === null || ol === null) return fail(`setting ${f.key}: each option needs a value and a label`);
          options.push({ value, label: ol });
        }
        out.push({ key: f.key, label, type: 'select', help, required, options });
        break;
      }
      default: return fail(`setting ${f.key} has an unknown type`);
    }
  }
  return { ok: true, value: out };
}

/**
 * Check values the owner entered against the form. `previous` keeps a secret that was left blank
 * (the apps never get a stored secret back, so a blank secret field means "unchanged").
 */
export function validateSettingValues(spec: SettingField[], v: unknown, previous: SettingValues = {}): Result<SettingValues> {
  if (!isObj(v)) return fail('values must be an object');
  const out: SettingValues = {};
  for (const f of spec) {
    let x = v[f.key];
    if (f.type === 'secret' && (x === undefined || x === '') && previous[f.key] !== undefined) x = previous[f.key];
    if (x === undefined || x === '') {
      if ('required' in f && f.required) return fail(`${f.label} is required`);
      continue;
    }
    switch (f.type) {
      case 'text': case 'secret':
        if (typeof x !== 'string' || x.length > 2000 || /[\r\n\0]/.test(x)) return fail(`${f.label} must be one line of text`);
        out[f.key] = x; break;
      case 'boolean':
        if (typeof x !== 'boolean') return fail(`${f.label} must be on or off`);
        out[f.key] = x; break;
      case 'number':
        if (typeof x !== 'number' || !Number.isFinite(x) || (f.min !== undefined && x < f.min) || (f.max !== undefined && x > f.max)) return fail(`${f.label} is out of range`);
        out[f.key] = x; break;
      case 'select':
        if (typeof x !== 'string' || !f.options.some((o) => o.value === x)) return fail(`${f.label} must be one of the options`);
        out[f.key] = x; break;
    }
  }
  return { ok: true, value: out };
}

/** What the apps see of stored values: secrets only say whether they are set. */
export function publicValues(spec: SettingField[], values: SettingValues): Record<string, string | number | boolean | { set: boolean }> {
  const out: Record<string, string | number | boolean | { set: boolean }> = {};
  for (const f of spec) {
    if (f.type === 'secret') out[f.key] = { set: values[f.key] !== undefined };
    else if (values[f.key] !== undefined) out[f.key] = values[f.key];
  }
  return out;
}
