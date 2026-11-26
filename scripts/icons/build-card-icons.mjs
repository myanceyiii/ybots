// Writes the icon block of server/src/card-icon.ts (the logos and glyphs on approval cards) and copies the
// file to mobile/src/cardIcon.ts. Run with the two icon packages unpacked somewhere:
//   npm pack simple-icons@16.38.1 lucide-static@1.81.0 && tar xzf ... (each into its own folder)
//   node scripts/icons/build-card-icons.mjs <simple-icons package dir> <lucide-static package dir>
// Brand marks: Simple Icons (CC0-1.0). Glyphs: Lucide (ISC). Both bundled, never fetched at runtime.
import fs from 'node:fs';
import path from 'node:path';

const [siDir, luDir] = process.argv.slice(2);
if (!siDir || !luDir) { console.error('usage: build-card-icons.mjs <simple-icons dir> <lucide-static dir>'); process.exit(1); }

/** id -> simple-icons slug. Brand marks draw in the brand's colour on a white tile. */
const BRANDS = {
  actual: 'actualbudget', gmail: 'gmail', gcal: 'googlecalendar', gdrive: 'googledrive', gdocs: 'googledocs',
  gsheets: 'googlesheets', gtasks: 'googletasks', gmessages: 'googlemessages', google: 'google', github: 'github',
  cloudflare: 'cloudflare', elevenlabs: 'elevenlabs', notion: 'notion', docker: 'docker', tailscale: 'tailscale',
  libreoffice: 'libreoffice', postiz: 'postiz', chrome: 'googlechrome', instagram: 'instagram', tiktok: 'tiktok',
  youtube: 'youtube', facebook: 'facebook', x: 'x', threads: 'threads', python: 'python', ubuntu: 'ubuntu',
};
/** id -> [lucide name, tile colour, what it means]. Glyphs draw white on a coloured tile. */
const GLYPHS = {
  terminal: ['square-terminal', '#334155', 'Runs a command'], code: ['code-xml', '#4338CA', 'Runs code'], files: ['file-pen', '#0E7490', 'Changes files'],
  delete: ['trash-2', '#B91C1C', 'Deletes something'], send: ['send', '#2563EB', 'Sends a message'], mail: ['mail', '#2563EB', 'Email'], money: ['wallet', '#047857', 'Money'],
  bank: ['landmark', '#047857', 'Bank accounts'], stocks: ['trending-up', '#047857', 'Investments'], host: ['server', '#475569', 'Server'], pc: ['monitor', '#0369A1', 'Remote PC'],
  computer: ['mouse-pointer-click', '#0369A1', 'Controls a computer'], install: ['package', '#9333EA', 'Installs software'], browser: ['globe', '#0284C7', 'Web browser'],
  schedule: ['calendar-clock', '#C2410C', 'Schedules work'], timer: ['timer', '#C2410C', 'Timer'], plugin: ['puzzle', '#7C3AED', 'Plugin'],
  purchase: ['shopping-cart', '#B45309', 'Purchase'], secret: ['key-round', '#A16207', 'Secure input'], hand: ['hand', '#DB2777', 'Needs your help on screen'],
  posting: ['megaphone', '#DB2777', 'Social posts'], memory: ['brain', '#9D174D', 'Memory'], hermes: ['sparkles', '#6D28D9', 'Hermes'], phone: ['phone', '#15803D', 'Phone call'],
  search: ['search', '#0F766E', 'Web search'], image: ['image', '#BE185D', 'Makes a picture'], helpers: ['users', '#4F46E5', 'Helpers'], skill: ['book-open', '#92400E', 'Skills'],
  chat: ['message-square', '#2563EB', 'Chat'], database: ['database', '#475569', 'Database'], scan: ['scan-search', '#1E40AF', 'Reverse engineering'],
  connector: ['plug', '#64748B', 'Connected app'], tool: ['wrench', '#64748B', 'Tool'], unknown: ['shield-question', '#64748B', 'Action'],
};

const num = (s) => Number(s ?? 0);
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([a-z0-9-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
/** Lucide shapes as path data, so every app can draw them with one <path> element. */
function toPath(tag) {
  const name = tag.match(/^<([a-z]+)/)[1];
  const a = attrs(tag);
  if (name === 'path') return a.d;
  if (name === 'line') return `M${a.x1} ${a.y1}L${a.x2} ${a.y2}`;
  if (name === 'polyline' || name === 'polygon') {
    const p = a.points.trim().split(/[\s,]+/);
    let d = `M${p[0]} ${p[1]}`;
    for (let i = 2; i < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
    return name === 'polygon' ? `${d}Z` : d;
  }
  if (name === 'circle' || name === 'ellipse') {
    const cx = num(a.cx), cy = num(a.cy), rx = num(a.r ?? a.rx), ry = num(a.r ?? a.ry);
    return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0`;
  }
  if (name === 'rect') {
    const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height);
    const r = Math.min(num(a.rx ?? a.ry), w / 2, h / 2);
    if (!r) return `M${x} ${y}h${w}v${h}h${-w}Z`;
    return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}Z`;
  }
  throw new Error(`unknown shape ${name}`);
}

const siData = JSON.parse(fs.readFileSync(path.join(siDir, 'data/simple-icons.json'), 'utf8'));
const siList = Array.isArray(siData) ? siData : siData.icons;
const out = {};
for (const [id, slug] of Object.entries(BRANDS)) {
  const svg = fs.readFileSync(path.join(siDir, 'icons', `${slug}.svg`), 'utf8');
  const title = svg.match(/<title>([^<]*)<\/title>/)[1].replace(/&amp;/g, '&');
  const meta = siList.find((i) => (i.slug ?? '') === slug) ?? siList.find((i) => i.title === title);
  if (!meta) throw new Error(`no colour for ${slug}`);
  out[id] = { kind: 'brand', label: title, color: `#${meta.hex}`, d: [svg.match(/<path d="([^"]+)"/)[1]] };
}
for (const [id, [name, color, label]] of Object.entries(GLYPHS)) {
  const svg = fs.readFileSync(path.join(luDir, 'icons', `${name}.svg`), 'utf8');
  const tags = [...svg.matchAll(/<(path|line|polyline|polygon|circle|ellipse|rect)\b[^>]*\/>/g)].map((m) => m[0]);
  out[id] = { kind: 'glyph', label, color, d: tags.map(toPath) };
}

const file = new URL('../../server/src/card-icon.ts', import.meta.url);
const src = fs.readFileSync(file, 'utf8');
const block = `// <icons> generated by scripts/icons/build-card-icons.mjs; do not edit by hand\nexport const CARD_ICONS: Record<string, IconData> = ${JSON.stringify(out, null, 0).replace(/\},"/g, '},\n  "')};\n// </icons>`;
const next = src.replace(/\/\/ <icons>[\s\S]*?\/\/ <\/icons>/, block);
fs.writeFileSync(file, next);
const mobile = new URL('../../mobile/src/cardIcon.ts', import.meta.url);
fs.writeFileSync(mobile, next.replace(/^\/\/ .*\n/, '// Verbatim copy of server/src/card-icon.ts (tests/card-icon.mjs checks it). Change the server file, then copy.\n'));
console.log(`wrote ${Object.keys(out).length} icons`);
