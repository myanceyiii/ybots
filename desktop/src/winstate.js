'use strict';
// Where the window opens. The size and place it was last left in are used only if they still land on a
// screen that is plugged in: a window remembered on a monitor that is gone would open where nobody can
// see it. Free of Electron, so it can be tested.

const DEFAULT_SIZE = { width: 1200, height: 820 };
const MIN = { width: 380, height: 520 };

/**
 * @param saved   { x?, y?, width, height, maximized } or null
 * @param areas   the work areas of the screens in use: [{ x, y, width, height }]
 * @returns       { x?, y?, width, height, maximized }
 */
function fitBounds(saved, areas) {
  const list = Array.isArray(areas) && areas.length ? areas : [{ x: 0, y: 0, width: 1920, height: 1080 }];
  if (!saved) {
    const a = list[0];
    return { width: Math.min(DEFAULT_SIZE.width, a.width), height: Math.min(DEFAULT_SIZE.height, a.height), maximized: false };
  }
  let { width, height } = saved;
  const maximized = !!saved.maximized;
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) {
    const a = list[0];
    return { width: Math.max(MIN.width, Math.min(width, a.width)), height: Math.max(MIN.height, Math.min(height, a.height)), maximized };
  }
  // The screen that shows the most of the saved window.
  let best = null;
  let bestArea = 0;
  for (const a of list) {
    const w = Math.min(saved.x + width, a.x + a.width) - Math.max(saved.x, a.x);
    const h = Math.min(saved.y + height, a.y + a.height) - Math.max(saved.y, a.y);
    const area = w > 0 && h > 0 ? w * h : 0;
    if (area > bestArea) { bestArea = area; best = a; }
  }
  // Less than a title bar's worth on any screen: open it centred on the first screen instead.
  if (!best || bestArea < 120 * 40) {
    const a = list[0];
    width = Math.max(MIN.width, Math.min(width, a.width));
    height = Math.max(MIN.height, Math.min(height, a.height));
    return { x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2), width, height, maximized };
  }
  width = Math.max(MIN.width, Math.min(width, best.width));
  height = Math.max(MIN.height, Math.min(height, best.height));
  const x = Math.min(Math.max(saved.x, best.x), best.x + best.width - width);
  const y = Math.min(Math.max(saved.y, best.y), best.y + best.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), maximized };
}

module.exports = { fitBounds, DEFAULT_SIZE, MIN };
