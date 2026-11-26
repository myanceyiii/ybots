import { useState } from 'react';
import { appIcon, type IconData } from '@shared/card-icon';

/**
 * App logo tile (40px in Connect Apps). An app's own `logo` wins; otherwise the bundled logo or glyph
 * (server/src/card-icon.ts: `icon`, or the app's by its id/name); the name's first letter only when
 * nothing fits.
 */
export function ToolkitLogo({ name, logo, icon, appId, size = 40, radius = 8 }: { name: string; logo?: string; icon?: IconData; appId?: string; size?: number; radius?: number }) {
  const [broken, setBroken] = useState(false);
  const letter = (name.trim()[0] ?? '?').toUpperCase();
  const mark = icon ?? appIcon(appId ?? '', name) ?? undefined;
  if (!(logo && !broken) && mark) return <IconTile icon={mark} size={size} radius={radius} />;
  return (
    <span className="toolkit-logo" style={{ width: size, height: size, borderRadius: radius }}>
      {logo && !broken ? (
        <img src={logo} alt="" width={size * 0.7} height={size * 0.7} onError={() => setBroken(true)} draggable={false} />
      ) : (
        <span className="toolkit-logo__letter" style={{ fontSize: size * 0.42 }}>{letter}</span>
      )}
    </span>
  );
}

/** A bundled icon on its tile: a brand mark in its colour on white, or a white glyph on a coloured tile. */
export function IconTile({ icon, size = 40, radius = 8 }: { icon: IconData; size?: number; radius?: number }) {
  const brand = icon.kind === 'brand';
  const inner = size * (brand ? 0.58 : 0.56);
  return (
    <span className="toolkit-logo" style={{ width: size, height: size, borderRadius: radius, ...(brand ? {} : { background: icon.color, boxShadow: 'none' }) }} title={icon.label} aria-hidden>
      <svg width={inner} height={inner} viewBox="0 0 24 24" focusable="false"
        {...(brand ? { fill: icon.color } : { fill: 'none', stroke: '#FFFFFF', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const })}>
        {icon.d.map((d, i) => <path key={i} d={d} />)}
      </svg>
    </span>
  );
}
