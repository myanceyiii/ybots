/**
 * Page charts as an SVG picture: a copy of server/src/page-chart.ts (the web app and the exports use that one),
 * drawn on the phone with react-native-svg's SvgXml. Keep the two in step. All text is escaped.
 */

/** The numbers a chart draws: its own, or the first column (labels) and number columns of a table block. */
export function chartData(b: any, page: { blocks: any[] }): { labels: string[]; series: { name: string; values: number[] }[] } {
  if (b.from) {
    const t: any = page.blocks.find((x) => x.id === b.from && x.type === 'table');
    if (t) {
      const num = (v: string) => Number(String(v ?? '').replace(/[$,%\s]/g, ''));
      const cols = t.columns.map((_: string, i: number) => i).filter((i: number) => i > 0 && t.rows.some((r: string[]) => r[i] !== undefined && r[i] !== '' && Number.isFinite(num(r[i]))));
      return { labels: t.rows.map((r: string[]) => r[0] ?? ''), series: cols.map((i: number) => ({ name: t.columns[i], values: t.rows.map((r: string[]) => (Number.isFinite(num(r[i])) ? num(r[i]) : 0)) })) };
    }
  }
  return { labels: b.labels ?? [], series: b.series ?? [] };
}

export const esc = (t: string) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const PALETTE = ['#3b6fd8', '#e0803a', '#2f9e6e', '#c94a5a', '#8a5cc7', '#c9a227', '#3aa3b8', '#7a7f87'];

/** Colours for a chart picture: exports use the light ones; the apps pass dark ones in dark mode. */
export interface ChartLook { bg: string; ink: string; muted: string; grid: string; label: string }
export const CHART_LIGHT: ChartLook = { bg: '#fff', ink: '#111', muted: '#555', grid: '#e3e5e8', label: '#333' };
export const CHART_DARK: ChartLook = { bg: '#1f1f1f', ink: '#f5f5f5', muted: '#a3a3a3', grid: '#3a3a3a', label: '#c9c9c9' };

/** A chart as a static SVG picture (exports, and the apps' Pages and answer views). */
export function chartSvg(b: any, page: { blocks: any[] }, w = 640, h = 320, look: ChartLook = CHART_LIGHT): string {
  const { labels, series } = chartData(b, page);
  const pad = { l: 48, r: 16, t: b.title ? 34 : 14, bt: 54 };
  const title = b.title ? `<text x="${w / 2}" y="20" text-anchor="middle" font-size="15" font-weight="bold" fill="${look.ink}">${esc(b.title)}</text>` : '';
  if (b.chart === 'pie') {
    const vals = (series[0]?.values ?? []).map((v) => Math.max(0, v));
    const total = vals.reduce((a, c) => a + c, 0) || 1;
    const cx = w / 2 - 90, cy = (h + pad.t) / 2, r = Math.min(h - pad.t - 20, w) / 2;
    let a0 = -Math.PI / 2;
    const parts = vals.map((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = vals.length === 1 || v === total
        ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${PALETTE[i % 8]}"/>`
        : `<path d="M${cx},${cy} L${(cx + r * Math.cos(a0)).toFixed(1)},${(cy + r * Math.sin(a0)).toFixed(1)} A${r},${r} 0 ${large} 1 ${(cx + r * Math.cos(a1)).toFixed(1)},${(cy + r * Math.sin(a1)).toFixed(1)} Z" fill="${PALETTE[i % 8]}" stroke="${look.bg}" stroke-width="1.5"/>`;
      a0 = a1;
      return p;
    }).join('');
    const legend = labels.slice(0, 12).map((l, i) => `<rect x="${w / 2 + 40}" y="${pad.t + 6 + i * 22}" width="12" height="12" fill="${PALETTE[i % 8]}"/><text x="${w / 2 + 58}" y="${pad.t + 16 + i * 22}" font-size="12" fill="${look.ink}">${esc(l)} (${Math.round(((vals[i] ?? 0) / total) * 100)}%)</text>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Liberation Sans, Arial, sans-serif"><rect width="100%" height="100%" fill="${look.bg}"/>${title}${parts}${legend}</svg>`;
  }
  const all = series.flatMap((x) => x.values);
  const max = Math.max(0, ...all), min = Math.min(0, ...all);
  const span = max - min || 1;
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.bt;
  const y = (v: number) => pad.t + ph - ((v - min) / span) * ph;
  const n = Math.max(1, labels.length);
  const step = pw / n;
  const tick = (v: number) => (span >= 20 ? Math.round(v) : +v.toFixed(span >= 2 ? 1 : 2));
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => { const v = min + span * f; return `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="${look.grid}"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="${look.muted}">${tick(v)}</text>`; }).join('');
  const xl = labels.map((l, i) => `<text x="${pad.l + step * i + step / 2}" y="${h - pad.bt + 16}" text-anchor="middle" font-size="11" fill="${look.label}">${esc(l.slice(0, 14))}</text>`).join('');
  let marks = '';
  if (b.chart === 'line') {
    marks = series.map((sr, si) => `<polyline fill="none" stroke="${PALETTE[si % 8]}" stroke-width="2.5" points="${sr.values.map((v, i) => `${(pad.l + step * i + step / 2).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`).join('');
  } else {
    const k = Math.max(1, series.length);
    const bw = (step * 0.7) / k;
    marks = series.map((sr, si) => sr.values.map((v, i) => { const x = pad.l + step * i + step * 0.15 + si * bw; const y0 = y(Math.max(0, v)), y1 = y(Math.min(0, v)); return `<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${Math.max(0.5, y1 - y0).toFixed(1)}" fill="${PALETTE[si % 8]}"/>`; }).join('')).join('');
  }
  const legend = series.length > 1 ? series.map((sr, i) => `<rect x="${pad.l + i * 130}" y="${h - 22}" width="12" height="12" fill="${PALETTE[i % 8]}"/><text x="${pad.l + 18 + i * 130}" y="${h - 12}" font-size="12" fill="${look.ink}">${esc(sr.name.slice(0, 16))}</text>`).join('') : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Liberation Sans, Arial, sans-serif"><rect width="100%" height="100%" fill="${look.bg}"/>${title}${grid}${marks}${xl}${legend}</svg>`;
}

