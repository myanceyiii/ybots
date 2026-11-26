#!/usr/bin/env node
/**
 * Draws the YBots app icon once and writes every size the three apps need:
 *   web      web/public/favicon.svg, favicon.ico, apple-touch-icon.png, icon-192/512.png,
 *            icon-maskable-512.png, manifest.webmanifest
 *   Android  mobile/assets/cleftbot/icon.png, android-icon-foreground.png, android-icon-monochrome.png,
 *            android-icon-background.png, splash-icon.png, mobile/assets/favicon.png
 *   Windows  desktop/build/icon.png, icon.ico, desktop/src/assets/icon.png, tray-16.png, tray-32.png
 * plus the master art in assets/brand/.
 *
 * Dev-time only: needs Playwright's Chromium to turn SVG into PNG. The outputs are committed.
 *   node scripts/icons/build-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const out = (p) => path.join(root, p);

// ---- The design, in a 512 x 512 box. `motif` is the picture without its background; `mono` is the
// same outline in one colour (white with holes) for Android's themed icons. --------------------------
const INK = '#1C1C1C';
const GRAD = '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFC75A"/><stop offset="1" stop-color="#F08A24"/></linearGradient></defs>';
const Y = (c) => `
  <path d="M138 128 L256 270 L374 128" stroke="${c}" stroke-width="70" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <path d="M256 262 V392" stroke="${c}" stroke-width="70" stroke-linecap="round"/>
  <ellipse cx="228" cy="114" rx="21" ry="28" fill="${c}"/><ellipse cx="284" cy="114" rx="21" ry="28" fill="${c}"/>`;
const D = {
  name: 'YBots',
  bg: '#F5A63F', // flat stand-in for the gradient (manifest colours)
  bgSvg: `${GRAD}<rect width="512" height="512" fill="url(#g)"/>`,
  motif: Y(INK), // a bold Y whose fork holds two eyes
  mono: Y('#fff'),
  // Centre of the motif's bounding box, so scaled copies stay centred.
  cx: 256, cy: 260,
};

const svg = (body, { round = 0 } = {}) => {
  const clip = round ? `<defs><clipPath id="r"><rect width="512" height="512" rx="${round}"/></clipPath></defs>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${clip}<g${round ? ' clip-path="url(#r)"' : ''}>${body}</g></svg>\n`;
};
/** The motif scaled by `k` about its centre and moved to the canvas centre. */
const scaled = (body, k) => `<g transform="translate(256 256) scale(${k}) translate(${-D.cx} ${-D.cy})">${body}</g>`;

const full = svg(D.bgSvg + scaled(D.motif, 1));              // square, edge to edge (launchers mask it)
const rounded = svg(D.bgSvg + scaled(D.motif, 1.08), { round: 112 }); // favicon, tray, Windows
const maskable = svg(D.bgSvg + scaled(D.motif, 0.8));         // web maskable: inside the 80% safe circle
// Android adaptive layers are 108dp with a 66dp safe circle: the motif fills about 60% of what shows.
const foreground = svg(scaled(D.motif, 0.62));
const mono = svg(scaled(D.mono, 0.62));
const splash = svg(`<g transform="translate(64 64) scale(0.75)">${GRAD}<rect width="512" height="512" rx="112" fill="url(#g)"/>${scaled(D.motif, 1.08)}</g>`); // the rounded tile, centred

// ---- Render ---------------------------------------------------------------------------------------
const { chromium } = require('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
async function png(svgText, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svgText.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
/** An .ico holding PNG images (Windows Vista and later read these at every size). */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(([size, buf], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  return Buffer.concat([head, ...pngs.map(([, b]) => b)]);
}
const write = (p, data) => { fs.mkdirSync(path.dirname(out(p)), { recursive: true }); fs.writeFileSync(out(p), data); console.log('wrote', p); };

// Master art.
write('assets/brand/yanceybot-icon.svg', full);
write('assets/brand/yanceybot-icon-rounded.svg', rounded);
write('assets/brand/yanceybot-foreground.svg', foreground);
write('assets/brand/yanceybot-monochrome.svg', mono);
write('assets/icon.svg', rounded);

// Web.
write('web/public/favicon.svg', rounded);
write('web/public/favicon.ico', ico([[16, await png(rounded, 16)], [32, await png(rounded, 32)], [48, await png(rounded, 48)]]));
write('web/public/apple-touch-icon.png', await png(full, 180));
write('web/public/icon-192.png', await png(rounded, 192));
write('web/public/icon-512.png', await png(rounded, 512));
write('web/public/icon-maskable-512.png', await png(maskable, 512));
write('web/public/manifest.webmanifest', JSON.stringify({
  name: D.name, short_name: D.name, start_url: '/', display: 'standalone',
  background_color: D.bg, theme_color: D.bg,
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
}, null, 2) + '\n');

// Android.
write('mobile/assets/cleftbot/icon.png', await png(full, 1024));
write('mobile/assets/cleftbot/android-icon-background.png', await png(svg(D.bgSvg), 512));
write('mobile/assets/cleftbot/android-icon-foreground.png', await png(foreground, 512));
write('mobile/assets/cleftbot/android-icon-monochrome.png', await png(mono, 432));
write('mobile/assets/cleftbot/splash-icon.png', await png(splash, 1024));
write('mobile/assets/favicon.png', await png(rounded, 48));

// Windows.
write('desktop/build/icon.png', await png(rounded, 1024));
const icoSizes = [16, 24, 32, 48, 64, 72, 96, 128, 256];
const icoPngs = [];
for (const s of icoSizes) icoPngs.push([s, await png(rounded, s)]);
write('desktop/build/icon.ico', ico(icoPngs));
write('desktop/src/assets/icon.png', await png(rounded, 256));
write('desktop/src/assets/tray-16.png', await png(rounded, 16));
write('desktop/src/assets/tray-32.png', await png(rounded, 32));

await browser.close();
