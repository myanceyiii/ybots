import { useEffect, useState } from 'react';
import type { VoiceOption } from '@shared/types';
import type { Bot } from '@shared/types';
import { useStore } from '../store';
import { voiceApi, type VoiceOptions } from '../voice/api';
import { endCall, isCallActive, onSampleChange, playSample, startCall, stopSample, useVoice } from '../voice/call';
import { Icon } from './Icon';

const FALLBACK: VoiceOptions = {
  voices: [['af_heart', 'Heart'], ['af_bella', 'Bella'], ['am_michael', 'Michael'], ['am_adam', 'Adam']].map(([id, name]) => ({ id, name })),
  defaultVoice: 'af_heart',
  languages: [{ code: 'auto', name: 'Auto-detect' }, { code: 'en', name: 'English' }],
  speeds: [0.7, 0.85, 1, 1.15, 1.3, 1.5],
};

const speedLabel = (s: number) => `${Number(s.toFixed(2))}x`;

function NativeSelect<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const current = options.find((o) => o.value === value)?.label ?? String(value);
  return (
    <span className="mini-select mini-select--native">
      <span>{current}</span>
      <Icon name="chev_down" size={10} opacity={0.66} />
      <select
        aria-label={label}
        value={String(value)}
        onChange={(e) => {
          const o = options.find((x) => String(x.value) === e.target.value);
          if (o) onChange(o.value);
        }}
      >
        {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
    </span>
  );
}

/** Voices under their headings ("American English", "British English", ...), in the server's order. */
function grouped(voices: VoiceOption[]): { group: string; voices: VoiceOption[] }[] {
  const out: { group: string; voices: VoiceOption[] }[] = [];
  for (const v of voices) {
    const g = v.group ?? 'Voices';
    const at = out.find((x) => x.group === g);
    if (at) at.voices.push(v); else out.push({ group: g, voices: [v] });
  }
  return out;
}

function PlayButton({ playing, label, onClick }: { playing: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={`voice-play${playing ? ' is-playing' : ''}`} onClick={onClick} aria-label={playing ? 'Stop' : label} title={playing ? 'Stop' : label}>
      <Icon name={playing ? 'stop' : 'play'} size={playing ? 9 : 10} />
    </button>
  );
}

/** "Voice chat" section of the details panel: voice (each with a sample to play), speed, language (saved per bot), start a call. */
export function VoiceSettings({ bot }: { bot: Bot }) {
  const [opts, setOpts] = useState<VoiceOptions>(FALLBACK);
  const [playing, setPlaying] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);

  useEffect(() => { voiceApi.options().then(setOpts).catch(() => {}); }, []);
  useEffect(() => onSampleChange(setPlaying), []);
  useEffect(() => { setError(null); setOpen(false); }, [bot.id]);
  useEffect(() => () => stopSample(), []);

  const save = async (patch: Partial<Pick<Bot, 'voice' | 'voiceSpeed' | 'voiceLanguage'>>) => {
    const prev = useStore.getState().bots.find((b) => b.id === bot.id);
    // Optimistic; the server's `bot` event confirms.
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, ...patch } : b)) }));
    setError(null);
    try {
      const res = await fetch(`/api/bots/${bot.id}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      if (prev) useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, voice: prev.voice, voiceSpeed: prev.voiceSpeed, voiceLanguage: prev.voiceLanguage } : b)) }));
      setError('Couldn’t save that setting.');
    }
  };

  /** Samples in the list play at normal speed (ready ahead of time); the one next to the chosen voice at the bot's speed. */
  const play = (voice: string, speed = 1) => {
    setError(null);
    playSample(voice, speed).catch((e) => setError((e as Error).message || 'Preview unavailable'));
  };

  // A voice the speech server does not have (e.g. one from the old xAI voice) is spoken with the default.
  const voiceId = opts.voices.some((v) => v.id === bot.voice) ? bot.voice : opts.defaultVoice ?? opts.voices[0]?.id ?? bot.voice;
  const voices = opts.voices.some((v) => v.id === voiceId) ? opts.voices : [{ id: voiceId, name: voiceId }, ...opts.voices];
  const current = voices.find((v) => v.id === voiceId);
  const speeds = opts.speeds.includes(bot.voiceSpeed) ? opts.speeds : [...opts.speeds, bot.voiceSpeed].sort((a, b) => a - b);

  return (
    <div className="panel-card">
      <div className="panel-row panel-row--setting">
        <span>Voice</span>
        <span className="voice-setting__right">
          <PlayButton playing={playing === voiceId} label={`Hear ${bot.name}’s voice`} onClick={() => play(voiceId, bot.voiceSpeed)} />
          <button type="button" className="mini-select mini-select--button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <span>{current?.name ?? voiceId}</span>
            <Icon name="chev_down" size={10} opacity={0.66} style={open ? { transform: 'rotate(180deg)' } : undefined} />
          </button>
        </span>
      </div>
      {open && (
        <div className="voice-list" role="listbox" aria-label="Voices">
          {grouped(voices).map(({ group, voices: vs }) => (
            <div key={group} className="voice-list__group">
              <div className="voice-list__heading">{group}</div>
              {vs.map((v) => (
                <div key={v.id} className={`voice-list__row${v.id === voiceId ? ' is-selected' : ''}`}>
                  <PlayButton playing={playing === v.id} label={`Play ${v.name}`} onClick={() => play(v.id)} />
                  <button type="button" role="option" aria-selected={v.id === voiceId} className="voice-list__pick" onClick={() => save({ voice: v.id })}>
                    <span className="voice-list__name">{v.name.replace(/\s*\(.*\)$/, '')}</span>
                    {v.gender && <span className="voice-list__meta">{v.gender}</span>}
                    {v.id === voiceId && <Icon name="check" size={12} />}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {/* A voice with one pace (Phonon) has no Speed setting: the server offers only 1x. */}
      {opts.speeds.length > 1 && (
        <div className="panel-row panel-row--setting">
          <span>Speed</span>
          <NativeSelect label="Speed" value={bot.voiceSpeed} options={speeds.map((s) => ({ value: s, label: speedLabel(s) }))} onChange={(voiceSpeed) => save({ voiceSpeed })} />
        </div>
      )}
      <div className="panel-row panel-row--setting">
        <span>Language</span>
        <NativeSelect label="Language" value={bot.voiceLanguage} options={opts.languages.map((l) => ({ value: l.code, label: l.name }))} onChange={(voiceLanguage) => save({ voiceLanguage })} />
      </div>
      <button type="button" className={`panel-row panel-row--action panel-row--call${inCall ? ' is-active' : ''}`} onClick={() => (inCall ? endCall() : startCall(bot.id))}>
        <Icon name="voice_a" size={14} opacity={inCall ? 1 : 0.56} /> {inCall ? 'End voice chat' : 'Start voice chat'}
      </button>
      {error && <div className="voice-error">{error}</div>}
    </div>
  );
}
