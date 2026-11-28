import { db, now } from './db.js';
import { appendRow, emitBot, getBotRow, getRow, updateRow } from './store.js';
import type { PurchaseOnCard, SecretOnCard, VaultOnCard } from './types.js';
import {
  botView, loginForUse, loginsForBot, noteUse, openLogin, originRefusal, ownerOfLogin, personOfBot,
  saveFromCard, siteMatches, siteOf, takeSaveAsk,
} from './vault.js';
import { browserKindKey, browserKindLabel, KIND_NAME, KIND_SAYS } from './action-kinds.js';
import {
  armKindOnce, armPurchase, findField, KIND_ONCE_MS, lastHeldKind, fillField, FIELD_KINDS, PURCHASE_ARM_MS, purchaseKey, readPage, rememberToScrub, type FieldKind,
} from './browser-guard.js';

/**
 * Browser cards (docs/browser-cards.md), Muse-style: the bot's browser work asks the person on a card in the
 * chat instead of failing or asking in plain text.
 *
 *  - ask_secure_input: a password, username, one-time code or card detail. The person types it into a masked
 *    box on the card; the app sends it to /api/approvals/:id/secret; the guard types it into the exact field
 *    after re-checking the page's origin. The bot hears only "filled" or why not.
 *  - request_purchase_approval: before anything is paid, a card with the total, card, merchant, items,
 *    shipping and whether it recurs, all read from the page by the server. Approve arms the page's guard for
 *    one purchase at that exact total for 3 minutes.
 *  - ask_for_help_on_screen: a CAPTCHA, passkey or app approval the person does on the bot's screen.
 *
 * None of these cards has "Always allow" or can be answered from a notification (agent/loop.ts resolveApproval).
 */

// ------------------------------------------------------------------ the value hand-off

/** A value typed on a secure input card, waiting for its tool to pick it up. Held for seconds, in memory only. */
const handoff = new Map<string, string>();

/** routes.ts: the person's value for a card, set just before the card is resolved as allowed. */
export function handSecret(approvalId: string, value: string) { handoff.set(approvalId, value); setTimeout(() => handoff.delete(approvalId), 30_000).unref?.(); }
export function dropSecret(approvalId: string) { handoff.delete(approvalId); }
function takeSecret(approvalId: string): string | null { const v = handoff.get(approvalId) ?? null; handoff.delete(approvalId); return v; }
/** drive-pull.ts: a secure card that is not for a page (a key for this server). Taken once. */
export const takeHandedSecret = takeSecret;

/** Change the extra part of a browser card after it was answered (the fill result, the purchase result). */
function patchCard(approvalId: string, field: 'secret' | 'purchase' | 'vault', patch: Record<string, unknown>) {
  const ap = db.prepare('SELECT bot_id, row_seq FROM approvals WHERE id=?').get(approvalId) as { bot_id: string; row_seq: number } | undefined;
  if (!ap) return;
  const row = getRow(ap.bot_id, ap.row_seq);
  if (!row || row.body.type !== 'card' || row.body.card !== 'approval') return;
  const cur = (row.body as any)[field] ?? {};
  updateRow(ap.bot_id, ap.row_seq, { ...row.body, [field]: { ...cur, ...patch } } as any);
  emitBot(ap.bot_id);
}

const host = (origin: string) => { try { return new URL(origin).host; } catch { return origin; } };

// ------------------------------------------------------------------ secure input

const KIND_LABEL: Record<FieldKind, string> = {
  service_key: 'Service account key (JSON)',
  password: 'Password', username: 'Username', email: 'Email address', one_time_code: 'One-time code', card_number: 'Card number',
  card_expiry: 'Card expiry date', card_cvc: 'Card security code (CVC)', other: 'Text',
};

export interface Ctx { userId: string; botId: string; chatId?: string }
type Out = { output: string; summary?: string };

