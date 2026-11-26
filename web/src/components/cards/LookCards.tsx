import { useState } from 'react';
import type { CardBody, Row } from '@shared/types';
import { api, lookUrl } from '../../lib/api';
import { useStore } from '../../store';
import { BotAvatar, BotAvatarFor } from '../../avatar/BotAvatar';
import { LookMaker, useLooksOptions } from '../../avatar/LookMaker';
import { celebrate } from '../../avatar/pose';
import { Icon } from '../Icon';

type Card<K extends CardBody['card']> = Extract<CardBody, { card: K }>;

const INTENT: Record<Card<'look'>['intent'], string> = {
  tweak: 'Changing my current look',
  new: 'A whole new look',
  default: 'Back to my plain shape',
};

/**
 * A bot's offer of new looks (avatars.ts): a grid that fills with pictures, then "Use this one".
 * More options asks for more, with a different wording, style, count or starting picture. Nothing
 * changes until the owner picks a picture here.
 */
export function LookCard({ row, body }: { row: Row; body: Card<'look'> }) {
  const bot = useStore((s) => s.bots.find((b) => b.id === row.botId));
  const opts = useLooksOptions();
  const [picked, setPicked] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!bot) return null;
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message || 'Something went wrong'); } finally { setBusy(null); }
  };
  const styleLabel = body.style ? opts?.styles.find((s) => s.id === body.style)?.label : null;
  const making = body.status === 'making';
  const open = body.status === 'pending' || body.status === 'failed';
  const shown = body.status === 'applied' && body.chosen ? [body.chosen] : body.candidates;
  // What "Use this one" acts on: the tile tapped, or the first picture until one is tapped.
  const sel = open ? (picked && shown.includes(picked) ? picked : shown[0] ?? null) : null;
  const selN = sel ? shown.indexOf(sel) + 1 : 0;
  const retry = () => run('retry', () => api.moreLooks(bot.id, row.seq, { intent: body.intent === 'tweak' ? 'tweak' : 'new', description: body.description, style: body.style ?? null, count: body.count }));

  if (body.intent === 'default') {
    return (
      <div className={`card look-card${open ? '' : ' is-resolved'}`}>
        <div className="card__head">
          <div className="card__titles">
            <div className="card__title">Go back to {bot.name}'s plain shape?</div>
            <div className="card__sub">The picture and its poses are put away. You can make a new look any time.</div>
          </div>
        </div>
        <div className="look-card__swap">
          <BotAvatarFor bot={bot} size={64} still />
          <Icon name="chev_right" size={16} opacity={0.5} />
          <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={64} />
        </div>
        {open ? (
          <div className="card__actions">
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => run('keep', () => api.dismiss(bot.id, row))}>Keep the picture</button>
            <button type="button" className="btn btn--primary" disabled={!!busy} onClick={() => run('shape', () => api.chooseLook(bot.id, row.seq, null))}>Use the shape</button>
          </div>
        ) : (
          <div className="card__outcome"><Icon name={body.status === 'applied' ? 'check' : 'close'} size={12} opacity={0.7} />{body.status === 'applied' ? 'Back to the shape' : 'Kept the picture'}</div>
        )}
        {error && <div className="card__error">{error}</div>}
      </div>
    );
  }

  return (
    <div className={`card look-card${open || making ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <div className="card__titles">
          <div className="card__title">{body.status === 'applied' ? `${bot.name}'s new look` : `New looks for ${bot.name}`}</div>
          <div className="card__sub">{INTENT[body.intent]}{styleLabel ? ` · ${styleLabel}` : ''}{body.description ? ` · “${body.description}”` : ''}</div>
        </div>
      </div>
      <div className={`look-grid${shown.length + (making ? body.count : 0) > 4 ? ' is-many' : ''}${sel && shown.length > 1 ? ' has-pick' : ''}`} role="radiogroup" aria-label="Pick a look">
        {shown.map((id, i) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={sel === id}
            aria-label={`Option ${i + 1}`}
            className={`look-tile${sel === id || body.chosen === id ? ' is-picked' : ''}`}
            disabled={!open || !!busy}
            onClick={() => setPicked(id)}
            onDoubleClick={() => open && run('use', async () => { await api.chooseLook(bot.id, row.seq, id); celebrate(bot.id); })}
          >
            <img src={lookUrl(bot.id, id)} alt="" loading="lazy" />
            <span className="look-tile__n">{i + 1}</span>
            {(sel === id || body.chosen === id) && <span className="look-tile__check" aria-hidden><Icon name="check" size={14} /></span>}
          </button>
        ))}
        {making && Array.from({ length: body.count }, (_, i) => <span key={`m${i}`} className="look-tile is-making" aria-hidden />)}
      </div>
      {making && <div className="look-card__note">Drawing {body.count} {body.count === 1 ? 'option' : 'options'}… this can take a minute or two.</div>}
      {body.error && !making && (
        <div className="look-card__fail" role="alert">
          <span>{body.candidates.length ? `The last pictures could not be drawn: ${body.error}` : `The pictures could not be drawn: ${body.error}`}</span>
          {open && <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={retry}>{busy === 'retry' ? 'Starting…' : 'Try again'}</button>}
        </div>
      )}
      {open && !more && (
        <div className="card__actions">
          <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => setMore(true)}>More options</button>
          {shown.length > 0 && (
            <button type="button" className="btn btn--primary" disabled={!sel || !!busy} onClick={() => sel && run('use', async () => { await api.chooseLook(bot.id, row.seq, sel); celebrate(bot.id); })}>
              {busy === 'use' ? 'Saving…' : shown.length > 1 ? `Use option ${selN}` : 'Use this one'}
            </button>
          )}
        </div>
      )}
      {open && more && (
        <div className="look-card__more">
          <LookMaker
            bot={bot}
            compact
            initial={{ description: body.description, intent: body.intent === 'tweak' ? 'tweak' : 'new', style: body.style ?? null, count: body.count }}
            submitLabel="Make more"
            busy={busy === 'more'}
            onSubmit={(a) => run('more', async () => { await api.moreLooks(bot.id, row.seq, a); setMore(false); })}
          />
          <button type="button" className="link-btn link-btn--small" onClick={() => setMore(false)}>Cancel</button>
        </div>
      )}
      {open && (
        <div className="look-card__foot">
          <button type="button" className="link-btn link-btn--small" disabled={!!busy} onClick={() => run('skip', () => api.dismiss(bot.id, row))}>Keep my current look</button>
        </div>
      )}
      {body.status === 'dismissed' && <div className="card__outcome"><Icon name="close" size={12} opacity={0.7} />Kept the current look</div>}
      {error && <div className="card__error">{error}</div>}
    </div>
  );
}

