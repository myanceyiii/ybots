import { useEffect, useState } from 'react';
import { BotAvatar } from '../avatar/BotAvatar';
import { api } from '../lib/api';

/** The pairing id when this page was opened from a computer's sign-in QR code (/pair/<id>). */
export const pairIdFromPath = () => /^\/pair\/([A-Za-z0-9_-]{16,})$/.exec(location.pathname)?.[1] ?? null;

/**
 * "Sign in YBots on DESKTOP-ABC?" A computer shows a QR code for this page; the signed-in person
 * checks the short code matches the computer's screen and allows or denies it. Allowing signs that
 * computer in to this same account, once.
 */
export function PairApprove({ id }: { id: string }) {
  const [info, setInfo] = useState<{ code: string; device: string; kind?: 'sign-in' | 'machine'; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<'allowed' | 'denied' | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => { api.pairInfo(id).then(setInfo, (e) => setError((e as Error).message)); }, [id]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const machine = info?.kind === 'machine';
  const left = info ? Math.max(0, Math.round((info.expiresAt - now) / 1000)) : 0;
  const answer = async (allow: boolean) => {
    setBusy(true); setError(null);
    try { await api.pairAnswer(id, allow); setDone(allow ? 'allowed' : 'denied'); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  const back = () => { history.replaceState(null, '', '/'); location.reload(); };

  return (
    <div className="signin">
      <div className="signin__card">
        <div className="signin__hero"><BotAvatar shape="blob" color="black" size={84} /></div>
        {done === 'allowed' && machine && <><h1 className="signin__title">PC paired</h1><p className="signin__sub">Your Bots can now ask to work on {info?.device}. Choose which Bots under Settings › Your PCs. You can close this.</p></>}
        {done === 'denied' && machine && <><h1 className="signin__title">Not paired</h1><p className="signin__sub">{info?.device} was not paired.</p></>}
        {done === 'allowed' && !machine && <><h1 className="signin__title">Signed in</h1><p className="signin__sub">{info?.device} is now signed in to your account. You can close this.</p></>}
        {done === 'denied' && !machine && <><h1 className="signin__title">Not signed in</h1><p className="signin__sub">{info?.device} was not signed in.</p></>}
        {!done && info && left > 0 && machine && (
          <>
            <h1 className="signin__title">Let your Bots use {info.device}?</h1>
            <p className="signin__sub">Only allow this if the code below matches the one on that PC's screen right now. Bots can then ask to work in the folders shared on it. Anything that changes the PC still needs your OK on a card.</p>
            <div className="pair__code" aria-label="Code">{info.code}</div>
            <p className="signin__sub">Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</p>
            <div className="signin__actions pair__actions">
              <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => answer(false)}>Deny</button>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => answer(true)}>Allow</button>
            </div>
          </>
        )}
        {!done && info && left > 0 && !machine && (
          <>
            <h1 className="signin__title">Sign in YBots on {info.device}?</h1>
            <p className="signin__sub">Only allow this if the code below matches the one on that computer's screen right now.</p>
            <div className="pair__code" aria-label="Code">{info.code}</div>
            <p className="signin__sub">Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</p>
            <div className="signin__actions pair__actions">
              <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => answer(false)}>Deny</button>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => answer(true)}>Allow</button>
            </div>
          </>
        )}
        {!done && info && left === 0 && <><h1 className="signin__title">Code expired</h1><p className="signin__sub">Make a new code on the computer and scan it again.</p></>}
        {!done && !info && !error && <p className="signin__sub">Loading…</p>}
        {error && <p className="signin__sub card__error">{error}</p>}
        <div className="signin__actions"><button type="button" className="btn btn--secondary" onClick={back}>Back to YBots</button></div>
      </div>
    </div>
  );
}
