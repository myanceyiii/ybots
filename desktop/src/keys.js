'use strict';
// The keys the Windows shell itself answers (zoom, find, reload, back and forward...), worked out from a
// key press before the page sees it. Everything else goes to the web app untouched, including its own
// shortcuts (Ctrl+K search, Ctrl+B sidebar, Ctrl+, settings). Free of Electron, so it can be tested.

/**
 * @param input  Electron's before-input-event input: { type, key, control, shift, alt, meta }
 * @returns the shell command for that key press, or null to let the page have it
 */
function shellCommand(input) {
  if (!input || input.type !== 'keyDown' || input.meta) return null;
  const key = typeof input.key === 'string' ? (input.key.length === 1 ? input.key.toLowerCase() : input.key) : '';
  const { control = false, shift = false, alt = false } = input;
  if (control && !alt) {
    if (key === '=' || key === '+') return 'zoom-in';
    if (key === '-' || key === '_') return 'zoom-out';
    if (!shift) {
      if (key === '0') return 'zoom-reset';
      if (key === 'f') return 'find';
      if (key === 'g') return 'find-next';
      if (key === 'r') return 'reload';
      if (key === 'w') return 'close';
      if (key === 'p') return 'print';
    } else {
      if (key === 'r') return 'hard-reload';
      if (key === 'g') return 'find-prev';
      if (key === 'i') return 'devtools';
    }
    return null;
  }
  if (alt && !control && !shift) {
    if (key === 'ArrowLeft') return 'back';
    if (key === 'ArrowRight') return 'forward';
    return null;
  }
  if (!control && !alt) {
    if (key === 'F5') return shift ? 'hard-reload' : 'reload';
    if (key === 'F3') return shift ? 'find-prev' : 'find-next';
    if (key === 'F11' && !shift) return 'fullscreen';
    if (key === 'F12' && !shift) return 'devtools';
  }
  return null;
}

/** The next zoom step up or down from `zoom`, kept between 50% and 300%. */
function zoomStep(zoom, dir) {
  const steps = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const z = Number.isFinite(zoom) ? zoom : 1;
  if (dir > 0) return steps.find((s) => s > z + 0.001) ?? 3;
  return [...steps].reverse().find((s) => s < z - 0.001) ?? 0.5;
}

module.exports = { shellCommand, zoomStep };
