/**
 * The `place_call` tool (docs/calls.md): a bot phones a business for the person. Every call shows a card with
 * the exact number, who it is for, what the bot will say first and what it is after; it runs only when a
 * person presses Allow on that card in the chat (never Always allow, never from a notification). The call
 * itself runs on the call service on this machine (deploy/calls/cleft_calls.py); this waits for it to end
 * and hands the bot the transcript and notes.
 */

export interface CallRequest { to: string; business: string; purpose: string; onBehalfOf: string; maxMinutes: number }
export interface CallRecord {
  id: string; status: string; to: string; transcript: { who: string; text: string }[]; notes: string[];
  answered?: number; ended?: number; error?: string; recording?: string; first_audio_ms?: number[];
}

const SERVICE = () => (process.env.CALLS_SERVICE_URL || 'http://127.0.0.1:8791').replace(/\/$/, '');
export const MAX_MINUTES = 10;

/** US states where every party must agree to a recording (and California's rule reaches callers from elsewhere). */
const ALL_PARTY_AREA_CODES: Record<string, string> = Object.fromEntries(Object.entries({
  California: '209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 837 840 858 909 916 925 949 951',
  Florida: '239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954',
  Washington: '206 253 360 425 509 564',
  Maryland: '227 240 301 410 443 667',
  Massachusetts: '339 351 413 508 617 774 781 857 978',
  'New Hampshire': '603',
  Pennsylvania: '215 223 267 272 412 445 484 570 582 610 717 724 814 835 878',
  Illinois: '217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872',
  Connecticut: '203 475 860 959',
  Montana: '406',
  Nevada: '702 725 775',
}).flatMap(([state, codes]) => codes.split(' ').map((c) => [c, state])));

/** "+19185551234" for a US number, or an error in words. 555, 900/976 and N11 numbers are refused. */
export function usNumber(input: string): { number: string } | { error: string } {
  let d = String(input ?? '').replace(/\D/g, '');
  if (d.length === 10) d = `1${d}`;
  if (d.length !== 11 || d[0] !== '1' || '01'.includes(d[1]) || '01'.includes(d[4])) return { error: 'Only US phone numbers (10 digits) can be called.' };
  if (d.slice(4, 7) === '555' || ['900', '976'].includes(d.slice(1, 4)) || d.slice(2, 4) === '11') return { error: 'That number cannot be called.' };
  return { number: `+${d}` };
}

export const prettyNumber = (n: string) => `(${n.slice(2, 5)}) ${n.slice(5, 8)}-${n.slice(8)}`;
export const allPartyState = (n: string): string | null => ALL_PARTY_AREA_CODES[n.slice(2, 5)] ?? null;

/** The first thing the bot says, and the brief the call brain follows. */
export function callScript(botName: string, r: CallRequest, number: string): { opening: string; brief: string; state: string | null } {
  const state = allPartyState(number);
  const opening = `Hi, this is ${botName}, an AI assistant calling for ${r.onBehalfOf}. This call is recorded.${state ? ' Is that okay with you?' : ''}`;
  const brief = [
    `You are calling ${r.business || 'a business'} for ${r.onBehalfOf}.`,
    `What to find out or do: ${r.purpose}`,
    state ? `This business is in ${state}, where everyone must agree to recording. You already asked; if they say no or do not agree, thank them, say you will have ${r.onBehalfOf} call instead, and end the call. Do not go on until they agree.` : '',
    `Give only ${r.onBehalfOf}'s name when asked for a name. Never give a card, bank or account number, address, birth date or other personal details; never agree to a payment, deposit, fee, contract or anything costing money. If they need any of that, say ${r.onBehalfOf} will call back, then end the call.`,
    'Put what you learned (prices, times, confirmation numbers, names) in "note" as you hear it.',
  ].filter(Boolean).join('\n');
  return { opening, brief, state };
}

async function service(path: string, init: RequestInit = {}): Promise<any> {
  const { callsKey } = await import('./calls.js');
  const res = await fetch(`${SERVICE()}${path}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${callsKey().toString('hex')}`, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body?.detail ?? body?.error ?? `the call service answered ${res.status}`));
  return body;
}

/** Dial, then wait until the call is over (or its time limit plus a minute) and return the record. */
export async function runCall(botRef: string, number: string, opening: string, brief: string, maxMinutes: number, onUpdate?: (status: string) => void): Promise<CallRecord> {
  const { callBot, callsEnabled } = await import('./calls.js');
  if (!callsEnabled()) throw new Error('Calls are turned off on this server.');
  if (!callBot(botRef)) throw new Error('This bot cannot make calls.');
  const started = await service('/calls', { method: 'POST', body: JSON.stringify({ to: number, bot: botRef, brief, opening, max_seconds: Math.round(maxMinutes * 60) }) });
  const id = String(started.id);
  const deadline = Date.now() + (maxMinutes + 1.5) * 60_000;
  let last = '';
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    let rec: CallRecord;
    try { rec = await service(`/calls/${id}`); } catch { if (Date.now() > deadline) throw new Error('Lost track of the call.'); continue; }
    if (rec.status !== last) { last = rec.status; onUpdate?.(rec.status); }
    if (['ended', 'failed'].includes(rec.status) || Date.now() > deadline) return rec;
  }
}

/** What the bot is told when the call is over. */
export function callResultText(rec: CallRecord, business: string): string {
  const secs = rec.answered && rec.ended ? Math.max(0, Math.round(rec.ended - rec.answered)) : 0;
  const lines = (rec.transcript ?? []).map((t) => `${t.who === 'bot' ? 'You' : 'Them'}: ${t.text}`);
  if (rec.status === 'failed') return `The call to ${business} did not go through: ${rec.error ?? 'unknown error'}.`;
  if (!rec.answered) return `Nobody answered at ${business} (or the call could not connect). Nothing was said.`;
  return [
    `Call to ${business} ended after ${Math.floor(secs / 60)} min ${secs % 60} s.`,
    rec.notes?.length ? `Notes you took: ${rec.notes.join(' | ')}` : 'You took no notes.',
    'Transcript:',
    ...lines,
    'Tell the person what you found out, plainly, and anything they still need to do. Do not say you booked or agreed to anything the transcript does not show.',
  ].join('\n');
}
