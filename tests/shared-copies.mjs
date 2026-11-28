// The Android app's word-for-word copies of the server's shared helpers (scripts/shared-copies.mjs): every
// copy matches its server file, and no phone file claims to be a copy without being on the list.
// `node tests/shared-copies.mjs` (needs no build).
import { problems } from '../scripts/shared-copies.mjs';

const p = problems();
if (p.length) {
  for (const line of p) console.log(`FAIL ${line}`);
  process.exit(1);
}
console.log('ok   every Android copy matches its server file');
