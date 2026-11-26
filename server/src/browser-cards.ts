import { db, now } from './db.js';
import { appendRow, emitBot, getBotRow, getRow, updateRow } from './store.js';
import type { PurchaseOnCard, SecretOnCard } from './types.js';
import {
  armPurchase, findField, fillField, FIELD_KINDS, PURCHASE_ARM_MS, purchaseKey, readPage, rememberToScrub, type FieldKind,
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
function patchCard(approvalId: string, field: 'secret' | 'purchase', patch: Record<string, unknown>) {
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
    if (meta.approvalId) dropSecret(meta.approvalId);
    return { output: answer === 'deny' ? 'The person chose not to give it. Do not ask again unless they bring it up; tell them what is left to do.' : 'Nobody answered the card in time; nothing was typed.', summary: 'Not given' };
  }
  let value = takeSecret(meta.approvalId);
  if (!value) return { output: 'The value did not arrive; nothing was typed. Ask again.', summary: 'failed' };
  let why2: string | null;
  try { why2 = await fillField(ctx.botId, loc, value); } catch { why2 = 'The browser stopped answering while typing. Check the page and ask again if needed.'; }
  if (!why2) rememberToScrub(ctx.botId, value);
  value = '';
  patchCard(meta.approvalId, 'secret', { result: { ok: !why2, detail: why2 ?? 'Filled', at: now() } });
  if (why2) return { output: `Not filled: ${why2}`, summary: 'failed' };
  return {
    output: `Filled the ${secret.kindLabel.toLowerCase()} field ("${loc.label}") on ${loc.origin}. You were not given the value and must not ask for it or try to read it back. Go on (press the page's sign-in or next button yourself).`,
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
