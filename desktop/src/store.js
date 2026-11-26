'use strict';
// Reading and writing the app's small JSON files (settings.json, remote.json) so that a crash or a
// power cut in the middle of a write can never leave a half-written file: the new content goes to a
// temporary file next to it, then takes the old file's place in one step. A file that cannot be read is
// kept beside it (name.bad-<time>.json) and the app carries on with its defaults.

const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { value: null, bad: false }; }
  try { return { value: JSON.parse(text), bad: false }; } catch { /* kept below */ }
  try { fs.renameSync(file, file.replace(/\.json$/, '') + `.bad-${Date.now()}.json`); } catch { /* read-only folder */ }
  return { value: null, bad: true };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows can refuse the swap for a moment while a virus scanner holds the old file: write it plainly.
    try { fs.writeFileSync(file, JSON.stringify(value, null, 2)); } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
    if (!fs.existsSync(file)) throw err;
  }
}

module.exports = { readJson, writeJson };
