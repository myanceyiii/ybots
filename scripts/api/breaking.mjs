// Refuses a contract change that would take something from an installed app (docs/api-contract.md):
// a call removed, a field an app reads removed or loosened, a field an app must now send, a value an app sends
// no longer accepted, an event or event field removed. New calls, fields and values pass.
//   node scripts/api/breaking.mjs [BASE_FILE]   compare api/openapi.json with BASE_FILE, or with origin/main's
// Exit 1 on a break. A line in api/accepted-breaking.md that equals a break's text lets it through; use it only
// for a change no app can notice (see the docs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

/** Each break, as one line of text. `warn` gets changes that pass but deserve a look. */
export function breaks(base, head, warn = []) {
  const out = [];
  const deref = (doc, s, seen = new Set()) => {
    while (s && s.$ref) {
      const name = s.$ref.split('/').pop();
      if (seen.has(name)) return { $recursive: name };
      seen.add(name);
      const { $ref, ...rest } = s;
      s = { ...(doc.components?.schemas?.[name] ?? {}), ...rest };
    }
    return s ?? {};
  };
  const types = (s) => new Set([].concat(s.type ?? (s.const !== undefined ? typeof s.const : s.enum ? s.enum.map((v) => (v === null ? 'null' : typeof v)) : [])));
  const variants = (s) => s.anyOf ?? s.oneOf ?? null;
  const tag = (doc, v) => { const d = deref(doc, v); return d.properties?.type?.const ?? d.properties?.kind?.const ?? d.const ?? null; };

  /** `dir` is 'out' for what the server answers (apps read it) and 'in' for what apps send. */
  const walk = (b, h, where, dir, depth = 0) => {
    if (depth > 12) return;
    b = deref(base, b); h = deref(head, h);
    if (b.$recursive || h.$recursive) return;
    const bv = variants(b), hv = variants(h);
    if (bv || hv) {
      const bt = (bv ?? [b]).map((v) => tag(base, v)), ht = (hv ?? [h]).map((v) => tag(head, v));
      if (bt.every((t) => t !== null) && ht.every((t) => t !== null)) {
        for (const [i, t] of bt.entries()) {
          const j = ht.indexOf(t);
          if (j === -1) { out.push(`${where}: the kind "${t}" was removed`); continue; }
          walk((bv ?? [b])[i], (hv ?? [h])[j], `${where}[${t}]`, dir, depth + 1);
        }
        if (dir === 'out') for (const t of ht) if (!bt.includes(t)) warn.push(`${where}: new kind "${t}" (apps must ignore kinds they do not know)`);
      }
      return;
    }
    const bt = types(b), ht = types(h);
    if (bt.size && ht.size) {
      if (dir === 'out') { for (const t of ht) if (!bt.has(t)) out.push(`${where}: can now be ${t}, which apps do not expect`); }
      else for (const t of bt) if (!ht.has(t)) out.push(`${where}: no longer accepts ${t}`);
    }
    if (b.enum && h.enum) {
      if (dir === 'in') for (const v of b.enum) if (!h.enum.includes(v)) out.push(`${where}: no longer accepts ${JSON.stringify(v)}`);
      if (dir === 'out') {
        for (const v of h.enum) if (!b.enum.includes(v)) warn.push(`${where}: new value ${JSON.stringify(v)} (apps must read an unknown value as "other")`);
        for (const v of b.enum) if (!h.enum.includes(v)) warn.push(`${where}: no longer sends ${JSON.stringify(v)}`);
      }
    }
    if (b.const !== undefined && h.const !== undefined && b.const !== h.const) out.push(`${where}: changed from ${JSON.stringify(b.const)} to ${JSON.stringify(h.const)}`);
    const bp = b.properties ?? {}, hp = h.properties ?? {};
    const breq = new Set(b.required ?? []), hreq = new Set(h.required ?? []);
    for (const k of Object.keys(bp)) {
      if (!(k in hp)) { out.push(`${where}.${k}: removed`); continue; }
      if (dir === 'out' && breq.has(k) && !hreq.has(k)) out.push(`${where}.${k}: was always sent, now may be missing`);
      walk(bp[k], hp[k], `${where}.${k}`, dir, depth + 1);
    }
    if (dir === 'in') for (const k of hreq) if (!breq.has(k)) out.push(`${where}.${k}: apps must now send it`);
    if (b.items && h.items) walk(b.items, h.items, `${where}[]`, dir, depth + 1);
  };

  for (const [p, methods] of Object.entries(base.paths ?? {})) {
    for (const [m, bo] of Object.entries(methods)) {
      const ho = head.paths?.[p]?.[m];
      const op = `${m.toUpperCase()} ${p}`;
      if (!ho) { out.push(`${op}: removed`); continue; }
      const bq = Object.fromEntries((bo.parameters ?? []).map((x) => [`${x.in}:${x.name}`, x]));
      for (const x of ho.parameters ?? []) {
        const old = bq[`${x.in}:${x.name}`];
        if (!old && x.required) out.push(`${op} ${x.in} ${x.name}: apps must now send it`);
        if (old && x.required && !old.required) out.push(`${op} ${x.in} ${x.name}: apps must now send it`);
        if (old) walk(old.schema, x.schema, `${op} ${x.in} ${x.name}`, 'in');
      }
      for (const k of Object.keys(bq)) if (!(ho.parameters ?? []).some((x) => `${x.in}:${x.name}` === k)) out.push(`${op} ${k.replace(':', ' ')}: no longer read`);
      const bb = bo.requestBody?.content?.['application/json']?.schema, hb = ho.requestBody?.content?.['application/json']?.schema;
      if (!bb && hb) walk({ type: 'object', properties: {} }, hb, `${op} body`, 'in');
      if (bb && hb) walk(bb, hb, `${op} body`, 'in');
      if (bb && !hb) out.push(`${op} body: no longer read`);
      const br = bo.responses?.[200]?.content?.['application/json']?.schema, hr = ho.responses?.[200]?.content?.['application/json']?.schema;
      if (br && hr) walk(br, hr, `${op} answer`, 'out');
      if (br && !hr) out.push(`${op} answer: removed`);
    }
  }
  if (base['x-events'] && head['x-events']) walk(base['x-events'].schema, head['x-events'].schema, 'event', 'out');
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const head = JSON.parse(fs.readFileSync(path.join(root, 'api/openapi.json'), 'utf8'));
  let baseText;
  if (process.argv[2]) baseText = fs.readFileSync(process.argv[2], 'utf8');
  else {
    try { baseText = execFileSync('git', ['show', 'origin/main:api/openapi.json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { console.log('origin/main has no api/openapi.json yet: nothing to compare.'); process.exit(0); }
  }
  const accepted = new Set((fs.existsSync(path.join(root, 'api/accepted-breaking.md')) ? fs.readFileSync(path.join(root, 'api/accepted-breaking.md'), 'utf8') : '')
    .split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean));
  const warn = [];
  const found = breaks(JSON.parse(baseText), head, warn).filter((b) => !accepted.has(b));
  for (const w of warn) console.log(`note  ${w}`);
  for (const b of found) console.log(`BREAK ${b}`);
  if (found.length) { console.log(`\n${found.length} change(s) would break installed apps. See docs/api-contract.md.`); process.exit(1); }
  console.log('No breaking changes.');
}
