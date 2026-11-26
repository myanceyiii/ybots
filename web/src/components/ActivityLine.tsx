import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Bot, LiveState, Row } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { ModelBadge } from '../avatar/ModelBadge';
import { whoVars } from '../lib/colors';
import { activityPhrase, activityStatus, isWaitingForYou } from '../lib/phrases';
import { duration } from '../lib/time';

const CAPTION_FADE_MS = 320;
const EXPANDED_KEY = 'cleft.thinking.expanded';

/** Whether the person last chose to see the whole thought. Kept per browser, so it sticks across turns. */
function useExpanded(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(EXPANDED_KEY) === '1'; } catch { return false; } });
  const set = (v: boolean) => {
    setOpen(v);
    try { localStorage.setItem(EXPANDED_KEY, v ? '1' : '0'); } catch { /* private window: this session only */ }
  };
  return [open, set];
}

/** A small glowing bulb that sits beside the mascot while the bot is thinking. */
function IdeaBulb() {
  return (
    <svg className="thinking__idea" width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path className="thinking__idea-glass" d="M12 2.5a6.6 6.6 0 0 0-4.1 11.8c.7.55 1.1 1.3 1.1 2.1v.6h6v-.6c0-.8.4-1.55 1.1-2.1A6.6 6.6 0 0 0 12 2.5Z" />
      <path className="thinking__idea-base" d="M9.6 18.4h4.8a.8.8 0 0 1 0 1.6H9.6a.8.8 0 0 1 0-1.6Zm.9 2.5h3a.8.8 0 0 1 0 1.6h-3a.8.8 0 0 1 0-1.6Z" />
    </svg>
  );
}

