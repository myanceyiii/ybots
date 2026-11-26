import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import type RFBType from '@novnc/novnc';
import type { Machine, MachineLogEntry } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { api } from '../../lib/api';
import { relativeShort } from '../../lib/time';
import { useStore } from '../../store';
import { ConfirmButton, Switch } from './ui';
import { ClipButtons, ClipOverlay } from '../ClipboardControls';
import { useRemoteClipboard } from '../../lib/remoteClipboard';

/**
 * Your PCs (docs/remote-pc.md): computers paired through the YBots Windows app. Shows whether
 * each is online, what it shares, which bots may use it, its screen (watch only) and what happened on
 * it, and taking control of its mouse and keyboard. What a PC allows (folders, commands, screen,
 * control) is set on the PC itself; only the bots list and
 * Remove are set here. Bots on the block list can never be switched on.
 */
export function PcsSection({ PageHead }: { PageHead: ComponentType<{ title: string; sub?: string }> }) {
  const version = useStore((s) => s.machinesVersion);
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api.machines().then((r) => setMachines(r.machines), (e) => setError((e as Error).message)); }, []);
  useEffect(() => { load(); }, [load, version]);

  return (
    <>
      <PageHead title="Your PCs" sub="PCs where the YBots Windows app lets your Bots work. Anything that changes a PC needs your OK on a card, every time." />
      {error && <div className="cfg-error">{error}</div>}
      <PairByCode />
      {!machines ? <div className="cfg-empty">Loading…</div> : machines.length === 0 ? (
        <section className="cfg-section">
          <div className="cfg-card">
            <div className="cfg-empty cfg-empty--flat">
              No PC is paired yet. On the PC, open YBots and choose <b>File › Let YBots use this PC…</b>, then scan its code with your phone.
            </div>
          </div>
        </section>
      ) : machines.map((m) => <PcCard key={m.id} machine={m} onChange={load} />)}
    </>
  );
}

function PcCard({ machine: m, onChange }: { machine: Machine; onChange: () => void }) {
  const bots = useStore((s) => s.bots).filter((b) => b.kind !== 'room');
  const [watching, setWatching] = useState<null | 'watch' | 'control'>(null);
  const [log, setLog] = useState<MachineLogEntry[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const seen = m.online ? 'Online' : m.lastSeenAt ? `Offline · seen ${relativeShort(m.lastSeenAt)}${/^\d/.test(relativeShort(m.lastSeenAt)) ? ' ago' : ''}` : 'Offline · never connected';

  const setBot = async (botId: string, on: boolean) => {
    setNote(null);
    const next = on ? [...m.bots, botId] : m.bots.filter((b) => b !== botId);
    try { await api.setMachineBots(m.id, next); onChange(); } catch (e) { setNote((e as Error).message); }
  };

  return (
    <section className="cfg-section">
      <div className="cfg-section__label">{m.name}</div>
      <div className="cfg-card">
        <div className="cfg-row">
          <span className={`computer-status-dot is-${m.online ? 'on' : 'off'}`} aria-hidden />
          <div className="cfg-row__text">
            <div className="cfg-row__title">{m.name} · {seen}</div>
            <div className="cfg-row__sub">
              {m.online ? `Commands ${m.commands ? 'allowed' : 'off'} · Screen viewing ${m.screen ? 'allowed' : 'off'} · Taking control ${m.control ? 'allowed' : 'off'} · Copy and paste ${m.clipboard ? 'allowed' : 'off'} · set on the PC` : 'Turn it on in the YBots app on that PC.'}
            </div>
          </div>
          {watching ? (
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setWatching(null)}>{watching === 'control' ? 'Hand back' : 'Stop watching'}</button>
          ) : (
            <>
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!m.online || !m.screen} title={m.screen ? undefined : 'Screen viewing is off on this PC'} onClick={() => setWatching('watch')}>Watch screen</button>
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!m.online || !m.control} title={m.control ? undefined : 'Taking control is off on this PC'} onClick={() => setWatching('control')}>Take control</button>
            </>
          )}
        </div>
        {watching && m.online && <PcScreen key={watching} machineId={m.id} name={m.name} clipboard={m.clipboard} mode={watching} onClosed={() => setWatching(null)} />}
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Shared folders</div>
            <div className="cfg-row__sub">{m.folders.length ? m.folders.map((f) => f.path).join(' · ') : m.online ? 'None shared yet. Share folders in the app on the PC.' : 'Shown while the PC is online.'}</div>
          </div>
        </div>
      </div>

      <div className="cfg-section__label">Bots that may use {m.name}</div>
      <div className="cfg-card">
        {bots.map((b) => {
          const blocked = m.blockedBots.includes(b.id) || m.pcBlocked.some((n) => n.toLowerCase() === b.name.toLowerCase());
          return (
            <div key={b.id} className="cfg-row">
              <BotAvatarFor bot={b} size={28} still />
              <div className="cfg-row__text">
                <div className="cfg-row__title">{b.name}</div>
                {blocked && <div className="cfg-row__sub">Can never use a PC.</div>}
              </div>
              <Switch label={`${b.name} may use ${m.name}`} on={!blocked && m.bots.includes(b.id)} disabled={blocked} onChange={(v) => setBot(b.id, v)} />
            </div>
          );
        })}
        {note && <div className="cfg-error cfg-error--inset">{note}</div>}
      </div>

      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Activity</div>
            <div className="cfg-row__sub">Everything Bots asked to do on this PC, allowed or not.</div>
          </div>
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => (log ? setLog(null) : api.machineLog(m.id).then((r) => setLog(r.log), () => setLog([])))}>{log ? 'Hide' : 'Show'}</button>
        </div>
        {log && (log.length ? log.slice(0, 30).map((l) => (
          <div key={l.id} className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{l.botName ?? 'You'} · {l.tool.replace(/^pc_/, '').replace(/_/g, ' ')} · {l.outcome}</div>
              <div className="cfg-row__sub">{new Date(l.at).toLocaleString()}{l.detail ? ` · ${l.detail}` : ''}</div>
            </div>
          </div>
        )) : <div className="cfg-empty cfg-empty--flat">Nothing yet.</div>)}
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Remove this PC</div>
            <div className="cfg-row__sub">Its key stops working at once. Pair it again from the PC to use it later.</div>
          </div>
          <ConfirmButton confirmLabel="Remove" onConfirm={async () => { await api.removeMachine(m.id); onChange(); }}>Remove</ConfirmButton>
        </div>
      </div>
    </section>
  );
}

