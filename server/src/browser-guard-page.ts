/**
 * The script the browser guard (browser-guard.ts) adds to every page and frame of a bot's Chrome, in an
 * isolated world named "cleft_guard": the page's own scripts share the DOM with it but cannot see or
 * change its variables, and nothing the bot runs in the page reaches it either.
 *
 * It does five things, all reported to the server through the `cleftGuard` binding:
 *  - holds every click, tap, Enter and form submit aimed at a purchase control unless a purchase
 *    approval for the page's current state is armed (the server arms it after the person approves);
 *  - reads a checkout for the purchase card (total, card last four, merchant, items, shipping, recurring);
 *  - finds and stamps the field a secure-input card is for, focuses it, and checks a value landed
 *    without ever returning the value;
 *  - notices CAPTCHAs;
 *  - on social sites, for bots with the publish guard on, holds Post / Share / Schedule presses unless the
 *    composer's text matches a caption on an approved posting plan, and holds every one in a dry run;
 *  - holds presses that delete, send, share, post or change a password (action-kinds.ts: a button whose label
 *    starts with the action, Ctrl/Cmd+Enter in a text box, Enter in a box for writing a message) unless the
 *    person allowed that kind on this site (once, for the conversation, or always). Never while the person has
 *    taken control of the screen: their own presses are theirs.
 *
 * Page text is data: nothing here follows anything a page says. Kept as plain ES2019 in a string so it
 * runs in any frame; exported functions on `__cleftGuard` are called by the server with Runtime.evaluate
 * in this world.
 */
import { KIND_BUTTON_SOURCE } from './action-kinds.js';

export const GUARD_WORLD = 'cleft_guard';
export const GUARD_BINDING = 'cleftGuard';

