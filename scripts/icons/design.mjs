// The YBots app icon, "Signal" design: a Y drawn as three agents joined at one point, on ink, with one
// lime node. scripts/icons/build-icons.mjs draws every size from this; colours and rules are in
// docs/brand.md.
// In a 512 x 512 box. `motif` is the picture without its background; `mono` is the same shape in one
// colour (white, with the hole at the joint) for Android's themed icons.
const INK = '#0E1116';
const FG = '#E8ECF1';
const LIME = '#C6F432';
const mark = (lines, lead, others, hole) => `
  <path d="M150 150 L256 270 L362 150 M256 270 L256 380" stroke="${lines}" stroke-width="44" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <circle cx="150" cy="150" r="50" fill="${lead}"/><circle cx="362" cy="150" r="50" fill="${others}"/>
  <circle cx="256" cy="384" r="50" fill="${others}"/>${hole}`;
export const D = {
  name: 'YBots',
  bg: INK,
  bgSvg: `<rect width="512" height="512" fill="${INK}"/>`,
  motif: mark(FG, LIME, FG, `<circle cx="256" cy="270" r="22" fill="${INK}"/>`),
  mono: `<mask id="m"><rect width="512" height="512" fill="#fff"/><circle cx="256" cy="270" r="22" fill="#000"/></mask><g mask="url(#m)">${mark('#fff', '#fff', '#fff', '')}</g>`,
  cx: 256, cy: 267,
  masters: ['ybots-icon', 'ybots-icon-rounded', 'ybots-foreground', 'ybots-monochrome'].map((k) => `assets/brand/${k}.svg`),
};