export async function askSecureInput(a: any, ctx: Ctx): Promise<Out> {
  const kind = (FIELD_KINDS.includes(a?.field) ? a.field : 'other') as FieldKind;
  const hint = String(a?.field_label ?? '').trim().slice(0, 60);
  const why = String(a?.why ?? '').trim().slice(0, 200);
  const loc = await findField(ctx.botId, kind, hint);
  if ('error' in loc) return { output: loc.error, summary: 'failed' };
  const secret: SecretOnCard = {
    kind, kindLabel: KIND_LABEL[kind], origin: loc.topOrigin, site: host(loc.topOrigin),
    ...(loc.origin && loc.origin !== loc.topOrigin ? { frameOrigin: loc.origin } : {}),
    fieldLabel: loc.label || KIND_LABEL[kind], why,
    masked: kind !== 'username' && kind !== 'email' && kind !== 'card_expiry',
    numeric: kind === 'one_time_code' || kind === 'card_number' || kind === 'card_cvc',
    // "Save to my logins" (vault.ts): sign-in fields on a page the vault would fill, for bots that use it.
    ...((kind === 'password' || kind === 'username' || kind === 'email') && siteOf(loc.topOrigin) && !originRefusal(loc.topOrigin) && personOfBot(ctx.botId) !== null ? { canSave: true } : {}),
  };
  const bot = getBotRow(ctx.botId);
  const { requestApproval } = await import('./agent/loop.js');
  const meta: { approvalId?: string } = {};
  const answer = await requestApproval(
    { userId: ctx.userId, botId: ctx.chatId ?? ctx.botId },
    {
      decision: 'ask', key: 'secure_input', title: `secure_input: ${secret.kindLabel} for ${secret.site}`, asks: [], detail: '',
      browser: { title: `${bot?.name ?? 'The bot'} needs your ${secret.kindLabel.toLowerCase()} for ${secret.site}`, secret },
    },
    // What the card is bound to (its digest): never the value.
    { field: kind, origin: loc.topOrigin, frame: loc.origin, label: loc.label, page: loc.pageUrl },
    null, meta,
  );
  if (answer !== 'allow' || !meta.approvalId) {
    if (meta.approvalId) { dropSecret(meta.approvalId); takeSaveAsk(meta.approvalId); }
    return { output: answer === 'deny' ? 'The person chose not to give it. Do not ask again unless they bring it up; tell them what is left to do.' : 'Nobody answered the card in time; nothing was typed.', summary: 'Not given' };
  }
  let value = takeSecret(meta.approvalId);
  const saveFor = takeSaveAsk(meta.approvalId);
  if (!value) return { output: 'The value did not arrive; nothing was typed. Ask again.', summary: 'failed' };
  let why2: string | null;
  try { why2 = await fillField(ctx.botId, loc, value); } catch { why2 = 'The browser stopped answering while typing. Check the page and ask again if needed.'; }
  if (!why2) rememberToScrub(ctx.botId, value);
  // Saved only once it went into the page, and only for the person who typed it (their own logins).
  let saved = false;
  if (!why2 && saveFor !== undefined && secret.canSave) {
    try { saved = saveFromCard(ctx.userId, saveFor, loc.topOrigin, kind, value) === 'saved'; } catch { saved = false; }
  }
  value = '';
  patchCard(meta.approvalId, 'secret', { result: { ok: !why2, detail: why2 ?? (saved ? 'Filled and saved to your logins' : 'Filled'), at: now(), ...(saved ? { saved: true } : {}) } });
  if (why2) return { output: `Not filled: ${why2}`, summary: 'failed' };
  return {
    output: `Filled the ${secret.kindLabel.toLowerCase()} field ("${loc.label}") on ${loc.origin}. You were not given the value and must not ask for it or try to read it back. Go on (press the page's sign-in or next button yourself).`,
    summary: 'Filled',
  };
}

// ------------------------------------------------------------------ saved logins (vault.ts)

/** list_saved_logins: what the bot may ask to use. Sites and labels only; never a username or a value. */
export async function listSavedLogins(_a: any, ctx: Ctx): Promise<Out> {
  if (personOfBot(ctx.botId) === null) return { output: 'Saved logins are not available to you. Use ask_secure_input.', summary: 'None' };
  const all = loginsForBot(ctx.userId, ctx.botId).map(botView);
  if (!all.length) return { output: 'No saved logins are shared with you. Use ask_secure_input; the person can tick "Save to my logins" on that card.', summary: 'None' };
  return { output: JSON.stringify({ logins: all, how: 'Open the site\'s sign-in page, then call use_saved_login (with login when the site has more than one). You never get the values.' }), summary: `${all.length} saved` };
}