/** One line of live reasoning. When the text changes, the old line fades out under the new one. */
function Caption({ text }: { text: string }) {
  const last = useRef(text);
  const [leaving, setLeaving] = useState<string | null>(null);
  useEffect(() => {
    const old = last.current;
    last.current = text;
    if (old === text) return;
    setLeaving(old);
    const t = setTimeout(() => setLeaving(null), CAPTION_FADE_MS);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <span className="thinking__caption">
      <span key={text} className="thinking__caption-line is-in">{text}</span>
      {leaving !== null && leaving !== text && <span key={`out:${leaving}`} className="thinking__caption-line is-out" aria-hidden>{leaving}</span>}
    </span>
  );
}

interface Props {
  bot: Bot;
  live: LiveState;
  rows: Row[];
  /** Step count to show beside the timer. Leave out when a steps chip above already shows it. */
  steps?: number;
}

/**
 * The live status block at the end of the transcript while a turn runs: the bot's mascot sitting on a
 * dark pill with its name and a pulsing status word, a short recap of what it is doing, and a running
 * timer. Tapping the recap shows the whole thought; tapping again goes back to the recap. Nothing is cut off. When the bot is waiting for the person, the pill reads "Needs you" and stops pulsing.
 */
export function ThinkingBlock({ bot, live, rows, steps = 0 }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const waiting = isWaitingForYou(live);
  const status = activityStatus(live, rows);
  const { width: pillWidth, measure } = useSteadyWidth(status, bot.name);
  const since = live.startedAt ?? live.activity?.since ?? live.awaiting?.since ?? now;
  const tick = Math.floor((now - (live.activity?.since ?? since)) / 6000);
  const [expanded, setExpanded] = useExpanded();
  const caption = waiting
    ? live.awaiting?.reason || 'Waiting for your answer'
    : live.caption?.trim() || activityPhrase(live, rows, tick);
  // The whole thought behind the short recap (server/src/caption.ts). Only then is there anything to expand.
  const full = !waiting && live.caption?.trim() ? live.captionFull?.trim() || null : null;
  const timer = waiting
    ? live.awaiting && now - live.awaiting.since >= 1000 ? `Waiting for ${duration(now - live.awaiting.since)}` : null
    : now - since >= 1000 ? `Working for ${duration(now - since)}` : null;

  return (
    <div className={`thinking${waiting ? ' is-waiting' : ''}`}>
      <div className="thinking__badge">
        <span className="thinking__mascot"><BotAvatarFor bot={bot} size={36} head badge /></span>
        {waiting ? <span className="thinking__alert" aria-hidden /> : <IdeaBulb />}
        <div className="thinking__pill" role="status" aria-live="polite" style={{ width: pillWidth }}>
          <span className="thinking__name">{bot.name}</span>
          <span className="thinking__status" key={status}>{status}</span>
          {/* Measures the name and status at full length, so the pill can size itself without jumping. */}
          <span ref={measure} className="thinking__measure" aria-hidden><span className="thinking__name">{bot.name}</span><span className="thinking__status">{status}</span></span>
        </div>
      </div>
      <div className="thinking__side">
        {full ? (
          <button type="button" className={`thinking__more${expanded ? ' is-open' : ''}`} aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)} title={expanded ? 'Show less' : 'Show the whole thought'}>
            {expanded ? <span className="thinking__full">{full}</span> : <Caption text={caption} />}
            <svg className="thinking__chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        ) : <Caption text={caption} />}
        {(timer || steps > 0) && (
          <span className="thinking__meta">
            {timer}
            {timer && steps > 0 && ' · '}
            {steps > 0 && `${steps} ${steps === 1 ? 'step' : 'steps'}`}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The thinking pill's width for this turn. It starts wide enough for every fixed status word, only ever
 * grows (smoothly, in CSS) when a longer one like "Checking with Leonard" comes along, and never shrinks
 * back while the turn runs, so the pill does not jump between sizes as the status changes.
 */
const PILL_MIN = 156;
const PILL_MAX = 260;
const PILL_PAD = 32;
function useSteadyWidth(status: string, name: string): { width: number; measure: React.RefObject<HTMLSpanElement> } {
  const [width, setWidth] = useState(PILL_MIN);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let need = 0;
    for (const c of Array.from(el.children)) need = Math.max(need, Math.ceil((c as HTMLElement).scrollWidth));
    const next = Math.min(PILL_MAX, Math.max(PILL_MIN, need + PILL_PAD));
    setWidth((w) => (next > w ? next : w));
  }, [status, name]);
  return { width, measure: ref };
}

/** Kept for existing importers: the activity line is now the thinking block. */
export const ActivityLine = ThinkingBlock;

const MEMBER_STATE: Record<'queued' | 'working' | 'waiting', string> = { queued: 'Up next', working: 'Working', waiting: 'Needs you' };

/**
 * A group chat's live block: one line per member answering the group's messages right now
 * (server/src/agent/room-runs.ts), each with its own Stop. The composer's Stop stops them all.
 */
export function GroupWorking({ bot, live, bots, onStop }: { bot: Bot; live: LiveState; bots: Bot[]; onStop: (memberId: string) => Promise<unknown> }) {
  const [now, setNow] = useState(Date.now());
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const members = live.members ?? [];
  if (!members.length) return null;
  const stop = (id: string) => {
    setStopping((s) => ({ ...s, [id]: true }));
    onStop(id).catch(() => {}).finally(() => setStopping((s) => ({ ...s, [id]: false })));
  };
  return (
    <div className="group-working" role="status" aria-live="polite" aria-label={`${bot.name}: members answering`}>
      {members.map((m) => {
        const member = bots.find((b) => b.id === m.id);
        return (
          <div key={m.id} className={`group-working__row is-${m.state}${member?.chatColor ? ' is-from-bot' : ''}`} style={member?.chatColor ? whoVars(member.chatColor) : undefined}>
            {member ? <BotAvatarFor bot={member} size={24} head /> : <span className="group-working__dot" />}
            <span className="group-working__name">{m.name}</span>
            {m.model && m.state === 'working' && <ModelBadge model={m.model} size={24} inline />}
            <span className="group-working__state">{MEMBER_STATE[m.state]}</span>
            {m.state !== 'queued' && now - m.since >= 1000 && <span className="group-working__time">{duration(now - m.since)}</span>}
            <button type="button" className="group-working__stop" disabled={!!stopping[m.id]} onClick={() => stop(m.id)} aria-label={`Stop ${m.name}`} title={`Stop ${m.name}`}>
              {stopping[m.id] ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
