import { useEffect, useRef, useState } from 'react';
import type { Bot } from '@shared/types';
import { AVATAR_POSES, type AvatarPose } from '@shared/avatar-poses';
import { BotAvatar, BotAvatarFor } from '../../avatar/BotAvatar';
import { LookMaker, fileToDataUrl, useLooksOptions } from '../../avatar/LookMaker';
import { celebrate } from '../../avatar/pose';
import { api, type LookAskBody } from '../../lib/api';
import { askToNotify } from '../../lib/notify';
import { useStore } from '../../store';
import { ConfirmButton } from './ui';
import { Icon } from '../Icon';

const putBot = (next: Bot) => useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === next.id ? next : b)) }));

/**
 * A bot's look: make a picture (describe it, keep or start over, style, how many, a picture to
 * start from) or upload one, then the poses made from it, each of which can be made again.
 */
export function LookTab({ bot }: { bot: Bot }) {
  const opts = useLooksOptions();
  const [candidates, setCandidates] = useState<string[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [preview, setPreview] = useState<AvatarPose | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawFail, setDrawFail] = useState<string | null>(null);
  const [lastAsk, setLastAsk] = useState<LookAskBody | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message || 'Something went wrong'); } finally { setBusy(null); }
  };
  const usePicture = (image: string) => run('use', async () => {
    putBot((await api.setPicture(bot.id, image)).bot);
    setCandidates([]); setPicked(null); celebrate(bot.id);
  });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  /** Wait for a run on the server, then show its pictures (or why it failed) and mark it shown. */
  const waitAndShow = async (runId: string) => {
    try {
      const { candidates: next } = await api.waitLookRun(bot.id, runId);
      if (!alive.current) return;
      setCandidates((c) => [...next, ...c]);
      setPicked(next[0] ?? null);
    } catch (e) {
      if (!alive.current) return;
      setDrawFail((e as Error).message || 'The image service failed without saying why.');
    }
    api.lookRunSeen(bot.id, runId).catch(() => {});
  };
  const follow = (runId: string) => run('generate', () => waitAndShow(runId));
  const draw = (ask: LookAskBody) => {
    setLastAsk(ask); setDrawFail(null);
    askToNotify();
    return run('generate', async () => {
      try {
        const started = await api.startLooks(bot.id, ask);
        if (started.candidates) { setCandidates((c) => [...started.candidates!, ...c]); setPicked(started.candidates[0] ?? null); return; }
        await waitAndShow(started.run!);
      } catch (e) { setDrawFail((e as Error).message || 'The image service failed without saying why.'); }
    });
  };
  // Pictures drawn while this page was closed, reloaded or in another app: show them, or keep waiting.
  useEffect(() => {
    let stop = false;
    api.lookRuns(bot.id).then(({ runs }) => {
      if (stop) return;
      const drawing = runs.find((r) => r.state === 'making');
      for (const r of runs.filter((x) => x.state !== 'making').reverse()) {
        if (r.state === 'failed') { setDrawFail(r.error ?? 'The image service failed without saying why.'); setLastAsk({ prompt: r.ask.description, style: r.ask.style ?? undefined, count: r.ask.count, intent: r.ask.intent }); api.lookRunSeen(bot.id, r.id).catch(() => {}); }
        else api.waitLookRun(bot.id, r.id).then(({ candidates: next }) => {
          if (stop) return;
          setCandidates((c) => [...next, ...c]); setPicked((p) => p ?? next[0] ?? null);
          api.lookRunSeen(bot.id, r.id).catch(() => {});
        }).catch(() => {});
      }
      if (drawing) { setLastAsk({ prompt: drawing.ask.description, style: drawing.ask.style ?? undefined, count: drawing.ask.count, intent: drawing.ask.intent }); void follow(drawing.id); }
    }).catch(() => {});
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);
  const upload = (f: File | undefined) => f && run('upload', async () => usePicture(await fileToDataUrl(f)));

  const job = bot.avatarPoseJob;
  const poses = bot.avatarPoses ?? {};
  const hasPicture = !!bot.avatarImageUrl;
  const previewImage = preview && hasPicture ? poses[preview] ?? bot.avatarImageUrl : null;

  return (
    <div className="cfg-page">
      <section className="cfg-section">
        <div className="cfg-look">
          {preview
            ? <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={96} image={previewImage} mood={preview} title={bot.name} />
            : <BotAvatarFor bot={bot} size={96} />}
          <div className="cfg-look__text">
            <div className="cfg-look__name">{bot.name}</div>
            <div className="cfg-page__sub">Shown everywhere {bot.name} appears. It changes pose as {bot.name} listens, thinks, works and finishes.</div>
          </div>
        </div>
        <div className="look-maker__row">
          <span className="look-maker__label">Try a state</span>
          <div className="look-maker__chips">
            {AVATAR_POSES.map((p) => (
              <button key={p.id} type="button" className={`look-chip${preview === p.id ? ' is-on' : ''}`} onClick={() => setPreview(preview === p.id ? null : p.id)}>{p.label}</button>
            ))}
          </div>
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Make a picture</div>
        {opts && !opts.generating && <div className="cfg-page__sub">Making pictures is not set up on this server, so you can only upload one.</div>}
        {(!opts || opts.generating) && (
          <LookMaker
            bot={bot}
            initial={{ intent: hasPicture ? 'tweak' : 'new' }}
            submitLabel={candidates.length ? 'Make more' : 'Make pictures'}
            busy={busy === 'generate'}
            onSubmit={(a) => draw({ prompt: a.description, intent: a.intent, style: a.style ?? undefined, count: a.count, reference: a.reference })}
          />
        )}
        {busy === 'generate' && <div className="cfg-page__sub">Drawing… this can take a minute or two. You can close this or switch tabs: the pictures will be here when you come back.</div>}
        {drawFail && busy !== 'generate' && (
          <div className="look-card__fail look-card__fail--page" role="alert">
            <span>The pictures could not be drawn: {drawFail}</span>
            {lastAsk && <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!!busy} onClick={() => draw(lastAsk)}>Try again</button>}
          </div>
        )}
        {candidates.length > 0 && (
          <>
            <div className={`look-grid is-many settings-look-grid${picked && candidates.length > 1 ? ' has-pick' : ''}`} role="radiogroup" aria-label="Pick a picture">
              {candidates.map((c, i) => (
                <button key={i} type="button" role="radio" aria-checked={picked === c} aria-label={`Option ${i + 1}`} className={`look-tile${picked === c ? ' is-picked' : ''}`} onClick={() => setPicked(c)} onDoubleClick={() => usePicture(c)}>
                  <img src={c} alt="" />
                  <span className="look-tile__n">{i + 1}</span>
                  {picked === c && <span className="look-tile__check" aria-hidden><Icon name="check" size={14} /></span>}
                </button>
              ))}
            </div>
            <div className="cfg-row-actions">
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setCandidates([]); setPicked(null); }}>Clear</button>
              <button type="button" className="cfg-btn cfg-btn--primary" disabled={!picked || !!busy} onClick={() => picked && usePicture(picked)}>{busy === 'use' ? 'Saving…' : picked && candidates.length > 1 ? `Use option ${candidates.indexOf(picked) + 1}` : 'Use this one'}</button>
            </div>
          </>
        )}
        <div className="cfg-row-actions">
          <label className="cfg-btn cfg-btn--secondary">
            {busy === 'upload' ? 'Uploading…' : 'Upload a picture as it is'}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {hasPicture && <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel="Use the shape" onConfirm={() => run('shape', async () => putBot((await api.setPicture(bot.id, null)).bot))}>Back to the plain shape</ConfirmButton>}
        </div>
      </section>

      {hasPicture && bot.kind !== 'room' && (
        <section className="cfg-section">
          <div className="cfg-section__label">Poses</div>
          <div className="cfg-page__sub">
            {job?.state === 'making' ? `Making poses: ${job.done} of ${job.total}${job.failed ? `, ${job.failed} failed` : ''}…`
              : job?.state === 'stopped' ? `Stopped at ${job.done} of ${job.total}${job.error ? `: ${job.error}` : ''}`
              : job?.state === 'ready' ? `${Object.keys(poses).length} poses made from ${bot.name}'s picture${job.failed ? ` (${job.failed} could not be made${job.error ? `: ${job.error}` : ''})` : ''}.`
              : `No poses yet. ${bot.name} shows the picture as it is.`}
          </div>
          <div className="pose-grid">
            {AVATAR_POSES.map((p) => (
              <div key={p.id} className="pose-cell">
                <div className={`pose-cell__img${poses[p.id] ? '' : ' is-empty'}`}>
                  {poses[p.id] ? <img src={poses[p.id]} alt={p.label} /> : <span>{job?.state === 'making' ? '…' : '—'}</span>}
                </div>
                <div className="pose-cell__label">{p.label}</div>
                <button type="button" className="link-btn link-btn--small" disabled={job?.state === 'making' || !!busy} onClick={() => run(`pose:${p.id}`, () => api.remakePoses(bot.id, { poses: [p.id], note }))}>{poses[p.id] ? 'Redo' : 'Make'}</button>
              </div>
            ))}
          </div>
          <input className="text-input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder='Add to every pose (optional), e.g. "keep the hat on"' aria-label="Add to every pose" />
          <div className="cfg-row-actions">
            {Object.keys(poses).length > 0 && <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel="Stop using poses" onConfirm={() => run('nopose', () => api.removePoses(bot.id))}>Stop using poses</ConfirmButton>}
            <button type="button" className="cfg-btn cfg-btn--primary" disabled={job?.state === 'making' || !!busy} onClick={() => run('poses', () => api.remakePoses(bot.id, { note }))}>{Object.keys(poses).length ? 'Make all poses again' : 'Make poses'}</button>
          </div>
        </section>
      )}
      {error && <div className="cfg-error">{error}</div>}
    </div>
  );
}