const pageHost = (origin: string) => { try { return new URL(origin).hostname; } catch { return ''; } };

/**
 * use_saved_login: a card for the login's owner names the page's real site (read from the browser) and the
 * saved login; Sign in types the saved username and password into the page's own fields. The bot hears only
 * which fields were filled. No "Always allow": every use is a card.
 */
export async function useSavedLogin(a: any, ctx: Ctx): Promise<Out> {
  if (personOfBot(ctx.botId) === null) return { output: 'Saved logins are not available to you. Use ask_secure_input.', summary: 'failed' };
  const why = String(a?.why ?? '').trim().slice(0, 200);
  // The page, read from the browser: never what the bot or the page says it is.
  const pass = await findField(ctx.botId, 'password', '');
  let user = await findField(ctx.botId, 'username', '');
  if ('error' in user) user = await findField(ctx.botId, 'email', '');
  const anyLoc = !('error' in pass) ? pass : !('error' in user) ? user : null;
  if (!anyLoc) return { output: `No sign-in field (username, email or password) is showing. Open the site's sign-in page first. (${'error' in pass ? pass.error : ''})`, summary: 'failed' };
  const origin = anyLoc.topOrigin;
  const refusal = originRefusal(origin);
  if (refusal) return { output: refusal, summary: 'failed' };
  const host = pageHost(origin);
  const usable = loginsForBot(ctx.userId, ctx.botId).filter((r) => siteMatches(r.site, host));
  const wanted = String(a?.login ?? '').trim();
  let row = wanted ? loginForUse(ctx.userId, ctx.botId, wanted) : null;
  if (wanted && (!row || !siteMatches(row.site, host))) {
    return { output: `That saved login is not for ${host}${usable.length ? `. Logins for this site: ${JSON.stringify(usable.map(botView))}` : ', and none is saved for it. Use ask_secure_input'}.`, summary: 'failed' };
  }
  if (!row) {
    if (!usable.length) return { output: `No saved login for ${host} is shared with you. Use ask_secure_input; the person can tick "Save to my logins" on that card so next time you can use this.`, summary: 'None' };
    if (usable.length > 1) return { output: `More than one saved login fits ${host}. Call use_saved_login again with one of these as login (ask the person which if you don't know): ${JSON.stringify(usable.map(botView))}`, summary: 'Pick one' };
    row = usable[0];
  }
  // Every field it will type into must be on the same site (a login form in another site's frame is refused).
  const uLoc = !('error' in user) && row.has_user ? user : null;
  const pLoc = !('error' in pass) && row.has_pass ? pass : null;
  for (const l of [uLoc, pLoc]) {
    if (l && l.origin !== l.topOrigin && !siteMatches(row.site, pageHost(l.origin))) return { output: `The sign-in field is in a frame from ${l.origin}, not ${row.site}. Nothing was asked; use ask_secure_input.`, summary: 'failed' };
  }
  if (!uLoc && !pLoc) {
    return { output: `The saved login for ${row.site} has ${row.has_user ? 'a username' : 'a password'} only, and that field is not on this page. Go to the step that asks for it, or use ask_secure_input.`, summary: 'failed' };
  }
  const owner = ownerOfLogin(row);
  const fields = [...(uLoc ? ['username' as const] : []), ...(pLoc ? ['password' as const] : [])];
  const frame = (pLoc ?? uLoc)!.origin;
  const vault: VaultOnCard = {
    origin, site: host, ...(frame && frame !== origin ? { frameOrigin: frame } : {}),
    login: row.id, savedSite: row.site, label: row.label || row.site, userHint: row.user_hint, fields,
    fieldLabels: [uLoc?.label, pLoc?.label].filter((x): x is string => !!x),
    owner: owner.name, forScoped: !!owner.person, connectorFirst: !!row.connector_first, why,
  };
  const bot = getBotRow(ctx.botId);
  const { requestApproval } = await import('./agent/loop.js');
  const meta: { approvalId?: string } = {};
  const what = fields.length === 2 ? 'username and password' : fields[0];
  const answer = await requestApproval(
    { userId: ctx.userId, botId: ctx.chatId ?? ctx.botId },
    {
      decision: 'ask', key: 'saved_login', title: `saved_login: ${row.site} for ${host}`, asks: [], detail: '',
      browser: { title: `${bot?.name ?? 'The bot'} wants to sign in to ${host} with ${owner.name}'s saved login`, vault },
    },
    // What the card is bound to (its digest): the login, the page and its fields. Never a value.
    { login: row.id, origin, fields, frame, user: uLoc?.label ?? '', pass: pLoc?.label ?? '', page: anyLoc.pageUrl },
    null, meta,
  );
  if (answer !== 'allow' || !meta.approvalId) {
    return { output: answer === 'deny' ? 'The person chose not to sign in with the saved login. Do not ask again unless they bring it up; tell them what is left to do.' : 'Nobody answered the card in time; nothing was typed.', summary: 'Not used' };
  }
  let s: { u?: string; p?: string };
  try { s = openLogin(row); } catch { patchCard(meta.approvalId, 'vault', { result: { ok: false, detail: 'The saved login could not be opened', at: now() } }); return { output: 'The saved login could not be opened on the server. Use ask_secure_input.', summary: 'failed' }; }
  let problem: string | null = null;
  const filled: string[] = [];
  try {
    if (uLoc && s.u) { problem = await fillField(ctx.botId, uLoc, s.u); if (!problem) { filled.push('username'); rememberToScrub(ctx.botId, s.u); } }
    if (!problem && pLoc && s.p) { problem = await fillField(ctx.botId, pLoc, s.p); if (!problem) { filled.push('password'); rememberToScrub(ctx.botId, s.p); } }
  } catch { problem = 'The browser stopped answering while typing. Check the page and ask again if needed.'; }
  s = {};
  if (filled.length) noteUse(row.id);
  patchCard(meta.approvalId, 'vault', { result: { ok: !problem, detail: problem ?? `Filled the ${filled.join(' and ')}`, at: now() } });
  if (problem) return { output: `${filled.length ? `Filled the ${filled.join(' and ')}, then stopped: ` : 'Not filled: '}${problem}`, summary: 'failed' };
  return {
    output: `Filled the ${filled.join(' and ')} on ${origin} from the saved login "${row.label || row.site}". You were not given the values and must not read them back or ask for them. Press the page's sign-in or next button yourself.${!pLoc && row.has_pass ? ' If the next step asks for the password, call use_saved_login again there.' : ''}${row.connector_first ? ' This is a mail, calendar or money site: if you came here because a connected app failed, stop and tell the person instead.' : ''}`,
    summary: 'Filled',
  };
}

