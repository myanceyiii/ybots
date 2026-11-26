'use strict';
// "Who needs you": the chats with something unread or a bot waiting on an answer, worked out from what
// the server already tells the signed-in app (GET /api/bots). The tray icon, its menu, the taskbar
// badge and the tooltip are all drawn from this. Free of Electron, so it can be tested.
//
// It only reads. Nothing here (or anywhere in the shell) can answer an approval: clicking a bot in the
// tray menu opens its chat, where the card is.

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/** The count the web app puts in its title: "(3) YBots" is 3, "YBots" is 0. */
function countFromTitle(title) {
  const m = /^\((\d{1,4})\)\s/.exec(String(title ?? ''));
  return m ? Number(m[1]) : 0;
}

/**
 * @param body  what GET /api/bots answered: { bots: [...], live: [...] }
 * @returns { total, waiting, bots: [{ id, name, state: 'waiting'|'unread', unread }] }, most urgent first
 */
function summarize(body) {
  const bots = Array.isArray(body?.bots) ? body.bots : [];
  const live = new Map((Array.isArray(body?.live) ? body.live : []).filter((l) => l && typeof l.botId === 'string').map((l) => [l.botId, l]));
  const out = [];
  for (const b of bots) {
    if (!b || typeof b.id !== 'string' || !ID.test(b.id)) continue;
    // A bot hidden from the list (Alex hid a bot) never counts, as in the web app's list and title.
    if (b.ownerHidden) continue;
    const l = live.get(b.id);
    const waiting = !!l?.awaiting || (Array.isArray(l?.members) && l.members.some((m) => m?.state === 'waiting'));
    const unread = Number.isFinite(b.unread) && b.unread > 0 ? Math.min(999, Math.floor(b.unread)) : 0;
    if (!waiting && !unread) continue;
    out.push({
      id: b.id,
      name: String(b.name ?? 'Bot').replace(/[\r\n\t]+/g, ' ').slice(0, 60) || 'Bot',
      state: waiting ? 'waiting' : 'unread',
      unread,
      at: Number.isFinite(b.lastActivityAt) ? b.lastActivityAt : 0,
    });
  }
  out.sort((a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting') || b.at - a.at);
  return { total: out.length, waiting: out.filter((b) => b.state === 'waiting').length, bots: out.slice(0, 12).map(({ at, ...b }) => b) };
}

const EMPTY = Object.freeze({ total: 0, waiting: 0, bots: [] });

/** The line for one bot in the tray menu. */
function botLine(b) {
  if (b.state === 'waiting') return `${b.name} is waiting for you`;
  return `${b.name}: ${b.unread === 1 ? '1 new message' : `${b.unread} new messages`}`;
}

/** The tray icon's tooltip. `count` is the title's count, used until the per-bot list has loaded. */
function tooltip(att, count = att.total) {
  const n = Math.max(att.total, count);
  if (!n) return 'YBots';
  if (att.waiting === 1 && n === 1) return `YBots: ${att.bots[0].name} is waiting for you`;
  if (att.waiting) return `YBots: ${att.waiting === 1 ? '1 bot is' : `${att.waiting} bots are`} waiting for you`;
  return `YBots: ${n === 1 ? '1 chat has' : `${n} chats have`} something new`;
}

module.exports = { countFromTitle, summarize, botLine, tooltip, EMPTY };