/** The chosen look, shown off: big picture, share, a few ideas for a next change, and how the poses are coming along. */
export function LookRevealCard({ row, body }: { row: Row; body: Card<'look-reveal'> }) {
  const bot = useStore((s) => s.bots.find((b) => b.id === row.botId));
  const [note, setNote] = useState<string | null>(null);
  if (!bot) return null;
  const src = lookUrl(bot.id, body.candidateId);
  const share = async () => {
    try {
      const blob = await (await fetch(src, { credentials: 'include' })).blob();
      const file = new File([blob], `${bot.name.replace(/[^\w-]+/g, '-')}-look.${blob.type.split('/')[1] ?? 'jpg'}`, { type: blob.type });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: `${bot.name}'s new look` }); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = file.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { if ((e as Error).name !== 'AbortError') setNote('Could not share the picture.'); }
  };
  const job = bot.avatarPoseJob;
  const current = bot.avatarImageUrl !== null;
  return (
    <div className="card look-reveal">
      <div className="look-reveal__stage">
        <img src={src} alt={`${bot.name}'s new look`} className="look-reveal__img" />
      </div>
      <div className="look-reveal__title">Ta-da! This is me now.</div>
      {current && job && (
        <div className="look-reveal__poses">
          {job.state === 'making' ? `Making my poses for listening, thinking, working and more: ${job.done} of ${job.total}`
            : job.state === 'ready' ? `${job.done} poses ready${job.failed ? ` (${job.failed} could not be made)` : ''}. I'll switch between them as I work.`
            : `Poses stopped at ${job.done} of ${job.total}${job.error ? `: ${job.error}` : ''}. You can make them again in my settings.`}
        </div>
      )}
      <div className="look-reveal__ideas">
        {body.suggestions.map((s) => (
          <button key={s} type="button" className="look-chip" onClick={() => (bot.outside ? api.askLooks(bot.id, { description: s, intent: 'tweak' }) : api.send(bot.id, `Change your look: ${s.charAt(0).toLowerCase()}${s.slice(1)}`)).catch(() => setNote('Could not send that.'))}>{s}</button>
        ))}
      </div>
      <div className="card__actions">
        <button type="button" className="btn btn--secondary" onClick={share}><Icon name="share" size={14} opacity={0.7} /> Share</button>
      </div>
      {note && <div className="card__error">{note}</div>}
    </div>
  );
}
