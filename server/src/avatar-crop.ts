import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/**
 * Head-and-shoulders crop of a bot's picture, centred on its face.
 *
 * Bot pictures are full-body characters on a plain background. A small tile (the phone's home
 * list, the web sidebar, the bot's own desktop) wants the face, so we find it: the background is
 * the colour of the corners, the character is everything else, the head runs from the first row
 * of character down to the neck (the narrowest row between the top of the head and the
 * shoulders), and the square is centred across on the head and placed so the head sits just above
 * the middle with the shoulders below. Works on JPEG and PNG; other formats come back unchanged.
 */

export interface Rgba { width: number; height: number; data: Uint8Array | Buffer }
/** A square in picture pixels; it may reach past the edges, where `ground` (the background colour) fills in. */
export interface CropBox { x: number; y: number; size: number; ground: number[] }

/** How much of the square the head takes, and how much of the spare room goes above it. */
const HEAD_SHARE = 1 / 1.7;
const ABOVE_SHARE = 0.3;
/** Never tighter than this share of the character's height, so small heads still show shoulders. */
const MIN_SIDE = 0.36;

/** Pictures bigger than this are shown uncropped rather than decoded (an avatar is a few hundred pixels). */
const MAX_SIDE = 8192;
const MAX_PIXELS = 24_000_000;

function decode(bytes: Buffer, mime: string): Rgba | null {
  try {
    if (mime === 'image/jpeg') return jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
    if (mime === 'image/png') {
      // A small file can declare a huge picture: read the size from the header before decoding it.
      if (bytes.length < 24 || bytes.readUInt32BE(12) !== 0x49484452) return null; // IHDR
      const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
      if (!w || !h || w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) return null;
      const p = PNG.sync.read(bytes);
      return { width: p.width, height: p.height, data: p.data };
    }
  } catch { /* not a picture we can read */ }
  return null;
}

/** Where the face is: a square inside the picture, in pixels. Null when nothing stands out from the background. */
export function findHeadBox(img: Rgba): CropBox | null {
  const { width: w, height: h, data } = img;
  if (w < 16 || h < 16) return null;
  const at = (x: number, y: number) => (y * w + x) * 4;
  // Background: per channel, the middle of the four corner colours.
  const corners = [at(1, 1), at(w - 2, 1), at(1, h - 2), at(w - 2, h - 2)];
  const bg = [0, 1, 2].map((c) => corners.map((i) => data[i + c]).sort((a, b) => a - b)[1]);
  const step = Math.max(1, Math.round(w / 256));
  const left = new Int32Array(h).fill(-1);
  const right = new Int32Array(h).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x += step) {
      const i = at(x, y);
      if (data[i + 3] < 24) continue;
      const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      if (d > 60) { if (left[y] < 0) left[y] = x; right[y] = x; }
    }
  }
  // Ignore specks: a row counts when it has some width.
  const minWidth = Math.max(3, Math.round(w * 0.02));
  const has = (y: number) => left[y] >= 0 && right[y] - left[y] >= minWidth;
  let top = 0;
  while (top < h && !has(top)) top++;
  let bottom = h - 1;
  while (bottom > top && !has(bottom)) bottom--;
  if (top >= h || bottom - top < h * 0.1) return null;
  const tall = bottom - top + 1;
  // The neck: the narrowest row between 12% and 35% of the way down the character.
  let neck = -1;
  let narrow = Infinity;
  for (let y = top + Math.round(tall * 0.12); y <= top + Math.round(tall * 0.35) && y <= bottom; y++) {
    if (!has(y)) continue;
    const width = right[y] - left[y];
    if (width < narrow) { narrow = width; neck = y; }
  }
  if (neck < 0) neck = top + Math.round(tall * 0.2);
  const headH = neck - top;
  // Across: the middle of the head rows.
  let sum = 0;
  let n = 0;
  for (let y = top; y <= neck; y++) if (has(y)) { sum += (left[y] + right[y]) / 2; n++; }
  const cx = n ? sum / n : w / 2;
  let size = Math.round(Math.max(headH / HEAD_SHARE, tall * MIN_SIDE));
  size = Math.min(size, w, h);
  let y = Math.round(top - (size - headH) * ABOVE_SHARE);
  let x = Math.round(cx - size / 2);
  // Characters drawn right up to the top edge get background added above, so the face still sits near the middle.
  x = Math.max(-size / 4, Math.min(w - size * 0.75, x));
  y = Math.max(-size / 4, Math.min(h - size, y));
  const clear = corners.filter((i) => data[i + 3] < 24).length >= 2;
  return { x: Math.round(x), y: Math.round(y), size, ground: clear ? [0xf4, 0xef, 0xe9] : bg };
}

function encodeJpeg(img: Rgba, box: CropBox): Buffer {
  const out = Buffer.alloc(box.size * box.size * 4);
  const ground = box.ground;
  for (let y = 0; y < box.size; y++) {
    for (let x = 0; x < box.size; x++) {
      const sx = box.x + x;
      const sy = box.y + y;
      const d = (y * box.size + x) * 4;
      out[d + 3] = 255;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) { out[d] = ground[0]; out[d + 1] = ground[1]; out[d + 2] = ground[2]; continue; }
      const s = (sy * img.width + sx) * 4;
      const a = img.data[s + 3] / 255;
      for (let c = 0; c < 3; c++) out[d + c] = Math.round(img.data[s + c] * a + ground[c] * (1 - a));
    }
  }
  return jpeg.encode({ width: box.size, height: box.size, data: out }, 90).data;
}

const cache = new Map<string, { bytes: Buffer; mime: string }>();
const CACHE_MAX = 64;

/** The head crop of a picture (JPEG), or the picture itself when it can't be read. Cached by content. */
export function headCrop(bytes: Buffer, mime: string): { bytes: Buffer; mime: string } {
  const key = createHash('sha1').update(bytes).digest('hex');
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const img = decode(bytes, mime);
  const box = img && findHeadBox(img);
  const result = img && box ? { bytes: encodeJpeg(img, box), mime: 'image/jpeg' } : { bytes, mime };
  cache.set(key, result);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return result;
}

/** Add `crop=head` to an avatar or pose address. */
export const headUrl = (url: string) => `${url}${url.includes('?') ? '&' : '?'}crop=head`;
