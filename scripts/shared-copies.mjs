// The server's shared helpers that the Android app keeps word-for-word copies of. The phone is built from
// mobile/ alone (scripts/release/cleft-release.sh ships only that folder), so it cannot import the server's
// files at run time; it keeps copies instead, and this list is the one place that says which.
//
//   node scripts/shared-copies.mjs          write every copy from its server file
//   node scripts/shared-copies.mjs --check  exit 1 and name each copy that differs (tests/shared-copies.mjs)
//
// Change the server file, then run this. Never edit a copy by hand. Types need no copy: the phone reads
// them from the server's files with `import type` (mobile/tsconfig.json @shared/*), which the build strips.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** [server file, Android copy], both relative to the repo. Each server file must have no imports. */
export const COPIES = [
  ['server/src/message-text.ts', 'mobile/src/messageText.ts'],
  ['server/src/raw-output.ts', 'mobile/src/rawOutput.ts'],
  ['server/src/chat-colors.ts', 'mobile/src/chatColors.ts'],
  ['server/src/engine-summary.ts', 'mobile/src/engineSummary.ts'],
  ['server/src/reactions.ts', 'mobile/src/reactions.ts'],
  ['server/src/reply-wait.ts', 'mobile/src/replyWait.ts'],
  ['server/src/card-icon.ts', 'mobile/src/cardIcon.ts'],
  ['server/src/board-pin.ts', 'mobile/src/boardPin.ts'],
  ['server/src/calc.ts', 'mobile/src/calc.ts'],
  ['server/src/page-chart.ts', 'mobile/src/pageChart.ts'],
  ['server/src/a2ui.ts', 'mobile/src/a2ui.ts'],
  ['server/src/a2ui-icons.ts', 'mobile/src/a2uiIcons.ts'],
  ['server/src/api-path.ts', 'mobile/src/apiPath.ts'],
  ['server/src/app-support.ts', 'mobile/src/appSupport.ts'],
  ['server/src/allowed-here.ts', 'mobile/src/allowedHere.ts'],
];

/**
 * Android files that carry only part of a server file, rewritten for the phone, so they cannot be copies.
 * Listed so the check below knows they are known; keep each in step with its server file by hand.
 */
export const PORTS = [
  ['server/src/avatar-poses.ts', 'mobile/src/poses.ts'],
];

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** What differs: copies that do not match, server files that import, and phone files that say they copy one. */
export function problems() {
  const out = [];
  for (const [src, copy] of COPIES) {
    const s = read(src);
    if (/^\s*import\s/m.test(s)) out.push(`${src} imports another file, so the phone cannot keep a copy of it.`);
    if (!fs.existsSync(path.join(root, copy)) || read(copy) !== s) out.push(`${copy} differs from ${src}. Run: node scripts/shared-copies.mjs`);
  }
  const known = new Set([...COPIES, ...PORTS].map(([, c]) => c));
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(`${dir}/${e.name}`)) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []);
  for (const f of [...walk('mobile/src'), ...walk('mobile/preview')]) {
    // The phone is built from mobile/ alone, so a server file can reach it only as types, which the build strips.
    const text = read(f);
    for (const m of text.matchAll(/^(.*)from '@shared\/[^']+';/gm)) {
      const start = text.lastIndexOf('\n', m.index) + 1;
      const stmt = text.slice(text.lastIndexOf(';', m.index) + 1, m.index + m[0].length).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').trim();
      if (!/^(import|export) type\b/.test(stmt)) out.push(`${f}: '@shared' may only be used with import type or export type (the phone build has no server files): ${text.slice(start, m.index + m[0].length).trim()}`);
    }
    if (known.has(f)) continue;
    const head = read(f).split('\n').slice(0, 3).join('\n');
    if (/\bcopy of (the )?server/i.test(head) || /copied verbatim/i.test(head)) out.push(`${f} says it copies a server file but is not listed in scripts/shared-copies.mjs.`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--check')) {
    const p = problems();
    for (const line of p) console.error(line);
    process.exit(p.length ? 1 : 0);
  }
  for (const [src, copy] of COPIES) {
    const s = read(src);
    if (fs.existsSync(path.join(root, copy)) && read(copy) === s) continue;
    fs.writeFileSync(path.join(root, copy), s);
    console.log(`wrote ${copy}`);
  }
}