/** A paired PC's screen over our relay: watched, or with mode 'control' driven with this mouse and keyboard. */
function PcScreen({ machineId, name, clipboard, mode, onClosed }: { machineId: string; name: string; clipboard: boolean; mode: 'watch' | 'control'; onClosed: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFBType | null>(null);
  const [state, setState] = useState<'connecting' | 'live' | 'closed'>('connecting');
  const [reason, setReason] = useState<string | null>(null);
  // Copy and paste only with the PC's own switch on, while you have control (the PC and server check again).
  const getRfb = useCallback(() => rfbRef.current, []);
  const clipTarget = useMemo(() => ({ kind: 'pc' as const, id: machineId }), [machineId]);
  const clipOn = mode === 'control' && clipboard && state === 'live';
  const clip = useRemoteClipboard(clipTarget, getRfb, name, clipOn, box);
  useEffect(() => {
    let rfb: RFBType | null = null;
    let disposed = false;
    (async () => {
      const { default: RFB } = await import('@novnc/novnc');
      if (disposed || !ref.current) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      rfb = new RFB(ref.current, `${proto}://${location.host}/api/machines/${machineId}/screen?mode=${mode}`, { shared: true });
      rfb.viewOnly = mode !== 'control';
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = 'transparent';
      rfb.qualityLevel = 6;
      rfbRef.current = rfb;
      rfb.addEventListener('connect', () => { if (!disposed) setState('live'); });
      rfb.addEventListener('disconnect', () => { if (!disposed) { setState('closed'); setReason(mode === 'control' ? 'Control ended. The person at the PC may have pressed Stop or turned taking control off.' : 'The screen closed. The person at the PC may have pressed Stop or turned viewing off.'); } });
    })().catch((e) => { if (!disposed) { setState('closed'); setReason(String(e?.message ?? e)); } });
    const el = ref.current;
    return () => { disposed = true; rfbRef.current = null; try { rfb?.disconnect(); } catch { /* */ } if (el) el.innerHTML = ''; };
  }, [machineId, mode]);
  return (
    <div className="pc-screen" ref={box}>
      <div className="pc-screen__stage">
        <div ref={ref} className="pc-screen__canvas" />
        {clipOn && <ClipOverlay clip={clip} name={name} />}
      </div>
      {clipOn && (
        <div className="pc-screen__clip" role="toolbar" aria-label="Copy and paste">
          <span className="pc-screen__clip-on">Copy and paste on</span>
          <ClipButtons clip={clip} name={name} className="cfg-btn cfg-btn--secondary pc-screen__clip-btn" withText />
        </div>
      )}
      {state !== 'live' && <div className="pc-screen__note">{state === 'connecting' ? 'Connecting to the PC…' : reason}</div>}
      {state === 'closed' && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onClosed}>Close</button>}
      <div className="cfg-row__sub">{mode === 'control' ? `You have the mouse and keyboard. Click the picture first to type.${clipboard ? ' Ctrl+V pastes from this device; Ctrl+C there also copies to this device.' : ' Copy and paste is off; turn it on in the YBots app on the PC.'} A bar on the PC says so, with a Stop button. Ctrl+Alt+Del and the Windows admin prompt can't be reached this way.` : 'Watching only. A bar on the PC shows that you\'re watching, with a Stop button.'}</div>
    </div>
  );
}

/** Pair a PC by the short code its YBots app shows; opens the same Allow/Deny page as its QR code. */
function PairByCode() {
  const [code, setCode] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const go = async () => {
    setNote(null);
    try { const p = await api.pairByCode(code); location.assign(`/pair/${p.id}`); } catch (e) { setNote((e as Error).message); }
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Pair a PC</div>
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Type the code the PC shows</div>
            <div className="cfg-row__sub">On the PC: File › Let YBots use this PC…, then Pair this PC. Or scan its QR code with your phone.</div>
          </div>
          <input className="text-input" style={{ maxWidth: 120 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABC-123" maxLength={8} aria-label="Pairing code" />
          <button type="button" className="cfg-btn cfg-btn--primary" disabled={code.replace(/[^A-Za-z0-9]/g, '').length !== 6} onClick={go}>Continue</button>
        </div>
        {note && <div className="cfg-error cfg-error--inset">{note}</div>}
      </div>
    </section>
  );
}
