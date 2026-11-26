import type { CardBody } from '@shared/types';
import { safeUrl, type PluginBlock } from '@shared/plugins/ui-schema';

type Card = Extract<CardBody, { card: 'plugin' }>;

/** A plugin's card: plain data from server/src/plugins/ui-schema.ts, rendered with fixed components. */
export function PluginCardView({ body }: { body: Card }) {
  const v = body.view;
  return (
    <div className="card plugin-card">
      <div className="card__head">
        <div className="card__titles">
          <div className="card__eyebrow">{body.pluginName}</div>
          <div className="card__title">{v.title}</div>
          {v.subtitle && <div className="card__sub">{v.subtitle}</div>}
        </div>
      </div>
      <div className="plugin-card__body">{v.blocks.map((b, i) => <Block key={i} b={b} />)}</div>
    </div>
  );
}

function Block({ b }: { b: PluginBlock }) {
  switch (b.kind) {
    case 'heading': return <div className="plugin-card__heading">{b.text}</div>;
    case 'text': return <p className="plugin-card__text">{b.text}</p>;
    case 'fields': return <dl className="plugin-card__fields">{b.items.map((f, i) => <div key={i}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>;
    case 'table': return (
      <div className="plugin-card__table"><table><thead><tr>{b.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>
    );
    // Checked again here: the apps never trust a URL just because the server passed it.
    case 'link': { const u = safeUrl(b.url); return u ? <a className="plugin-card__link" href={u} target="_blank" rel="noopener noreferrer nofollow">{b.label}</a> : null; }
    case 'image': { const u = safeUrl(b.url, true); return u ? <img className="plugin-card__image" src={u} alt={b.alt} referrerPolicy="no-referrer" loading="lazy" /> : null; }
    case 'progress': return <div className="plugin-card__progress"><span>{b.label}</span><progress value={b.value} max={b.max} /></div>;
    case 'badge': return <span className={`plugin-card__badge is-${b.tone}`}>{b.text}</span>;
    default: return null;
  }
}