// ------------------------------------------------------------------ purchase approval

const num = (s: string) => { const n = Number(String(s ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : NaN; };

export async function requestPurchase(a: any, ctx: Ctx): Promise<Out> {
  const page = await readPage(ctx.botId);
  if (!page) return { output: 'No checkout page is open in your browser (or it is still loading). Open the final checkout step, then ask again.', summary: 'failed' };
  const botSays = {
    amount: String(a?.amount ?? '').slice(0, 20), currency: String(a?.currency ?? '').toUpperCase().slice(0, 6),
    merchant: String(a?.merchant ?? '').slice(0, 80), items: (Array.isArray(a?.items) ? a.items : []).map((x: unknown) => String(x).slice(0, 120)).slice(0, 10),
    paymentMethod: String(a?.payment_method ?? '').slice(0, 60), recurring: !!a?.recurring, why: String(a?.why ?? '').slice(0, 300),
  };
  const warnings: string[] = [];
  if (!page.total) warnings.push('The total could not be read from the page. Check the bot\'s screen before approving.');
  if (page.total && botSays.amount && Math.abs(num(page.total.amount) - num(botSays.amount)) > 0.005) warnings.push(`The bot says ${botSays.amount}${botSays.currency ? ` ${botSays.currency}` : ''}, but the page shows ${page.total.text}.`);
  if (page.total && botSays.currency && page.total.currency !== botSays.currency) warnings.push(`The page's currency is ${page.total.currency}, not ${botSays.currency}.`);
  if (page.recurring || botSays.recurring) warnings.push(`This may be a recurring charge (${page.recurring || 'the bot says so'}).`);
  if (!page.card) warnings.push('No saved card or wallet was read from the page.');
  if (!page.controls.length && !page.cardFields && !page.processors.length) warnings.push('No pay button was found on this page; it may not be the final step.');
  const purchase: PurchaseOnCard = {
    page: {
      origin: page.origin, site: page.site || host(page.origin), title: page.title, url: page.url,
      total: page.total ? { amount: page.total.amount, currency: page.total.currency, text: page.total.text } : null,
      card: page.card, items: page.items, shipping: page.shipping, shipTo: page.shipTo, recurring: page.recurring,
      controls: page.controls.slice(0, 4), processors: page.processors,
    },
    botSays, warnings,
  };
  const key = purchaseKey(page);
  const bot = getBotRow(ctx.botId);
  const { requestApproval } = await import('./agent/loop.js');
  const meta: { approvalId?: string } = {};
  const answer = await requestApproval(
    { userId: ctx.userId, botId: ctx.chatId ?? ctx.botId },
    {
      decision: 'ask', key: 'purchase', title: `purchase: ${page.total?.text ?? 'a purchase'} on ${host(page.origin)}`, asks: [], detail: '',
      browser: { title: `${bot?.name ?? 'The bot'} wants to pay ${page.total?.text ?? '(amount not read)'} on ${host(page.origin)}`, purchase },
    },
    { key, page: purchase.page, botSays },
    null, meta,
  );
  if (answer !== 'allow' || !meta.approvalId) {
    return { output: answer === 'deny' ? 'The person did not approve this purchase. Do not buy it; tell them, and ask what they want instead.' : 'Nobody answered the purchase card in time; nothing was bought.', summary: 'Not approved' };
  }
  const why = await armPurchase(ctx.botId, meta.approvalId, key).catch((e) => String(e?.message ?? e));
  patchCard(meta.approvalId, 'purchase', { result: { ok: !why, detail: why ?? `Approved for ${Math.round(PURCHASE_ARM_MS / 60000)} minutes`, at: now() } });
  if (why) return { output: `Approved, but not armed: ${why} Nothing was bought. Call request_purchase_approval again so the person sees the current checkout.`, summary: 'Changed' };
  return {
    output: `Approved: ${page.total?.text ?? 'the purchase'} on ${page.origin}${page.card?.last4 ? ` with the card ending ${page.card.last4}` : ''}. Within 3 minutes, click the page's pay / place-order button once. If the total, card or site changes, the click is held and you must ask again. Afterwards, read the confirmation and tell the person the order number.`,
    summary: 'Approved',
  };
}

// ------------------------------------------------------------------ kinds of action held in the page

/**
 * request_action_approval: after the guard held a press that deletes, sends, shares or posts (action-kinds.ts),
 * a card for exactly that press: the kind, the button's label and the site, read by the guard, and the bot's
 * one line. Allow once arms the next press of that kind on that site for two minutes; Allow for this
 * conversation and Always allow let that kind through on that site from now on (conversation-allows.ts,
 * allow-rules.ts, key browser_kind__<kind>__<site>). A password or security change is handed to the person:
 * "I did it myself" or "Don't do it"; the bot never presses it.
 */
export async function requestActionApproval(a: any, ctx: Ctx): Promise<Out> {
  const held = lastHeldKind(ctx.botId);
  if (!held || !held.action || !held.site) return { output: 'No press is being held in your browser, so there is nothing to ask about. Press the button first; if the guard holds it, call this again.', summary: 'failed' };
  const kind = held.action;
  const site = held.site;
  const label = held.label ?? KIND_NAME[kind];
  const what = String(a?.what ?? '').trim().slice(0, 300);
  const why = String(a?.why ?? '').trim().slice(0, 200);
  const bot = getBotRow(ctx.botId);
  const name = bot?.name ?? 'The bot';
  const { requestApproval } = await import('./agent/loop.js');
  const meta: { approvalId?: string } = {};
  const key = browserKindKey(kind, site);
  const args = { kind, site, button: label, ...(what ? { what } : {}), ...(why ? { why } : {}) };
  if (kind === 'credentials') {
    const answer = await requestApproval(
      { userId: ctx.userId, botId: ctx.chatId ?? ctx.botId },
      {
        decision: 'ask', key, asks: [], title: `Browser: ${label} on ${site}`, kind, handoff: true,
        cardTitle: `Changing a password or security setting on ${site} is yours to do`,
        detail: `${name} reached "${label}" on ${site} and stopped. Only you have this, so ${name} won't press it. Open ${name}'s screen, take control and do it yourself, or tell ${name} not to.${what ? `\n\n${name} says: ${what}` : ''}`,
      },
      args, null, meta,
    );
    return answer === 'allow'
      ? { output: `The person says they did it themselves on ${site}. Do not press it again. Look at the page (page_info or a screenshot) and carry on.`, summary: 'Done by you' }
      : { output: answer === 'deny' ? 'The person said not to do it. Do not change it; tell them what is left.' : 'Nobody answered the card in time; nothing was changed.', summary: 'Not done' };
  }
  const answer = await requestApproval(
    { userId: ctx.userId, botId: ctx.chatId ?? ctx.botId },
    {
      decision: 'ask', key, asks: [key], kind, title: `Browser: press "${label}" on ${site}`, ruleLabel: browserKindLabel(kind, site),
      detail: `${KIND_SAYS[kind]}${what ? `\n\n${name} says: ${what}` : ''}${why ? `\nWhy: ${why}` : ''}`,
    },
    args, null, meta,
  );
  if (answer !== 'allow' || !meta.approvalId) {
    return { output: answer === 'deny' ? `The person did not allow "${label}" on ${site}. Do not press it or try another way; tell them, and ask what they want instead.` : 'Nobody answered the card in time; nothing was pressed.', summary: 'Not allowed' };
  }
  const status = (db.prepare('SELECT status FROM approvals WHERE id=?').get(meta.approvalId) as { status?: string } | undefined)?.status;
  const chat = ctx.chatId ?? ctx.botId;
  const { refreshKindState } = await import('./browser-guard.js');
  if (status === 'allowed') await armKindOnce(ctx.botId, kind, site, chat).catch(() => undefined);
  else await refreshKindState(ctx.botId, chat, true).catch(() => undefined);
  const standing = status === 'always' ? ' from now on' : status === 'conversation' ? ' for the rest of this conversation' : '';
  return {
    output: standing
      ? `Allowed${standing}: "${KIND_NAME[kind]}" presses on ${site}. Press "${label}" again now.`
      : `Allowed once. Within ${Math.round(KIND_ONCE_MS / 60000)} minutes, press "${label}" on ${site} again, once. Afterwards check the page shows it done and tell the person.`,
    summary: 'Allowed',
  };
}

// ------------------------------------------------------------------ needs you on the screen

const REASON: Record<string, string> = {
  captcha: 'solve a CAPTCHA', passkey: 'use a passkey or security key', app_approval: 'approve a sign-in in an app on your phone',
  login: 'sign in', other: 'do a step',
};

export async function askHelpOnScreen(a: any, ctx: Ctx): Promise<Out> {
  const reason = REASON[a?.reason] ? String(a.reason) : 'other';
  const note = String(a?.note ?? '').trim().slice(0, 300);
  const page = await readPage(ctx.botId).catch(() => null);
  const site = page ? host(page.origin) : '';
  const bot = getBotRow(ctx.botId);
  const { requestApproval } = await import('./agent/loop.js');
  const answer = await requestApproval(
    { userId: ctx.userId, botId: ctx.chatId ?? ctx.botId },
    {
      decision: 'ask', key: 'screen_help', title: `screen_help: ${REASON[reason]}`, asks: [], detail: '',
      browser: { title: `${bot?.name ?? 'The bot'} needs you to ${REASON[reason]}${site ? ` on ${site}` : ''}`, screenHelp: { reason, site, note } },
    },
    { reason, site, note }, null,
  );
  if (answer !== 'allow') return { output: answer === 'deny' ? 'The person skipped it. Stop this part and tell them what is left.' : 'Nobody answered the card in time.', summary: 'Skipped' };
  return { output: 'The person says it is done. Look at the page again (page_info or a screenshot) and carry on.', summary: 'Done' };
}

/** A notice in the chat that never carries a value (used by tests and the gate). */
export function browserNotice(chatId: string, text: string) { appendRow(chatId, 'notice', { type: 'notice', text, tone: 'info' }); emitBot(chatId); }
