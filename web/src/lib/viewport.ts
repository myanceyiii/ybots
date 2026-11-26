/**
 * Keeps the app inside the part of the window the person can actually see, so a phone's on-screen
 * keyboard never covers the message box.
 *
 * Chrome and Firefox on Android shrink the page when the keyboard opens because index.html asks for
 * `interactive-widget=resizes-content`. Safari on iPhone and iPad ignores that and slides the keyboard over
 * the page instead, so there we follow `window.visualViewport`: `--app-height` is the visible height and
 * `--app-top` how far Safari has scrolled the page to show the focused field. `#root` and the computer view
 * are sized from those two values (base.css, viewer.css).
 */
export function trackVisualViewport(): void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return;
  const root = document.documentElement.style;
  let frame = 0;

  const apply = () => {
    frame = 0;
    // While the page itself is pinch-zoomed the visible area is a zoomed window into the page, not
    // room taken by a keyboard, so leave the layout alone until the zoom is undone.
    if (Math.abs(vv.scale - 1) > 0.01) return;
    root.setProperty('--app-height', `${Math.round(vv.height)}px`);
    root.setProperty('--app-top', `${Math.max(0, Math.round(vv.offsetTop))}px`);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };

  vv.addEventListener('resize', schedule);
  vv.addEventListener('resize', revealCardFieldSoon);
  document.addEventListener('focusin', revealCardFieldSoon);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);
  apply();
}

/**
 * A field in a chat card (a secure input, a form) that gets focus on a touch screen is scrolled into view with
 * the card's buttons under it (Fill in / Don't fill), once the keyboard has made room. The browser only
 * brings the field itself into view, which leaves the buttons under the keyboard.
 */
let revealTimer = 0;
function revealCardFieldSoon(): void {
  if (!window.matchMedia?.('(pointer: coarse)').matches) return;
  window.clearTimeout(revealTimer);
  revealTimer = window.setTimeout(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || !el.matches('input, textarea, [contenteditable="true"]')) return;
    const card = el.closest<HTMLElement>('.card');
    if (!card) return;
    const actions = card.querySelector<HTMLElement>('.card__actions');
    if (actions && el.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING) actions.scrollIntoView({ block: 'nearest' });
    // The field itself wins if the card is taller than the room left.
    el.scrollIntoView({ block: 'nearest' });
  }, 300);
}
