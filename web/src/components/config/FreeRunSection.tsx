import { useCallback, useEffect, useState } from 'react';
import { configApi, type FreeRunBot } from '../../lib/configApi';
import { Switch } from './ui';

/**
 * The owner's master switch for the maintainer bot (Howard): run every terminal command without a card
 * (server/src/maintainer-guard.ts, "free-run"). Shown in Settings › Permissions and in that bot's settings.
 * Renders nothing for a bot that is not the maintainer.
 */
export function FreeRunSection({ botId, compact }: { botId?: string; compact?: boolean }) {
  const [bots, setBots] = useState<FreeRunBot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    configApi.allowRules(botId).then((r) => setBots(r.freeRun ?? [])).catch(() => setBots([]));
  }, [botId]);
  useEffect(() => { load(); }, [load]);
  if (!bots?.length) return null;
  const flip = async (b: FreeRunBot, on: boolean) => {
    setError(null);
    setBots((all) => all?.map((x) => (x.botId === b.botId ? { ...x, on } : x)) ?? null);
    try { await configApi.setFreeTerminal(b.botId, on); } catch (e) { setError((e as Error).message); }
    load();
  };
  return (
    <section className="cfg-section">
      {!compact && <div className="cfg-section__label">Terminal commands</div>}
      <div className="cfg-card">
        {bots.map((b) => (
          <div key={b.botId} className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{compact ? 'Run terminal commands without asking' : `${b.botName} runs terminal commands without asking`}</div>
              <div className="cfg-row__sub">{b.on
                ? `On: every command ${b.botName} runs, sudo and deploys included, goes ahead with no card. Each one is listed under “Recently allowed without asking” and in the maintainer log. Output from secret files (.env, keys, tokens) is hidden. Anything touching Sheldon's firm data still asks.`
                : `Off: ${b.botName} asks on a card before commands that change things. Looking around (status, logs, listings) still runs without asking.`}
                {!b.canChange && ' Only the owner of this server can change this.'}</div>
            </div>
            <Switch on={b.on} onChange={(v) => void flip(b, v)} label={`${b.botName} runs terminal commands without asking`} disabled={!b.canChange} />
          </div>
        ))}
      </div>
      {error && <div className="cfg-error">{error}</div>}
    </section>
  );
}
