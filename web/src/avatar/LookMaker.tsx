import { useEffect, useRef, useState } from 'react';
import type { Bot } from '@shared/types';
import { api, type LooksOptions } from '../lib/api';

let optionsOnce: Promise<LooksOptions> | null = null;
/** Styles, poses and limits from the server (cached for the page's life). */
export function useLooksOptions(): LooksOptions | null {
  const [o, setO] = useState<LooksOptions | null>(null);
  useEffect(() => {
    optionsOnce ??= api.looksOptions().catch((e) => { optionsOnce = null; throw e; });
    optionsOnce.then(setO).catch(() => {});
  }, []);
  return o;
}

/** A picked file as a JPEG data URL no bigger than `side` pixels (the server takes 2 MB at most). */
export async function fileToDataUrl(file: File, side = 1024): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error('That file is not a picture this browser can read.')); i.src = url; });
    const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const g = c.getContext('2d')!;
    g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.88);
  } finally { URL.revokeObjectURL(url); }
}

export interface LookAsk { description: string; intent: 'new' | 'tweak'; style: string | null; count: number; reference: string | null }


/**
 * The "what should it look like" form: description, keep-or-start-over, style, how many pictures,
 * and an optional picture to start from. Used in a bot's settings and on a look card's "More options".
 */
export function LookMaker({ bot, initial, submitLabel, busy, onSubmit, compact }: {
  bot: Pick<Bot, 'name' | 'avatarImageUrl'>;
  initial?: Partial<LookAsk>;
  submitLabel: string;
  busy?: boolean;
  compact?: boolean;
  onSubmit: (a: LookAsk) => void;
}) {
  const opts = useLooksOptions();
  const canTweak = !!bot.avatarImageUrl;
  const [description, setDescription] = useState(initial?.description ?? '');
  const [intent, setIntent] = useState<'new' | 'tweak'>(initial?.intent === 'tweak' && canTweak ? 'tweak' : 'new');
  const [style, setStyle] = useState<string | null>(initial?.style ?? null);
  const count = 3; // always 3 (server/src/avatars.ts LOOK_COUNT)
  const [reference, setReference] = useState<string | null>(initial?.reference ?? null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setFileError(null);
    try { setReference(await fileToDataUrl(f)); } catch (e) { setFileError((e as Error).message); }
  };
  const ok = description.trim().length > 0 && !busy;

  return (
    <form className={`look-maker${compact ? ' is-compact' : ''}`} onSubmit={(e) => { e.preventDefault(); if (ok) onSubmit({ description: description.trim(), intent, style, count, reference }); }}>
      {canTweak && (
        <div className="look-maker__seg" role="radiogroup" aria-label="Keep or start over">
          {([['tweak', `Change ${bot.name}'s current look`], ['new', 'A whole new look']] as const).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={intent === v} className={intent === v ? 'is-active' : ''} onClick={() => setIntent(v)}>{label}</button>
          ))}
        </div>
      )}
      <textarea
        className="text-input look-maker__desc"
        rows={compact ? 2 : 3}
        maxLength={1000}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={intent === 'tweak' ? 'What to change, e.g. "add round sunglasses and a red scarf"' : 'Describe the character, e.g. "a cheerful fox in a green hoodie"'}
        aria-label="Describe the look"
      />
      <div className="look-maker__row">
        <span className="look-maker__label">Style</span>
        <div className="look-maker__chips" role="radiogroup" aria-label="Style">
          <button type="button" role="radio" aria-checked={style === null} className={`look-chip${style === null ? ' is-on' : ''}`} onClick={() => setStyle(null)}>{intent === 'tweak' ? 'Keep it' : 'Any'}</button>
          {(opts?.styles ?? []).map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={style === s.id} className={`look-chip${style === s.id ? ' is-on' : ''}`} onClick={() => setStyle(s.id)}>{s.label}</button>
          ))}
        </div>
      </div>
      <div className="look-maker__row">
        <span className="look-maker__label">Start from</span>
        <div className="look-maker__ref">
          {reference ? (
            <>
              <img src={reference} alt="Starting picture" className="look-maker__thumb" />
              <button type="button" className="link-btn link-btn--small" onClick={() => setReference(null)}>Remove</button>
            </>
          ) : (
            <button type="button" className="link-btn link-btn--small" onClick={() => fileRef.current?.click()}>
              {intent === 'tweak' ? `${bot.name}'s current picture (or upload another)` : 'Upload a drawing or photo (optional)'}
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
      </div>
      {fileError && <div className="card__error">{fileError}</div>}
      <div className="look-maker__actions">
        <button type="submit" className="btn btn--primary btn--sm" disabled={!ok}>{busy ? 'Drawing…' : submitLabel}</button>
      </div>
    </form>
  );
}