export const GUARD_SOURCE = String.raw`(() => {
  if (window.__cleftGuard) return;
  const BIND = ${JSON.stringify(GUARD_BINDING)};
  const report = (o) => { try { if (typeof window[BIND] === 'function') window[BIND](JSON.stringify(o)); } catch (_) {} };
  const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 160);

  // Words on a control that complete a payment. Conservative: anything that looks like paying is held.
  const PAY = /\b(place (?:your |my )?order|submit (?:your |my )?order|complete (?:my |your )?(?:purchase|order|payment|checkout)|confirm (?:and pay|& pay|purchase|order|payment|booking and pay)|buy now|buy it now|pay now|pay (?:securely|with|by)|pay\s*(?:[$€£¥]|usd|eur|gbp)\s*\d|^pay$|purchase(?: now)?$|checkout now|1-click|one-click|subscribe(?: now)?$|start (?:my |your )?(?:subscription|membership|paid plan)|upgrade now|donate(?: now)?|book (?:now )?and pay|reserve and pay|send (?:money|payment)|send\s*[$€£¥]\s*\d|authori[sz]e payment|make (?:a )?payment)\b/i;
  const WALLET = /\b(paypal|venmo|apple pay|google pay|g pay|shop pay|amazon pay|klarna|afterpay|affirm|link pay)\b/i;
  const PROCESSOR_HOST = /(^|\.)(paypal\.com|paypalobjects\.com|stripe\.com|braintreegateway\.com|braintree-api\.com|adyen\.com|checkout\.com|squareup\.com|square\.site|klarna\.com|afterpay\.com|affirm\.com|pay\.google\.com|shop\.app|authorize\.net|worldpay\.com|cybersource\.com)$/i;
  const CARD_AC = /^cc-(number|csc|exp|exp-month|exp-year|name)$/i;
  const CARD_NAME = /(card.?num|cardnumber|cc.?num|ccnumber|credit.?card|\bcvc\b|\bcvv\b|security.?code|card.?code|expir|exp.?date)/i;

  const isTop = (() => { try { return window.top === window; } catch (_) { return false; } })();
  const inProcessor = PROCESSOR_HOST.test(location.hostname);

  function labelOf(el) {
    if (!el) return '';
    const parts = [el.getAttribute && el.getAttribute('aria-label'), el.getAttribute && el.getAttribute('title'),
      el.tagName === 'INPUT' ? el.value : '', el.innerText || el.textContent, el.getAttribute && el.getAttribute('alt')];
    for (const p of parts) { const t = clean(p, 120); if (t) return t; }
    return '';
  }

  function controlOf(t) {
    let el = t && t.nodeType === 1 ? t : t && t.parentElement;
    for (let i = 0; el && i < 8; i++, el = el.parentElement) {
      const tag = el.tagName;
      const role = el.getAttribute('role');
      if (tag === 'BUTTON' || tag === 'A' || role === 'button' || role === 'link' || (tag === 'INPUT' && /^(submit|button|image)$/i.test(el.type))) return el;
    }
    return null;
  }

  function hasCardFields(root) {
    try {
      for (const f of root.querySelectorAll('input, iframe')) {
        if (f.tagName === 'IFRAME') { try { if (PROCESSOR_HOST.test(new URL(f.src, location.href).hostname)) return true; } catch (_) {} continue; }
        const ac = (f.getAttribute('autocomplete') || '').split(/\s+/).pop();
        if (CARD_AC.test(ac) || CARD_NAME.test((f.name || '') + ' ' + (f.id || '') + ' ' + (f.getAttribute('placeholder') || ''))) return true;
      }
    } catch (_) {}
    return false;
  }

  /** The purchase control an event is aimed at, with why, or null. */
  function purchaseTarget(t) {
    const el = controlOf(t);
    if (el) {
      const label = labelOf(el);
      if (PAY.test(label)) return { el, label, why: 'label' };
      if (WALLET.test(label) && (el.tagName !== 'A' || inProcessor)) return { el, label, why: 'wallet' };
      if (inProcessor && !isTop) return { el, label: label || 'payment button', why: 'processor' };
      const form = el.form || (el.closest && el.closest('form'));
      const submits = el.tagName === 'BUTTON' ? (el.type || 'submit') === 'submit' : el.tagName === 'INPUT' && /^(submit|image)$/i.test(el.type);
      if (form && submits && hasCardFields(form)) return { el, label: label || 'submit', why: 'card form' };
    }
    return null;
  }

  // ---------------------------------------------------------------- reading a checkout
  const MONEY = /(?:([$€£¥])\s?(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?))|(?:(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)\s?(USD|EUR|GBP|CAD|AUD|JPY))/i;
  const SYM = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
  const money = (s) => { const m = MONEY.exec(s || ''); if (!m) return null; const cur = m[1] ? SYM[m[1]] : m[4].toUpperCase(); const amt = (m[2] || m[3]).replace(/[,\s]/g, ''); return { amount: amt, currency: cur, text: m[0] }; };
  const TOTAL = /^(order total|total(?: due| to pay| price| amount| \(incl[^)]*\))?|amount due|grand total|you pay|estimated total|total today|due today|pay today|amount to pay|balance due)\b/i;

  function visible(el) { try { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; } catch (_) { return false; } }

  function readTotal() {
    let best = null;
    const nodes = document.querySelectorAll('body *');
    let n = 0;
    for (const el of nodes) {
      if (++n > 6000) break;
      if (el.children.length > 6) continue;
      const own = clean(el.innerText, 120);
      if (!own || own.length > 100 || !TOTAL.test(own)) continue;
      if (!visible(el)) continue;
      let m = money(own);
      let host = el;
      for (let i = 0; !m && host && i < 3; i++) { host = host.parentElement; if (host) { const t = clean(host.innerText, 200); if (t.length < 200) m = money(t.replace(/^[\s\S]*?(order total|grand total|total|amount due|you pay|due today)/i, '')); } }
      if (m) best = { ...m, label: clean(own.replace(MONEY, ''), 40) };
    }
    if (!best) {
      for (const b of document.querySelectorAll('button, input[type=submit], [role=button]')) {
        const l = labelOf(b);
        if (PAY.test(l) && money(l)) { best = { ...money(l), label: l }; break; }
      }
    }
    return best;
  }

  function readCard() {
    const t = clean(document.body ? document.body.innerText : '', 40000);
    const m = /\b(visa|mastercard|master card|amex|american express|discover|diners|jcb|debit|credit|card)\b[^\n\d]{0,24}?(?:ending(?: in)?|ends? in|[•*·xX]{2,}[\s-]*)\s*(\d{4})\b/i.exec(t);
    if (m) return { brand: clean(m[1], 20), last4: m[2] };
    const w = WALLET.exec(t);
    return w ? { brand: clean(w[1], 20), last4: '' } : null;
  }

  /** The value next to a label such as "Ship to": the label's own box if it holds more, else its parent's. */
  function nearText(re, n) {
    for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,dt,th,label,legend,strong,b,span,div,p,td')) {
      if (el.children.length > 4) continue;
      const own = clean(el.innerText, 300);
      const m = own && own.length < 200 ? re.exec(own) : null;
      if (!m || !visible(el)) continue;
      let txt = own.length > m[0].length + 3 ? own : clean((el.parentElement || el).innerText, 300);
      if (txt.length > 240) continue;
      txt = txt.replace(re, '').replace(/^[\s:]+/, '');
      if (txt) return clean(txt, n || 160);
    }
    return '';
  }

  function readItems() {
    const out = [];
    const seen = new Set();
    const sel = '[class*="line-item" i], [class*="lineitem" i], [class*="cart-item" i], [class*="order-item" i], [data-testid*="item" i], [class*="product-row" i], [class*="summary-item" i]';
    for (const el of document.querySelectorAll(sel)) {
      if (out.length >= 8) break;
      if (!visible(el)) continue;
      const txt = clean(el.innerText, 140);
      if (!txt || seen.has(txt) || txt.length < 3) continue;
      seen.add(txt);
      out.push(txt);
    }
    return out;
  }

  function payControls() {
    const out = [];
    for (const b of document.querySelectorAll('button, a, input[type=submit], input[type=button], input[type=image], [role=button]')) {
      if (out.length >= 6) break;
      const l = labelOf(b);
      if ((PAY.test(l) || (WALLET.test(l) && b.tagName !== 'A')) && visible(b) && !b.disabled) out.push(l);
    }
    return out;
  }

  function hasCaptcha() {
    for (const f of document.querySelectorAll('iframe')) {
      const s = (f.src || '') + ' ' + (f.title || '');
      if (/recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|captcha/i.test(s) && visible(f)) return true;
    }
    return !!document.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile, #px-captcha, [id*="captcha" i][class*="captcha" i]');
  }

  function read() {
    const total = isTop ? readTotal() : null;
    const og = document.querySelector('meta[property="og:site_name"]');
    const body = document.body ? document.body.innerText : '';
    const recurring = /\b(subscription|per month|\/\s?mo\b|monthly|per year|\/\s?yr\b|annually|yearly|renews?|recurring|auto-?renew|billed (?:monthly|yearly|annually|every)|free trial)\b/i.exec(body);
    const shipLine = /\b(shipping|delivery)\b[^\n$€£¥\d]{0,30}(free|[$€£¥]\s?\d[\d,.]*)/i.exec(body);
    return {
      origin: location.origin, url: location.href.slice(0, 300), title: clean(document.title, 120),
      site: clean(og && og.getAttribute('content'), 80),
      total: total ? { amount: total.amount, currency: total.currency, text: total.text, label: total.label } : null,
      card: isTop ? readCard() : null,
      items: isTop ? readItems() : [],
      shipping: shipLine ? clean(shipLine[0].replace(/^(shipping|delivery)\b[\s:]*/i, ''), 80) : '',
      shipTo: isTop ? clean(nearText(/^(ship(?:ping)? to|shipping address|deliver(?:y)? to|delivery address)\b/i, 160), 160) : '',
      recurring: recurring ? clean(recurring[0], 40) : '',
      controls: payControls(),
      kindControls: kindControls(),
      cardFields: hasCardFields(document),
      captcha: hasCaptcha(),
      top: isTop, processor: inProcessor,
    };
  }

  /** What an approval is bound to: the origin, the total, its currency and the card shown. */
  function stateKey() {
    const r = read();
    return [r.origin, r.total ? r.total.amount : '', r.total ? r.total.currency : '', r.card ? r.card.last4 : ''].join('|');
  }

  // ---------------------------------------------------------------- holding purchase controls
  let armed = null;   // { key, until } set by the server after the person approves
  let passing = 0;    // a short window in which the approved click's events go through
  let pubPassing = 0; // the same for an approved Post press: kept apart, so one approval never lets the other kind through

  function decide(e, hit) {
    const now = Date.now();
    if (now < passing) return;
    if (armed && armed.until > now) {
      const key = isTop ? stateKey() : '*';
      if (armed.key === '*' || armed.key === key) {
        armed = null; passing = now + 2500;
        report({ t: 'passed', label: hit.label, origin: location.origin });
        return;
      }
      armed = null;
      e.preventDefault(); e.stopImmediatePropagation();
      report({ t: 'changed', label: hit.label, origin: location.origin, key });
      return;
    }
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type === 'click' || e.type === 'submit' || e.type === 'keydown') report({ t: 'held', label: hit.label, why: hit.why, origin: location.origin, top: isTop });
  }

  const onPointer = (e) => { const hit = purchaseTarget(e.target); if (hit) decide(e, hit); };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart', 'touchend', 'click', 'auxclick', 'dblclick']) window.addEventListener(type, onPointer, true);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    let hit = purchaseTarget(e.target);
    if (!hit && e.key === 'Enter') {
      const form = e.target && e.target.form;
      if (form && hasCardFields(form)) hit = { el: form, label: 'Enter in a payment form', why: 'card form' };
      else if (form) { for (const b of form.querySelectorAll('button, input[type=submit]')) { const l = labelOf(b); if (PAY.test(l)) { hit = { el: b, label: l, why: 'label' }; break; } } }
    }
    if (hit) decide(e, hit);
  }, true);
  window.addEventListener('submit', (e) => {
    const form = e.target;
    const sub = e.submitter;
    let hit = sub ? purchaseTarget(sub) : null;
    if (!hit && form && hasCardFields(form)) hit = { el: form, label: sub ? labelOf(sub) || 'submit' : 'payment form', why: 'card form' };
    if (!hit && form) { for (const b of form.querySelectorAll('button, input[type=submit]')) { const l = labelOf(b); if (PAY.test(l)) { hit = { el: b, label: l, why: 'label' }; break; } } }
    if (hit) decide(e, hit);
  }, true);

  // ---------------------------------------------------------------- holding publish controls (posting.ts)
  // On social sites, for bots with the publish guard on, every Post / Share / Publish / Schedule / Reply /
  // Send press is held unless the text in the composer matches a caption the person approved on a posting
  // plan card. In a dry run every such press is held and reported, so a recipe can stop at the last step.
  const SOCIAL = /(^|\.)(facebook\.com|instagram\.com|youtube\.com|x\.com|twitter\.com|tiktok\.com|linkedin\.com|threads\.net|threads\.com)$/i;
  const onSocial = SOCIAL.test(location.hostname);
  const platformOf = (h) => /facebook/.test(h) ? 'facebook' : /instagram/.test(h) ? 'instagram' : /youtube/.test(h) ? 'youtube' : /(^|\.)(x|twitter)\.com$/.test(h) ? 'x' : /tiktok/.test(h) ? 'tiktok' : /linkedin/.test(h) ? 'linkedin' : /threads/.test(h) ? 'threads' : '';
  const PLATFORM = platformOf(location.hostname);
  const PUBLISH = /^(post|post all|post now|post reel|publish|publish now|schedule|schedule post|schedule reel|share|share now|share post|tweet|tweet all|reply|reply all|comment|send|go live)$/i;
  // Set by the server: allow = [{ h: hash, p: platform }]. Starts closed when the server marked this bot.
  let pub = { on: !!window.__cleftPubOn, dry: false, allow: [] };

  // The same normalising and hash as posting.ts captionHash(): lower case, no zero-width or format characters,
  // whitespace collapsed, then cyrb53 as hex.
  function norm(s) { return String(s || '').normalize('NFKC').replace(/[\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }

  /** The text boxes of the composer a control belongs to (its dialog or form, else the whole page). */
  function composerTexts(el) {
    const scope = (el && el.closest && (el.closest('[role=dialog]') || el.closest('form'))) || document;
    const out = [];
    for (const b of scope.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""], [role=textbox]')) {
      if (out.length >= 8) break;
      if (!visible(b)) continue;
      const t = b.tagName === 'TEXTAREA' ? b.value : (b.innerText || b.textContent);
      if (norm(t)) out.push(String(t));
    }
    return out;
  }

  /** YouTube's Save only publishes when Public, Unlisted or a schedule is chosen; Private stays private. */
  function ytSavePublishes() {
    for (const r of document.querySelectorAll('[role=radio][aria-checked=true], tp-yt-paper-radio-button[checked], input[type=radio]:checked')) {
      const l = clean((r.getAttribute('aria-label') || '') + ' ' + (r.innerText || r.name || r.value || ''), 80);
      if (/public|unlisted|schedule/i.test(l)) return true;
    }
    return /schedule|public/i.test(clean((document.querySelector('#visibility-text, [id*="visibility" i]') || {}).innerText || '', 80)) && !/private/i.test(clean((document.querySelector('#visibility-text') || {}).innerText || '', 80));
  }

  function publishTarget(t) {
    if (!onSocial || !pub.on) return null;
    const el = controlOf(t);
    if (!el) return null;
    // A link that goes somewhere (X's side "Post" opens the composer) is not the final press.
    if (el.tagName === 'A' && el.getAttribute('href') && !/^(#|javascript:)/i.test(el.getAttribute('href'))) return null;
    const label = labelOf(el);
    const tid = (el.getAttribute('data-testid') || '').toLowerCase();
    if (PUBLISH.test(label) || /^tweetbutton/.test(tid)) return { el, label: label || 'Post', why: 'label' };
    if (PLATFORM === 'youtube' && /^(save|done)$/i.test(label) && ytSavePublishes()) return { el, label, why: 'youtube save' };
    return null;
  }

  function pubDecide(e, hit) {
    const now = Date.now();
    if (now < pubPassing) return;
    const texts = composerTexts(hit.el);
    const hashes = texts.map((x) => hash(norm(x)));
    if (!pub.dry) {
      const ok = pub.allow.find((a) => (!a.p || a.p === PLATFORM || (PLATFORM === 'facebook' && a.p === 'instagram')) && hashes.includes(a.h));
      if (ok) { pubPassing = now + 2500; report({ t: 'published', label: hit.label, origin: location.origin, platform: PLATFORM, h: ok.h }); return; }
    }
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type === 'click' || e.type === 'submit' || e.type === 'keydown') {
      report({ t: pub.dry ? 'pub_dry' : 'pub_held', label: hit.label, origin: location.origin, platform: PLATFORM, texts: texts.length, preview: clean(texts.join(' / '), 120) });
    }
  }

  const onPubPointer = (e) => { const hit = publishTarget(e.target); if (hit) pubDecide(e, hit); };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart', 'touchend', 'click', 'auxclick', 'dblclick']) window.addEventListener(type, onPubPointer, true);
  window.addEventListener('keydown', (e) => {
    if (!onSocial || !pub.on || (e.key !== 'Enter' && e.key !== ' ')) return;
    let hit = publishTarget(e.target);
    // Enter in a comment or reply box posts it on most sites; Ctrl/Cmd+Enter posts in X's composer.
    if (!hit && e.key === 'Enter' && !e.shiftKey) {
      const box = e.target && e.target.closest && e.target.closest('textarea, [contenteditable="true"], [contenteditable=""], [role=textbox]');
      const words = box ? clean((box.getAttribute('aria-label') || '') + ' ' + (box.getAttribute('placeholder') || '') + ' ' + (box.getAttribute('aria-placeholder') || ''), 120) : '';
      if (box && (/comment|reply|write|add a|message|post your/i.test(words) || e.ctrlKey || e.metaKey)) hit = { el: box, label: 'Enter in ' + (words || 'a text box'), why: 'enter' };
    }
    if (hit) pubDecide(e, hit);
  }, true);
  window.addEventListener('submit', (e) => {
    if (!onSocial || !pub.on) return;
    const sub = e.submitter;
    const hit = sub ? publishTarget(sub) : null;
    if (hit) pubDecide(e, hit);
  }, true);

  // ---------------------------------------------------------------- holding kinds of action (action-kinds.ts)
  // Deleting, sending, sharing, posting and changing a password are held whatever the bot's tool rules say,
  // unless the person allowed that kind on this site: once (armed for one press), for the conversation, or
  // always. The server pushes what is allowed (setKinds) before every browser step. Paying keeps the purchase
  // hold above; Post / Share on a social site with the publish guard on keeps the posting plan hold.
  const KB = ${KIND_BUTTON_SOURCE};
  const KRE = {};
  for (const k of Object.keys(KB)) KRE[k] = new RegExp(KB[k], 'i');
  const KIND_ORDER = ['credentials', 'delete', 'share', 'post', 'send'];
  const SITE = String(location.hostname || '').toLowerCase().replace(/^www\./, '');
  let kinds = { control: false, allow: [], once: null };
  let kindPassing = 0;

  function kindOfLabel(label, el) {
    const l = clean(label, 120);
    if (!l) return null;
    for (const k of KIND_ORDER) {
      if (!KRE[k].test(l)) continue;
      // "Comment" and "Reply" alone often open a box: they count only when text is written in their composer.
      if (KRE.needsText.test(l)) {
        const scope = el && el.closest && (el.closest('[role=dialog]') || el.closest('form'));
        if (!scope || !composerTexts(el).length) return null;
      }
      return k;
    }
    return null;
  }
  /** A form that changes a password: the current one and a new one. A sign-up has only a new one. */
  function changesPassword(el) {
    const form = el && (el.form || (el.closest && el.closest('form')));
    return !!(form && form.querySelector('input[autocomplete~="new-password"]') && form.querySelector('input[autocomplete~="current-password"]'));
  }
  function kindTarget(t) {
    const el = controlOf(t);
    if (!el) return null;
    // A link that goes somewhere (a "Delete account" settings page) is browsing, not the action.
    if (el.tagName === 'A' && el.getAttribute('href') && !/^(#|javascript:)/i.test(el.getAttribute('href'))) return null;
    const label = labelOf(el);
    let kind = kindOfLabel(label, el);
    if (!kind) {
      const submits = el.tagName === 'BUTTON' ? (el.type || 'submit') === 'submit' : el.tagName === 'INPUT' && /^(submit|image)$/i.test(el.type);
      if (submits && changesPassword(el)) kind = 'credentials';
    }
    return kind ? { el, label: label || kind, kind } : null;
  }
  function kindControls() {
    const out = [];
    for (const b of document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')) {
      if (out.length >= 6) break;
      const l = labelOf(b);
      const k = l && visible(b) && !b.disabled ? kindOfLabel(l, b) : null;
      if (k) out.push({ k, l: clean(l, 60) });
    }
    return out;
  }
  function kindAllowed(kind) { return kinds.allow.some((a) => a.k === kind && a.s === SITE); }

  function kindDecide(e, hit) {
    const now = Date.now();
    if (kinds.control) return;
    if (now < kindPassing) return;
    const final = e.type === 'click' || e.type === 'submit' || e.type === 'keydown';
    if (hit.kind !== 'credentials' && kindAllowed(hit.kind)) {
      if (final) report({ t: 'kind_passed', kind: hit.kind, label: hit.label, origin: location.origin, site: SITE, via: 'standing' });
      return;
    }
    const o = kinds.once;
    if (hit.kind !== 'credentials' && o && o.until > now && o.k === hit.kind && o.s === SITE) {
      kinds.once = null; kindPassing = now + 2500;
      report({ t: 'kind_passed', kind: hit.kind, label: hit.label, origin: location.origin, site: SITE, via: 'once' });
      return;
    }
    e.preventDefault(); e.stopImmediatePropagation();
    if (final) report({ t: 'kind_held', kind: hit.kind, label: hit.label, origin: location.origin, site: SITE, top: isTop });
  }

  const otherHold = (t) => !!(purchaseTarget(t) || publishTarget(t));
  const onKindPointer = (e) => { if (otherHold(e.target)) return; const hit = kindTarget(e.target); if (hit) kindDecide(e, hit); };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart', 'touchend', 'click', 'auxclick', 'dblclick']) window.addEventListener(type, onKindPointer, true);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (otherHold(e.target)) return;
    let hit = kindTarget(e.target);
    if (!hit && e.key === 'Enter') {
      const box = e.target && e.target.closest && e.target.closest('textarea, [contenteditable="true"], [contenteditable=""], [role=textbox], input');
      if (box) {
        const words = clean((box.getAttribute('aria-label') || '') + ' ' + (box.getAttribute('placeholder') || '') + ' ' + (box.getAttribute('aria-placeholder') || '') + ' ' + (box.getAttribute('name') || ''), 120);
        const search = /search|find|filter|look ?up|url|address bar/i.test(words) || (box.getAttribute('type') || '') === 'search' || /^(searchbox|combobox)$/.test(box.getAttribute('role') || '');
        // Enter in a social site's comment box is the publish hold's when it is on.
        const pubOwns = onSocial && pub.on;
        if (!search && !pubOwns && box.tagName !== 'INPUT' && (e.ctrlKey || e.metaKey)) hit = { el: box, label: (e.metaKey ? 'Cmd' : 'Ctrl') + '+Enter in ' + (words || 'a text box'), kind: 'send' };
        else if (!search && !pubOwns && !e.shiftKey && /\b(message|reply|comment|chat|write a|send a|type a|say something)\b/i.test(words)) hit = { el: box, label: 'Enter in ' + (words || 'a message box'), kind: 'send' };
        else if (!search) {
          // Enter in a form field submits the form: held when the form's own button is a kind of action.
          const form = box.form || (box.closest && box.closest('form'));
          if (form) for (const b of form.querySelectorAll('button, input[type=submit]')) { const l = labelOf(b); const k = kindOfLabel(l, b) || (changesPassword(b) && (b.type || 'submit') === 'submit' ? 'credentials' : null); if (k) { hit = { el: b, label: l || k, kind: k }; break; } }
        }
      }
    }
    if (hit) kindDecide(e, hit);
  }, true);
  window.addEventListener('submit', (e) => {
    const sub = e.submitter;
    if (sub && otherHold(sub)) return;
    let hit = sub ? kindTarget(sub) : null;
    if (!hit && e.target && changesPassword(sub || e.target.querySelector('input'))) hit = { el: e.target, label: sub ? labelOf(sub) || 'Change password' : 'Change password', kind: 'credentials' };
    if (hit) kindDecide(e, hit);
  }, true);

  /** What a post composer shows, for the dry run report and the posting status. Never fills anything. */
  function readPost() {
    const texts = composerTexts(document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
    const files = [];
    for (const f of document.querySelectorAll('input[type=file]')) { try { for (const x of f.files || []) files.push(clean(x.name, 80)); } catch (_) {} }
    return { origin: location.origin, platform: PLATFORM, texts: texts.map((x) => clean(x, 300)), hashes: texts.map((x) => hash(norm(x))), files };
  }

  let captchaSent = false;
  const watchCaptcha = () => { if (!captchaSent && hasCaptcha()) { captchaSent = true; report({ t: 'captcha', origin: location.origin }); } };
  setTimeout(watchCaptcha, 1500); setTimeout(watchCaptcha, 5000);

  // ---------------------------------------------------------------- secure input fields
  const KINDS = {
    password: { ac: /current-password|new-password/, name: /pass(word|wd|code)?|pwd|\bpin\b/i, type: /^password$/ },
    username: { ac: /username|email/, name: /user|login|email|account|e-?mail|phone/i, type: /^(text|email|tel)$/ },
    email: { ac: /email|username/, name: /e-?mail/i, type: /^(email|text)$/ },
    one_time_code: { ac: /one-time-code/, name: /otp|one.?time|2fa|mfa|totp|verif|security.?code|auth.?code|\bcode\b|token|pin/i, type: /^(text|tel|number|password)$/ },
    card_number: { ac: /cc-number/, name: /card.?num|cardnumber|cc.?num|ccnumber|credit.?card|\bpan\b/i, type: /^(text|tel|number)$/ },
    card_expiry: { ac: /cc-exp/, name: /expir|exp.?date|\bexp\b|mm.?yy/i, type: /^(text|tel)$/ },
    card_cvc: { ac: /cc-csc/, name: /\bcvc\b|\bcvv\b|\bcsc\b|security.?code|card.?code/i, type: /^(text|tel|number|password)$/ },
    other: { ac: /^$/, name: /^$/, type: /^(text|email|tel|number|password|search|url)$/ },
  };

  function fieldLabel(f) {
    let t = '';
    try { if (f.labels && f.labels[0]) t = f.labels[0].innerText; } catch (_) {}
    if (!t) t = f.getAttribute('aria-label') || '';
    if (!t) { const id = f.getAttribute('aria-labelledby'); if (id) { const l = document.getElementById(id.split(/\s+/)[0]); if (l) t = l.innerText; } }
    if (!t) t = f.getAttribute('placeholder') || f.name || f.id || f.type;
    return clean(t, 60);
  }

  function score(f, kind, hint) {
    const k = KINDS[kind] || KINDS.other;
    if (f.disabled || f.readOnly || !visible(f)) return -1;
    const type = (f.type || 'text').toLowerCase();
    if (!k.type.test(type)) return -1;
    const ac = (f.getAttribute('autocomplete') || '').toLowerCase();
    const words = [f.name, f.id, f.getAttribute('placeholder'), f.getAttribute('aria-label'), fieldLabel(f)].join(' ');
    let s = 1;
    if (k.ac.source !== '^$' && k.ac.test(ac)) s += 6;
    if (k.name.source !== '^$' && k.name.test(words)) s += 4;
    if (kind === 'password' && type === 'password') s += 6;
    if (kind !== 'password' && kind !== 'card_cvc' && kind !== 'one_time_code' && type === 'password') return -1;
    if (kind === 'username' && /pass/i.test(words)) return -1;
    if (hint) { const h = String(hint).toLowerCase(); if (words.toLowerCase().includes(h)) s += 5; }
    if (document.activeElement === f) s += 3;
    if (kind === 'other' && !hint && document.activeElement !== f) s -= 1;
    return s;
  }

  let stampN = 0;
  /** The best field for a kind in this frame: a stamp the server uses to fill it, its label, and a score. */
  function find(kind, hint) {
    let best = null;
    for (const f of document.querySelectorAll('input, textarea')) {
      const s = score(f, kind, hint);
      if (s > 0 && (!best || s > best.s)) best = { f, s };
    }
    if (!best) return null;
    const f = best.f;
    // One-time codes split over boxes of one character each.
    let boxes = [f];
    if (kind === 'one_time_code' && f.maxLength === 1) {
      const scope = f.closest('form') || f.parentElement && f.parentElement.parentElement || document;
      boxes = Array.from(scope.querySelectorAll('input')).filter((x) => x.maxLength === 1 && visible(x) && !x.disabled);
    }
    const stamp = 'g' + Date.now().toString(36) + (++stampN);
    boxes.forEach((b, i) => b.setAttribute('data-cleft-fill', stamp + '-' + i));
    return { stamp, boxes: boxes.length, score: best.s, label: fieldLabel(f), type: f.type, origin: location.origin, top: isTop, focused: document.activeElement === f };
  }

  function box(stamp, i) { return document.querySelector('[data-cleft-fill="' + stamp + '-' + (i || 0) + '"]'); }

  /** Focus a stamped field and empty it, ready for the server to type into. */
  function focus(stamp, i) {
    const f = box(stamp, i);
    if (!f || !f.isConnected) return { ok: false, why: 'field gone' };
    f.focus();
    try { f.select(); } catch (_) {}
    if (f.value) { f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); }
    return { ok: document.activeElement === f, origin: location.origin, why: document.activeElement === f ? '' : 'could not focus' };
  }

  /** Did something land in the field? Never returns the value: only whether its length looks right. */
  function check(stamp, want, i) {
    const f = box(stamp, i);
    if (!f) return { ok: false, why: 'field gone' };
    const len = String(f.value || '').replace(/[\s-]/g, '').length;
    return { ok: len > 0 && (want == null || Math.abs(len - want) <= 3) };
  }

  function unstamp(stamp) { for (const b of document.querySelectorAll('[data-cleft-fill^="' + stamp + '-"]')) b.removeAttribute('data-cleft-fill'); }

  Object.defineProperty(window, '__cleftGuard', { value: Object.freeze({
    read, stateKey, find, focus, check, unstamp, readPost,
    hash: (x) => hash(norm(x)),
    setPublish: (state) => { try { const o = typeof state === 'string' ? JSON.parse(state) : state; pub = { on: !!o.on, dry: !!o.dry, allow: Array.isArray(o.allow) ? o.allow.slice(0, 200).map((a) => ({ h: String(a.h), p: String(a.p || '') })) : [] }; } catch (_) {} return true; },
    arm: (key, ms) => { armed = { key: String(key), until: Date.now() + Math.min(Number(ms) || 0, 300000) }; return true; },
    disarm: () => { armed = null; passing = 0; pubPassing = 0; kindPassing = 0; if (kinds.once) kinds.once = null; return true; },
    setKinds: (state) => { try { const o = typeof state === 'string' ? JSON.parse(state) : state; const once = o.once && typeof o.once === 'object' ? { k: String(o.once.k), s: String(o.once.s), until: Date.now() + Math.min(Number(o.once.ms) || 0, 300000) } : (o.keepOnce ? kinds.once : null); kinds = { control: !!o.control, allow: Array.isArray(o.allow) ? o.allow.slice(0, 200).map((a) => ({ k: String(a.k), s: String(a.s) })) : [], once }; } catch (_) {} return true; },
    armed: () => !!(armed && armed.until > Date.now()),
  }) });
})();`;
