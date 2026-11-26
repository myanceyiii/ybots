'use strict';
// The small pictures Windows shows for "something needs you": a red circle with a count on the taskbar
// button, and a dot on the tray icon. Drawn here as raw pixels (BGRA, alpha premultiplied, the layout
// Electron's nativeImage.createFromBitmap takes on Windows), so no image files and no canvas are needed.

const FONT = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};

/** What the badge says for a count: "3", "12", "9+" is never needed below 100, "99+" does not fit, so 99. */
function badgeText(count) {
  const n = Math.floor(Number(count) || 0);
  if (n <= 0) return '';
  return n > 99 ? '99' : String(n);
}

/** How much of pixel (px, py) a circle covers, 0..1, from a 4x4 grid of samples. */
function coverage(px, py, cx, cy, r) {
  let hit = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const dx = px + (sx + 0.5) / 4 - cx;
      const dy = py + (sy + 0.5) / 4 - cy;
      if (dx * dx + dy * dy <= r * r) hit++;
    }
  }
  return hit / 16;
}

/** Paints colour [r, g, b] over the pixel at `i` with coverage `a`, keeping the buffer premultiplied. */
function over(buf, i, [r, g, b], a) {
  if (a <= 0) return;
  buf[i] = Math.round(b * a + buf[i] * (1 - a));
  buf[i + 1] = Math.round(g * a + buf[i + 1] * (1 - a));
  buf[i + 2] = Math.round(r * a + buf[i + 2] * (1 - a));
  buf[i + 3] = Math.round(255 * a + buf[i + 3] * (1 - a));
}

function disc(buf, size, cx, cy, r, color) {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(size - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(size - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) over(buf, (y * size + x) * 4, color, coverage(x, y, cx, cy, r));
}

/**
 * The taskbar badge for a count: a filled circle with the number in white.
 * @returns { width, height, data } or null when there is nothing to show.
 */
function badgeBitmap(count, { size = 32, color = [226, 38, 54] } = {}) {
  const text = badgeText(count);
  if (!text) return null;
  const data = Buffer.alloc(size * size * 4);
  disc(data, size, size / 2, size / 2, size / 2, color);
  const scale = Math.max(1, Math.floor(size / (text.length === 1 ? 8 : 11)));
  const gap = scale;
  const w = text.length * 3 * scale + (text.length - 1) * gap;
  const h = 5 * scale;
  let x0 = Math.round((size - w) / 2);
  const y0 = Math.round((size - h) / 2);
  for (const ch of text) {
    const glyph = FONT[ch];
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) over(data, ((y0 + gy * scale + dy) * size + x0 + gx * scale + dx) * 4, [255, 255, 255], 1);
      }
    }
    x0 += 3 * scale + gap;
  }
  return { width: size, height: size, data };
}

/**
 * A copy of a square icon (BGRA pixels) with a dot in its bottom-right corner, ringed so it reads on any
 * taskbar colour. `kind`: 'waiting' (a bot needs an answer, red) or 'unread' (blue).
 */
function withDot(pixels, size, kind = 'unread') {
  const data = Buffer.from(pixels);
  const r = size * 0.24;
  const c = size - r - size * 0.03;
  disc(data, size, c, c, r + size * 0.05, [255, 255, 255]);
  disc(data, size, c, c, r, kind === 'waiting' ? [226, 38, 54] : [41, 121, 255]);
  return { width: size, height: size, data };
}

module.exports = { badgeText, badgeBitmap, withDot };
