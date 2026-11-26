'use strict';
// A small log file in the app's data folder (logs/main.log), so a problem on someone's PC can be read
// afterwards (Help > Open the log folder, or Copy diagnostics). It never holds message text, sign-in
// links, cookies or keys: only what the app did and what went wrong. One older file is kept.

const fs = require('node:fs');
const path = require('node:path');

const MAX = 512 * 1024;
let file = null;
const recent = []; // the last lines, for "Copy diagnostics"

/** Takes anything that looks like a secret out of a line before it is written. */
function scrub(text) {
  return String(text)
    .replace(/\/api\/auth\/link\/[A-Za-z0-9_-]+/g, '/api/auth/link/…')
    .replace(/\/pair\/[A-Za-z0-9_-]+/g, '/pair/…')
    .replace(/(cookie|authorization|x-pair-secret|secret|token)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1$2…')
    .replace(/[\r\n]+/g, ' | ')
    .slice(0, 2000);
}

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'main.log');
  } catch { file = null; }
}

function write(level, parts) {
  const line = `${new Date().toISOString()} ${level} ${scrub(parts.map((p) => (p instanceof Error ? p.stack ?? p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' '))}`;
  recent.push(line);
  if (recent.length > 200) recent.shift();
  if (!file) return;
  try {
    try { if (fs.statSync(file).size > MAX) fs.renameSync(file, file.replace(/\.log$/, '.old.log')); } catch { /* no file yet */ }
    fs.appendFileSync(file, line + '\n');
  } catch { /* a log that cannot be written must never stop the app */ }
}

module.exports = {
  init,
  scrub,
  info: (...p) => write('info ', p),
  warn: (...p) => write('warn ', p),
  error: (...p) => write('error', p),
  tail: (n = 40) => recent.slice(-n),
  dir: () => (file ? path.dirname(file) : null),
};
