// Draws the launcher icons for both apps from the project's own bot shapes (src/shapes.json).
// YBots: a white blob on near-black. Run: node scripts/gen-icons.mjs
// Needs Playwright with Chromium (only to render the PNGs; the app does not use it).
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const shapes = JSON.parse(readFileSync(new URL('../src/shapes.json', import.meta.url)));

const svg = (shape, fill, eye, bg, scale) => {
  const { d, eyes: { y, dx, s } } = shapes[shape];
  const e = [-1, 1].map((side) => `<ellipse cx="${50 + side * dx}" cy="${y}" rx="${7 * s}" ry="${9 * s}" fill="${eye}"/>`).join('');
  const t = `translate(50 50) scale(${scale}) translate(-50 -50)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%">${bg ? `<rect width="100" height="100" fill="${bg}"/>` : ''}<g transform="${t}"><path d="${d}" fill="${fill}"/>${e}</g></svg>`;
};
const apps = { cleftbot: { shape: 'blob', bg: '#111111' } };

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
const shot = async (markup, size, path, transparent) => {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${markup}</body></html>`);
  await page.screenshot({ path, omitBackground: transparent });
};
for (const [name, a] of Object.entries(apps)) {
  const dir = new URL(`../assets/${name}/`, import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  await shot(svg(a.shape, '#FFFFFF', a.bg, a.bg, 0.62), 1024, `${dir}icon.png`, false);
  // Adaptive icon: the launcher crops to the middle ~61%, so the character stays small.
  await shot(svg(a.shape, '#FFFFFF', a.bg, null, 0.5), 512, `${dir}android-icon-foreground.png`, true);
  await shot(svg(a.shape, '#FFFFFF', '#00000000', null, 0.5), 432, `${dir}android-icon-monochrome.png`, true);
  await shot(svg(a.shape, a.bg, '#FFFFFF', null, 0.4), 1024, `${dir}splash-icon.png`, true);
}
await browser.close();
