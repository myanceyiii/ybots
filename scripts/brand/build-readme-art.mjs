#!/usr/bin/env node
/**
 * Draws the README and docs art in the "Signal" design language (assets/brand/README.md):
 *   assets/readme/banner-{light,dark}.svg        README banner
 *   assets/readme/app-{light,dark}.svg           illustration of the app with sample data (bot "Robin")
 *   assets/readme/architecture-{light,dark}.svg  how it fits together
 *   assets/readme/approvals-{light,dark}.svg     how an approval card works
 *   assets/readme/divider.svg                    section divider
 *   assets/readme/social-preview.png (+ .svg)    1280x640 image for the repository's social preview
 *
 * All text is turned into outlines, because GitHub shows SVGs as images and they cannot load fonts.
 * Fonts (SIL Open Font License 1.1): Space Grotesk, Inter, JetBrains Mono, via @fontsource.
 * Dev-time only; the outputs are committed. To run it:
 *   npm i --no-save opentype.js@1.3.4 @fontsource/space-grotesk @fontsource/inter @fontsource/jetbrains-mono
 *   node scripts/brand/build-readme-art.mjs
 * (needs Playwright's Chromium for the PNG)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const opentype = require('opentype.js');
const font = (pkg, w) => { const b = fs.readFileSync(require.resolve(`@fontsource/${pkg}/files/${pkg}-latin-${w}-normal.woff`)); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const F = {
  head: font('space-grotesk', 700), headM: font('space-grotesk', 500),
  body: font('inter', 400), bodyM: font('inter', 500), bodyB: font('inter', 600),
  mono: font('jetbrains-mono', 400), monoB: font('jetbrains-mono', 600),
};

// ---- Palette -------------------------------------------------------------------------------------
const THEMES = {
  dark: { bg: '#0E1116', surf: '#161B22', raise: '#1C232D', line: '#2A313C', text: '#E8ECF1', mute: '#8B95A3',
    acc: '#C6F432', accText: '#C6F432', onAcc: '#0E1116', sky: '#5CC8FF', coral: '#FF7A59', mark: '#E8ECF1' },
  light: { bg: '#F6F7F9', surf: '#FFFFFF', raise: '#EEF1F5', line: '#DCE1E8', text: '#0E1116', mute: '#5A6472',
    acc: '#C6F432', accText: '#4D6600', onAcc: '#0E1116', sky: '#1F8FD6', coral: '#E4572E', mark: '#0E1116' },
};

// ---- Helpers -------------------------------------------------------------------------------------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
/** Text as an outlined path. anchor: start | middle | end. ls: letter spacing in em. */
function T(str, { f = F.body, size = 16, x = 0, y = 0, fill = '#000', anchor = 'start', ls = 0 } = {}) {
  const opts = { letterSpacing: ls, kerning: true };
  const w = f.getAdvanceWidth(str, size, opts);
  const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  const d = f.getPath(str, x0, y, size, opts).toPathData(2);
  return `<path d="${d}" fill="${fill}"/>`;
}
const width = (str, f, size, ls = 0) => f.getAdvanceWidth(str, size, { letterSpacing: ls, kerning: true });
const svgDoc = (w, h, title, desc, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t d"><title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>\n${body}\n</svg>\n`;
/** The mark: a Y drawn as three agents joined at one point. Box s x s at (x, y). */
const mark = (x, y, s, c) => `<g transform="translate(${x} ${y}) scale(${s / 100})"><path d="M27 26 L50 52 L73 26 M50 52 L50 76" stroke="${c.mark}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="27" cy="26" r="11" fill="${c.acc}"/><circle cx="73" cy="26" r="11" fill="${c.mark}"/><circle cx="50" cy="77" r="11" fill="${c.mark}"/><circle cx="50" cy="52" r="4.5" fill="${c.bg}"/></g>`;
const box = (x, y, w, h, c, { r = 12, fill = c.surf, stroke = c.line, sw = 1.5, dash = '' } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const arrowDefs = (c) => `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 1 L9 5 L0 9z" fill="${c.mute}"/></marker><marker id="ahA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 1 L9 5 L0 9z" fill="${c.accText}"/></marker></defs>`;
const line = (d, c, { acc = false, dash = '' } = {}) =>
  `<path d="${d}" fill="none" stroke="${acc ? c.accText : c.mute}" stroke-width="1.8"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#${acc ? 'ahA' : 'ah'})"/>`;
const avatar = (cx, cy, r, letter, fill, c) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>${T(letter, { f: F.head, size: r * 1.05, x: cx, y: cy + r * 0.37, fill: c.onAcc, anchor: 'middle' })}`;
const write = (p, data) => { const f = path.join(root, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); console.log('wrote', p); };

/** A small graph of agents, used on the banner and the social preview. */
function graph(c, ox, oy, k) {
  const N = [[0, 40], [120, 0], [210, 90], [90, 150], [250, 200], [10, 210], [180, 280]];
  const E = [[0, 1], [1, 2], [1, 3], [3, 2], [2, 4], [3, 5], [3, 6], [4, 6]];
  const P = N.map(([x, y]) => [ox + x * k, oy + y * k]);
  let s = E.map(([a, b]) => `<path d="M${P[a][0]} ${P[a][1]} L${P[b][0]} ${P[b][1]}" stroke="${c.line}" stroke-width="${2.2 * k}"/>`).join('');
  s += P.map(([x, y], i) => i === 3
    ? `<circle cx="${x}" cy="${y}" r="${26 * k}" fill="${c.acc}"/>${T('R', { f: F.head, size: 28 * k, x, y: y + 10 * k, fill: c.onAcc, anchor: 'middle' })}`
    : `<circle cx="${x}" cy="${y}" r="${(i % 2 ? 11 : 15) * k}" fill="${c.surf}" stroke="${c.mute}" stroke-width="${2 * k}"/>`).join('');
  const [rx, ry] = P[3];
  s += box(rx + 36 * k, ry - 16 * k, 134 * k, 32 * k, c, { r: 16 * k, fill: c.surf });
  s += T('Robin · working', { f: F.mono, size: 13 * k, x: rx + 103 * k, y: ry + 5 * k, fill: c.text, anchor: 'middle' });
  return s;
}

// ---- Banner (1280 x 400) -------------------------------------------------------------------------
function banner(c, mode) {
  let s = `<rect width="1280" height="400" rx="24" fill="${c.bg}"/><rect x=".75" y=".75" width="1278.5" height="398.5" rx="23.25" fill="none" stroke="${c.line}" stroke-width="1.5"/>`;
  s += mark(64, 70, 76, c);
  s += T('YBots', { f: F.head, size: 112, x: 60, y: 252, fill: c.text, ls: -0.03 });
  s += T('Your team of AI agents, on your own machine.', { f: F.body, size: 30, x: 64, y: 304, fill: c.mute });
  s += T('SELF-HOSTED  ·  MIT  ·  WEB  ·  ANDROID  ·  WINDOWS', { f: F.monoB, size: 14, x: 64, y: 350, fill: c.accText, ls: 0.08 });
  s += graph(c, 880, 52, 1.0);
  return svgDoc(1280, 400, 'YBots', `Your team of AI agents, on your own machine. The YBots mark and a small graph of connected agents, one of them the sample bot Robin (${mode}).`, s);
}

// ---- Social preview (1280 x 640, content inside a 40 px safe border) ------------------------------
function social(c) {
  let s = `<rect width="1280" height="640" fill="${c.bg}"/>`;
  s += mark(80, 92, 96, c);
  s += T('YBots', { f: F.head, size: 150, x: 72, y: 360, fill: c.text, ls: -0.03 });
  s += T('A self-hosted team of AI agents.', { f: F.body, size: 36, x: 80, y: 432, fill: c.text });
  s += T('Their own screens. Your OK on every action.', { f: F.body, size: 36, x: 80, y: 480, fill: c.mute });
  s += T('github.com/myanceyiii/ybots', { f: F.mono, size: 22, x: 80, y: 560, fill: c.accText });
  s += graph(c, 860, 150, 1.25);
  return svgDoc(1280, 640, 'YBots', 'Social preview: the YBots mark, name and tagline beside a graph of connected agents.', s);
}

// ---- Architecture (1200 x 560) -------------------------------------------------------------------
function architecture(c, mode) {
  let s = `<rect width="1200" height="560" rx="20" fill="${c.bg}"/>` + arrowDefs(c);
  const label = (str, x, y, a = 'start', fill = c.mute) => T(str, { f: F.mono, size: 12, x, y, fill, anchor: a, ls: 0.06 });
  const node = (x, y, w, h, title, sub, opts = {}) => box(x, y, w, h, c, opts)
    + T(title, { f: F.bodyB, size: 17, x: x + w / 2, y: y + (sub ? h / 2 - 2 : h / 2 + 6), fill: c.text, anchor: 'middle' })
    + (sub ? T(sub, { f: F.mono, size: 12, x: x + w / 2, y: y + h / 2 + 20, fill: c.mute, anchor: 'middle' }) : '');
  s += label('YOUR DEVICES', 40, 120);
  ['Web app', 'Android app', 'Windows app'].forEach((t, i) => { s += node(40, 136 + i * 76, 190, 56, t); });
  s += box(290, 60, 700, 460, c, { r: 18, fill: 'none', stroke: c.mute, dash: '6 6' });
  s += label('YOUR LINUX MACHINE', 314, 92);
  s += node(330, 226, 260, 100, 'YBots server', 'Node · Hono · SQLite', { fill: c.surf, stroke: c.accText, sw: 2.5 });
  s += node(700, 120, 260, 84, 'Hermes gateway', 'one per bot, e.g. Robin');
  s += node(330, 420, 190, 72, 'Virtual screens', 'Xvfb · Chrome');
  s += node(540, 420, 190, 72, 'Speech', 'Speaches, optional');
  s += node(750, 420, 210, 72, 'Local apps, plugins', 'MCP servers');
  s += node(1030, 120, 140, 84, 'Model', 'providers');
  s += label('MODEL CALLS ARE', 1100, 230, 'middle'); s += label('THE ONLY CLOUD PART', 1100, 248, 'middle');
  // Arrows.
  [164, 240, 316].forEach((y) => { s += line(`M230 ${y} C 280 ${y}, 280 276, 326 276`, c); });
  s += label('HTTPS · SSE · WS', 40, 382);
  s += line('M590 250 C 640 250, 650 175, 696 175', c);
  s += label('/v1/responses', 584, 150);
  s += line('M830 206 C 830 290, 700 300, 594 300', c, { acc: true });
  s += label('MCP: app tools, cards', 700, 330, 'start', c.accText);
  s += line('M960 162 L1026 162', c);
  s += line('M425 328 L425 416', c); s += line('M480 328 C 480 380, 635 370, 635 416', c); s += line('M560 328 C 560 380, 855 360, 855 416', c);
  return svgDoc(1200, 560, 'How YBots fits together', `Your devices talk to the YBots server on your Linux machine. The server runs one Hermes gateway per bot, virtual screens, speech and local apps; the bots reach the app's tools over MCP. Only model calls leave the machine (${mode}).`, s);
}

// ---- Approval flow (1200 x 330) ------------------------------------------------------------------
function approvals(c, mode) {
  let s = `<rect width="1200" height="330" rx="20" fill="${c.bg}"/>` + arrowDefs(c);
  const step = (x, n, title, sub, hl) => box(x, 70, 230, 120, c, hl ? { fill: c.surf, stroke: c.accText, sw: 2.5 } : {})
    + T(n, { f: F.monoB, size: 12, x: x + 20, y: 100, fill: hl ? c.accText : c.mute, ls: 0.08 })
    + T(title, { f: F.bodyB, size: 18, x: x + 20, y: 132, fill: c.text })
    + sub.map((t, i) => T(t, { f: F.body, size: 14, x: x + 20, y: 158 + i * 19, fill: c.mute })).join('');
  s += step(30, '01  BOT', 'Robin wants to act', ['e.g. create a calendar', 'event in a connected app'], false);
  s += step(320, '02  CARD', 'A card asks you', ['in the chat, or in a', 'phone notification'], true);
  s += step(610, '03  YOU', 'You decide', ['Allow, Deny, or Always allow', 'for this bot and tool'], false);
  s += step(900, '04  RUN', 'It runs once', ['bound to that exact', 'action; result in chat'], false);
  s += line('M262 130 L316 130', c); s += line('M552 130 L606 130', c, { acc: true }); s += line('M842 130 L896 130', c);
  s += line('M725 192 L725 236', c);
  s += box(610, 240, 230, 48, c, { fill: c.raise }) + T('Deny: nothing happens', { f: F.body, size: 15, x: 725, y: 270, fill: c.text, anchor: 'middle' });
  s += T('A bot message is never an approval.', { f: F.bodyM, size: 15, x: 30, y: 262, fill: c.text });
  s += T('Cards expire, and each one is answered by a person.', { f: F.body, size: 15, x: 30, y: 285, fill: c.mute });
  s += T('APPROVAL CARDS', { f: F.monoB, size: 13, x: 30, y: 44, fill: c.mute, ls: 0.1 });
  return svgDoc(1200, 330, 'How approval cards work', `A bot asks to act, a card asks you, you allow or deny, and an allowed action runs once, bound to that exact request. A bot message is never an approval (${mode}).`, s);
}

// ---- App illustration (1280 x 760) ---------------------------------------------------------------
function app(c, mode) {
  let s = `<rect width="1280" height="760" rx="20" fill="${c.bg}"/><rect x=".75" y=".75" width="1278.5" height="758.5" rx="19.25" fill="none" stroke="${c.line}" stroke-width="1.5"/>`;
  // Window bar.
  s += [0, 1, 2].map((i) => `<circle cx="${28 + i * 20}" cy="26" r="6" fill="${c.line}"/>`).join('');
  s += `<path d="M0 52 H1280" stroke="${c.line}"/><path d="M280 52 V760 M940 52 V760" stroke="${c.line}"/>`;
  // Left: bot list.
  s += box(16, 70, 248, 64, c, { fill: c.surf, stroke: c.accText, sw: 2 }) + avatar(50, 102, 18, 'R', c.acc, c);
  s += T('Robin', { f: F.bodyB, size: 16, x: 80, y: 98, fill: c.text }) + T('Working · 1m 12s', { f: F.body, size: 13, x: 80, y: 118, fill: c.mute });
  [0, 1].forEach((i) => { const y = 160 + i * 64; s += `<circle cx="50" cy="${y + 26}" r="18" fill="none" stroke="${c.mute}" stroke-width="2"/><rect x="80" y="${y + 14}" width="${110 - i * 30}" height="10" rx="5" fill="${c.line}"/><rect x="80" y="${y + 32}" width="${150 - i * 20}" height="8" rx="4" fill="${c.raise}"/>`; });
  s += T('+ New bot', { f: F.bodyM, size: 14, x: 32, y: 320, fill: c.mute });
  s += avatar(42, 722, 16, 'A', c.sky, c) + T('Alex', { f: F.bodyM, size: 15, x: 68, y: 727, fill: c.text });
  // Middle: chat.
  const bubbleR = (y, lines) => { const w = Math.max(...lines.map((l) => width(l, F.body, 15))) + 32; const x = 916 - w; return `<rect x="${x}" y="${y}" width="${w}" height="${22 * lines.length + 20}" rx="16" fill="${c.text}"/>` + lines.map((l, i) => T(l, { f: F.body, size: 15, x: x + 16, y: y + 30 + i * 22, fill: c.bg })).join(''); };
  const bubbleL = (y, lines) => { const w = Math.max(...lines.map((l) => width(l, F.body, 15))) + 32; return `<rect x="304" y="${y}" width="${w}" height="${22 * lines.length + 20}" rx="16" fill="${c.surf}" stroke="${c.line}"/>` + lines.map((l, i) => T(l, { f: F.body, size: 15, x: 320, y: y + 30 + i * 22, fill: c.text })).join(''); };
  s += bubbleR(80, ['Can you put the team sync on my calendar,', 'Thursday at 10 for 30 minutes?']);
  s += box(304, 168, 220, 30, c, { r: 15, fill: c.surf }) + T('Worked for 42s · 4 steps', { f: F.mono, size: 12, x: 414, y: 188, fill: c.mute, anchor: 'middle' });
  s += bubbleL(212, ['Thursday at 10 is free. Here is the event;', 'it goes on your calendar when you allow it.']);
  // Approval card.
  s += box(304, 300, 400, 210, c, { r: 16, fill: c.surf, stroke: c.accText, sw: 2 });
  s += avatar(336, 336, 16, 'R', c.acc, c) + T('Robin wants to', { f: F.bodyB, size: 16, x: 362, y: 332, fill: c.text }) + T('Calendar · create event', { f: F.body, size: 13, x: 362, y: 351, fill: c.mute });
  s += box(320, 370, 368, 56, c, { r: 10, fill: c.raise, stroke: c.raise }) + T('"Team sync"', { f: F.mono, size: 14, x: 336, y: 393, fill: c.text }) + T('Thu 10:00 · 30 min · example.com', { f: F.mono, size: 12, x: 336, y: 413, fill: c.mute });
  s += box(320, 440, 176, 42, c, { r: 10, fill: c.acc, stroke: c.acc }) + T('Allow', { f: F.bodyB, size: 15, x: 408, y: 466, fill: c.onAcc, anchor: 'middle' });
  s += box(508, 440, 180, 42, c, { r: 10, fill: 'none' }) + T('Deny', { f: F.bodyM, size: 15, x: 598, y: 466, fill: c.text, anchor: 'middle' });
  s += T('Always allow for this tool', { f: F.body, size: 12, x: 504, y: 500, fill: c.mute, anchor: 'middle' });
  s += box(304, 540, 300, 44, c, { r: 22, fill: c.surf }) + `<circle cx="328" cy="562" r="7" fill="none" stroke="${c.accText}" stroke-width="2.5" stroke-dasharray="30 14"/>` + T('Waiting for your answer', { f: F.body, size: 14, x: 346, y: 567, fill: c.text });
  s += box(300, 690, 620, 50, c, { r: 25, fill: c.surf }) + T('Message Robin', { f: F.body, size: 15, x: 326, y: 720, fill: c.mute });
  s += `<circle cx="892" cy="715" r="16" fill="${c.acc}"/><path d="M886 715 H898 M892 709 L898 715 L892 721" stroke="${c.onAcc}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  // Right: Robin's screen and settings.
  s += T("ROBIN'S SCREEN", { f: F.monoB, size: 12, x: 960, y: 86, fill: c.mute, ls: 0.08 });
  s += box(960, 98, 300, 190, c, { r: 12, fill: c.surf }) + `<rect x="972" y="110" width="276" height="22" rx="6" fill="${c.raise}"/>` + T('calendar.example.com', { f: F.mono, size: 11, x: 984, y: 125, fill: c.mute });
  for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) s += `<rect x="${974 + i * 55}" y="${144 + j * 44}" width="49" height="38" rx="5" fill="${i === 3 && j === 1 ? c.acc : c.raise}"/>`;
  const row = (y, k, v) => T(k, { f: F.body, size: 14, x: 960, y, fill: c.mute }) + T(v, { f: F.bodyM, size: 14, x: 1260, y, fill: c.text, anchor: 'end' });
  s += T('ENGINE', { f: F.monoB, size: 12, x: 960, y: 330, fill: c.mute, ls: 0.08 });
  s += row(360, 'Provider', 'Your choice') + row(388, 'Model', 'any Hermes model') + row(416, 'Fallback', 'on');
  s += T('ROUTINES', { f: F.monoB, size: 12, x: 960, y: 462, fill: c.mute, ls: 0.08 });
  s += box(960, 474, 300, 56, c, { r: 12, fill: c.surf }) + T('Daily digest', { f: F.bodyM, size: 14, x: 976, y: 498, fill: c.text }) + T('Weekdays 9:00', { f: F.body, size: 12, x: 976, y: 516, fill: c.mute });
  s += `<rect x="1206" y="491" width="38" height="22" rx="11" fill="${c.acc}"/><circle cx="1233" cy="502" r="8" fill="${c.onAcc}"/>`;
  s += T('VOICE', { f: F.monoB, size: 12, x: 960, y: 566, fill: c.mute, ls: 0.08 });
  s += row(596, 'Speech', 'local') + row(624, 'Call', 'hands-free');
  return svgDoc(1280, 760, 'The YBots app', `Illustration with sample data: a chat with the bot Robin, who asks on an approval card to create a calendar event; the side panel shows Robin's screen, engine, routines and voice (${mode}).`, s);
}

const divider = svgDoc(1200, 24, 'Section divider', 'A thin line with three joined dots.',
  `<path d="M0 12 H570 M630 12 H1200" stroke="#8B95A3" stroke-opacity=".45" stroke-width="1.5"/><path d="M578 6 L600 14 L622 6" stroke="#8B95A3" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="578" cy="6" r="4" fill="#C6F432"/><circle cx="622" cy="6" r="4" fill="#8B95A3"/><circle cx="600" cy="19" r="4" fill="#8B95A3"/>`);

for (const mode of ['light', 'dark']) {
  const c = THEMES[mode];
  write(`assets/readme/banner-${mode}.svg`, banner(c, mode));
  write(`assets/readme/app-${mode}.svg`, app(c, mode));
  write(`assets/readme/architecture-${mode}.svg`, architecture(c, mode));
  write(`assets/readme/approvals-${mode}.svg`, approvals(c, mode));
}
write('assets/readme/divider.svg', divider);
const soc = social(THEMES.dark);
write('assets/readme/social-preview.svg', soc);

const { chromium } = require('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.setContent(`<html><body style="margin:0">${soc}</body></html>`);
write('assets/readme/social-preview.png', await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 640 } }));
await browser.close();
