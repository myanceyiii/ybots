/**
 * The script Teach a bot (teach.ts, docs/teach-a-bot.md) adds to every page and frame of a bot's Chrome while
 * the person is recording, in its own isolated world: the page's scripts share the DOM with it but cannot see
 * or change it.
 *
 * It reports what the person does, one step at a time, through the `cleftTeach` binding: the page they are on,
 * a click, what they typed into a field (once, when the field is left), a choice in a list, a box ticked, Enter.
 * Each target is described the way OpenBot's Recorder describes one (`describeDemonstrationTarget` in
 * CopilotKit/OpenBot `shared/demonstration-rules.ts` at f681239, MIT): its role, a name a person would read,
 * and whether it holds a secret. A field that holds a secret (a password, card, security or one-time code) is
 * reported as "[sensitive field]" and its value is never read. The server masks everything again
 * (vendor/openbot/recorder-masking.ts) before anything is kept.
 *
 * Only trusted events count (a person's input through the screen); page text is data and nothing here follows it.
 * Plain ES2019 in a string so it runs in any frame.
 */
export const TEACH_WORLD = 'cleft_teach';
export const TEACH_BINDING = 'cleftTeach';

/** OpenBot's SENSITIVE_FIELD (shared/demonstration-rules.ts), written out so the page script carries it. tests/teach.test.mjs keeps it equal to the vendored copy. */
export const SENSITIVE_FIELD_SOURCE = String.raw`password|secret|token|one.time|verification|credit.card|security.code|passcode|card.?(?:number|num|no)(?![a-z])|cardholder|card.?verification|(?:^|[^a-z])(?:cc-|(?:cvc|cvv|csc|pin|otp)(?![a-z]))`;

export const TEACH_SOURCE = String.raw`(() => {
  if (window.__cleftTeach) return;
  window.__cleftTeach = 1;
  const BIND = ${JSON.stringify(TEACH_BINDING)};
  const SENSITIVE = new RegExp(${JSON.stringify(SENSITIVE_FIELD_SOURCE)}, 'i');
  const send = (o) => { try { if (typeof window[BIND] === 'function') window[BIND](JSON.stringify(o)); } catch (_) {} };
  const isTop = (() => { try { return window.top === window; } catch (_) { return false; } })();
  const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 120);
  const TYPED = { text: 1, search: 1, email: 1, url: 1, tel: 1, number: 1, '': 1, date: 1, time: 1, 'datetime-local': 1, month: 1, week: 1 };

  function attrs(el) {
    const out = {};
    for (const k of ['type', 'name', 'id', 'autocomplete', 'placeholder', 'aria-label', 'title', 'role', 'inputmode', 'contenteditable']) {
      const v = el.getAttribute && el.getAttribute(k);
      if (v != null) out[k] = clip(v, 80);
    }
    return out;
  }

  // describeDemonstrationTarget, adapted: the element a person meant, its role, a readable name, and whether it holds a secret.
  function describe(hit) {
    const closest = (hit && hit.closest && hit.closest('button,a,input,textarea,select,label,[role],[contenteditable=true],[contenteditable=""]')) || hit;
    const el = closest && closest.tagName === 'LABEL' ? (closest.control || closest) : closest;
    if (!el || !el.tagName) return { role: 'page', name: 'Page', sensitive: false, tag: '', attrs: {} };
    const tag = el.tagName.toLowerCase();
    const inputType = tag === 'input' ? String(el.type || '').toLowerCase() : '';
    const role = el.getAttribute('role') ||
      ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', range: 'slider', file: 'button' })[inputType] ||
      ({ button: 'button', a: 'link', input: 'textbox', textarea: 'textbox', select: 'combobox' })[tag] ||
      (el.isContentEditable ? 'textbox' : tag);
    let label = el.getAttribute('aria-label') || '';
    if (!label && (tag === 'input' || tag === 'textarea' || tag === 'select')) label = Array.from(el.labels || []).map((l) => l.textContent || '').join(' ');
    if (!label && (tag === 'button' || tag === 'a' || role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab' || role === 'option')) label = el.innerText || el.textContent || '';
    if (!label && tag === 'input' && /^(submit|button|reset)$/.test(inputType)) label = el.value || '';
    if (!label) label = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || role;
    const ac = String(el.getAttribute('autocomplete') || '');
    const sensitive = inputType === 'password' || /^(cc-|one-time-code|current-password|new-password)/i.test(ac) ||
      SENSITIVE.test([label, el.getAttribute('name'), ac, el.getAttribute('id'), el.getAttribute('placeholder')].join(' '));
    return { el, tag, role: clip(role, 40), name: sensitive ? '[sensitive field]' : clip(label, 120) || role, sensitive, attrs: attrs(el) };
  }

  const fieldOf = (t) => {
    if (!t || !t.tagName) return null;
    const tag = t.tagName;
    if (tag === 'TEXTAREA') return t;
    if (tag === 'INPUT' && TYPED[String(t.type || '').toLowerCase()]) return t;
    if (t.isContentEditable) return t.closest('[contenteditable]') || t;
    if (tag === 'INPUT' && String(t.type || '').toLowerCase() === 'password') return t;
    return null;
  };

  const step = (kind, d, extra) => send(Object.assign({ t: kind, role: d.role, name: d.name, sensitive: !!d.sensitive, tag: d.tag, attrs: d.attrs, origin: location.origin, url: isTop ? location.href : '' }, extra || {}));

  if (isTop) {
    const page = () => send({ t: 'page', url: location.href, title: clip(document.title, 120), origin: location.origin });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', page, { once: true }); else page();
    window.addEventListener('popstate', page, true);
    window.addEventListener('hashchange', page, true);
  }

  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const d = describe(e.target);
    if (fieldOf(d.el) || d.role === 'combobox' && d.tag === 'select') return; // typing and choosing report themselves
    if (d.role === 'checkbox' || d.role === 'radio') return; // reported on change
    step('click', d);
  }, true);

  // Typed text is reported once, when the person leaves the field (or presses Enter in it).
  const sent = new WeakMap();
  const typed = (el) => {
    const d = describe(el);
    if (d.sensitive) { if (sent.get(el) !== '\u0000s') { sent.set(el, '\u0000s'); step('type', d); } return; }
    const text = String(el.isContentEditable ? el.innerText : el.value || '').slice(0, 300);
    if (!text.trim() || sent.get(el) === text) return;
    sent.set(el, text);
    step('type', d, { text });
  };
  document.addEventListener('change', (e) => {
    if (!e.isTrusted) return;
    const el = e.target;
    if (!el || !el.tagName) return;
    if (el.tagName === 'SELECT') {
      const d = describe(el);
      const opts = Array.from(el.selectedOptions || []).map((o) => clip(o.textContent, 80)).filter(Boolean);
      step('choose', d, d.sensitive ? {} : { text: opts.join(', ') });
      return;
    }
    const type = String(el.type || '').toLowerCase();
    if (el.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio')) { step('check', describe(el), { checked: !!el.checked }); return; }
    if (fieldOf(el)) typed(el);
  }, true);
  document.addEventListener('focusout', (e) => { const f = fieldOf(e.target); if (f && f.isContentEditable) typed(f); }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.key !== 'Enter' || e.isComposing) return;
    const f = fieldOf(e.target);
    if (f) typed(f);
    step('press', describe(e.target), { key: 'Enter' });
  }, true);
})();`;
