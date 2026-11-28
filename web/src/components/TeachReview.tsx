import { useEffect, useState } from 'react';
import type { TeachDraft } from '@shared/types';
import { configApi } from '../lib/configApi';
import { useStore } from '../store';
import { Modal } from './modals/Modal';
import { Icon } from './Icon';
import { useTeach } from './TeachRecord';

/**
 * Review a recording (server/src/teach.ts): the skill the bot wrote, editable, beside the steps it was written
 * from. Save puts it in the bot's skills; Write again redoes it without the steps you took out; Discard throws
 * the recording away.
 */
export function TeachReview() {
  const botId = useStore((s) => s.teachReview);
  const bot = useStore((s) => s.bots.find((b) => b.id === botId));
  const set = useStore((s) => s.set);
  const { state, setState, error, setError } = useTeach(botId ?? undefined);
  const rec = state?.recording ?? null;
  const [draft, setDraft] = useState<TeachDraft | null>(null);
  const [drop, setDrop] = useState<Set<number>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'save' | 'redraft' | 'discard' | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const close = () => set({ teachReview: null });

  // A new draft arrives: show it (the person's edits start from it).
  const draftKey = rec?.draft ? `${rec.id}:${rec.draft.name}:${rec.draft.body.length}:${rec.status}` : '';
  useEffect(() => { if (rec?.draft) setDraft({ ...rec.draft }); }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (rec) setNote(rec.note); }, [rec?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!botId || !bot) return null;
  const name = bot.name;
  const act = async (kind: 'save' | 'redraft' | 'discard') => {
    if (!rec) return;
    setBusy(kind); setError(null);
    try {
      if (kind === 'save' && draft) { const r = await configApi.teachSave(bot.id, rec.id, draft); setSaved(r.skillName); }
      else if (kind === 'redraft') { setState(await configApi.teachRedraft(bot.id, rec.id, { note, remove: [...drop] })); setDrop(new Set()); }
      else if (kind === 'discard') { await configApi.teachDiscard(bot.id, rec.id); close(); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const body = (() => {
    if (saved) return (
      <div className="teach-review__done">
        <Icon name="check" size={18} />
        <div><strong>Saved as {saved}.</strong> {name} will use it the next time this task comes up. You can change it any time in {name}’s Skills.</div>
      </div>
    );
    if (!state && !error) return <div className="cfg-empty">Opening the recording…</div>;
    if (!rec) return <div className="cfg-empty">There’s no recording waiting for {name}. Take control of {name}’s screen and press Record to show it a task.</div>;
    if (rec.status === 'recording') return <div className="cfg-empty">Still recording. Press Stop on {name}’s screen when you’ve finished.</div>;
    return (
      <div className="teach-review__cols">
        <section className="teach-review__steps" aria-label="What you did">
          <div className="teach-review__label">What you did ({rec.lines.length} {rec.lines.length === 1 ? 'step' : 'steps'})</div>
          {rec.lines.length === 0 ? <div className="cfg-empty">Nothing was recorded. Discard this and record again.</div> : (
            <ol className="teach-steps">
              {rec.lines.map((l, i) => (
                <li key={i} className={`teach-steps__row${drop.has(i) ? ' is-dropped' : ''}${rec.steps[i]?.sensitive ? ' is-sensitive' : ''}`}>
                  <span className="teach-steps__text">{l}</span>
                  <button type="button" className="teach-steps__drop" onClick={() => setDrop((d) => { const n = new Set(d); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                    aria-label={drop.has(i) ? `Keep step ${i + 1}` : `Leave out step ${i + 1}`} title={drop.has(i) ? 'Keep this step' : 'Leave this step out'}>
                    {drop.has(i) ? 'Keep' : <Icon name="close" size={12} />}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="teach-review__hint">Passwords, card numbers and codes were not recorded. The skill tells {name} to ask you for them with a secure card.</div>
          <label className="teach-review__label" htmlFor="teach-note">Anything {name} should know (optional)</label>
          <textarea id="teach-note" className="text-input teach-review__note" rows={2} value={note} maxLength={600} onChange={(e) => setNote(e.target.value)} placeholder="For example: always pick the large bag" />
        </section>
        <section className="teach-review__skill" aria-label="The skill">
          {rec.status === 'drafting' || !draft ? (
            <div className="cfg-empty">{rec.status === 'drafting' ? `${name} is writing the skill…` : 'No skill yet. Press Write again.'}</div>
          ) : (
            <>
              {rec.error && <div className="teach-review__hint">{name} couldn’t write it this time ({rec.error}), so these are the recorded steps as they are. Edit them, or press Write again.</div>}
              <label className="teach-review__label" htmlFor="teach-name">Name</label>
              <input id="teach-name" className="text-input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <label className="teach-review__label" htmlFor="teach-desc">When to use it</label>
              <input id="teach-desc" className="text-input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              <label className="teach-review__label" htmlFor="teach-body">Steps for {name}</label>
              <textarea id="teach-body" className="text-input teach-review__body" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} spellCheck={false} />
            </>
          )}
        </section>
      </div>
    );
  })();

  const ready = !saved && rec && (rec.status === 'ready' || rec.status === 'stopped');
  return (
    <Modal onClose={close} className="teach-review" label={`Review what you showed ${name}`}>
      <div className="modal__header">
        <div className="modal__title">{saved ? 'Skill saved' : `Teach ${name}`}</div>
        <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button>
      </div>
      <div className="modal__body teach-review__main">
        {error && <div className="cfg-error" role="alert">{error}</div>}
        {body}
      </div>
      <div className="modal__footer">
        {saved ? <button type="button" className="cfg-btn cfg-btn--primary" onClick={close}>Done</button> : (
          <>
            {rec && rec.status !== 'recording' && <button type="button" className="cfg-btn" onClick={() => void act('discard')} disabled={!!busy}>{busy === 'discard' ? 'Discarding…' : 'Discard'}</button>}
            <span style={{ flex: 1 }} />
            {ready && rec.lines.length > 0 && <button type="button" className="cfg-btn" onClick={() => void act('redraft')} disabled={!!busy || drop.size >= rec.lines.length}>{busy === 'redraft' ? 'Asking…' : 'Write again'}</button>}
            {ready && <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => void act('save')} disabled={!!busy || !draft || !draft.name.trim() || !draft.body.trim()}>{busy === 'save' ? 'Saving…' : 'Save skill'}</button>}
          </>
        )}
      </div>
    </Modal>
  );
}
