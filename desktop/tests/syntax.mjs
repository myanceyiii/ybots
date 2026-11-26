// Every file the app ships must at least parse. One broken quote in a file main.js requires stops the
// whole app at start (0.8.2 shipped that way), and the unit tests never loaded that file.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|cjs|mjs)$/.test(e.name)) files.push(p);
  }
};
walk(path.join(root, 'src'));
walk(path.join(root, 'build'));
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad++; console.error(`does not parse: ${path.relative(root, f)}\n${String(e.stderr).split('\n').slice(0, 4).join('\n')}`); }
}
if (bad) process.exit(1);
console.log(`ok   ${files.length} shipped files parse`);
