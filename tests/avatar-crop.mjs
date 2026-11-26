// Head crop of a bot picture: a full-body figure on a cream ground comes back as a square centred on its head.
// Run: npm run build -w server && node tests/avatar-crop.mjs
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { findHeadBox, headCrop } from '../server/dist/avatar-crop.js';

const w = 512, h = 512, d = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = (y * w + x) * 4;
  const fg = (y >= 8 && y < 140 && (x - 300) ** 2 / 60 ** 2 + (y - 74) ** 2 / 66 ** 2 < 1)   // head, off centre, touching the top
    || (y >= 140 && y < 160 && Math.abs(x - 300) < 20)                                        // neck
    || (y >= 160 && y < 500 && Math.abs(x - 300) < 90);                                       // body
  const c = fg ? [200, 60, 60] : [253, 246, 236];
  d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
}
const picture = Buffer.from(jpeg.encode({ width: w, height: h, data: d }, 90).data);
const box = findHeadBox(jpeg.decode(picture, { useTArray: true, formatAsRGBA: true }));
assert.ok(box, 'found a head');
const headMid = { x: 300, y: 74 };
assert.ok(Math.abs(box.x + box.size / 2 - headMid.x) < 12, `centred across on the head (${JSON.stringify(box)})`);
const down = (headMid.y - box.y) / box.size;
assert.ok(down > 0.3 && down < 0.55, `head sits near the middle, not cut at the top (${down.toFixed(2)})`);
assert.ok(box.y < 8, 'room above the hair');
const out = headCrop(picture, 'image/jpeg');
assert.equal(out.mime, 'image/jpeg');
assert.equal(jpeg.decode(out.bytes).width, box.size);
assert.equal(headCrop(Buffer.from('nope'), 'image/webp').mime, 'image/webp', 'unreadable pictures come back unchanged');
console.log('avatar-crop ok', box);
