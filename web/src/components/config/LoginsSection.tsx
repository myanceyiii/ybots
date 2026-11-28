import { useEffect, useState, type ComponentType } from 'react';
import { api, type SavedLogin, type SavedLoginInput } from '../../lib/api';
import { relativeShort } from '../../lib/time';
import { ConfirmButton, Field, Switch } from './ui';

type Draft = { site: string; label: string; username: string; password: string; bots: string[] | null; connectorFirst: boolean | null };
const EMPTY: Draft = { site: '', label: '', username: '', password: '', bots: null, connectorFirst: null };

/**
 * Settings > Saved logins (server/src/vault.ts): a person's own logins, sealed on the server. A Bot asks to
 * use one on a card each time, and the server types it into the page; the Bot never sees it. There is no
 * "show password" here or anywhere: change it or delete it.
 */
export function LoginsSection({ PageHead }: { PageHead: ComponentType<{ title: string; sub?: string }> }) {
  const [logins, setLogins] = useState<SavedLogin[] | null>(null);
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const load = () => api.vaultLogins().then((r) => { setLogins(r.logins); setBots(r.bots); setError(null); }, (e) => setError((e as Error).message));
  useEffect(() => { load(); }, []);

  return (
    <>
      <PageHead title="Saved logins" sub="Save a site's login once. When a Bot reaches that site's sign-in page, it asks on a card, and the app types your login into the page. The Bot never sees it." />
      {error && <div className="cfg-error" role="alert">{error}</div>}
      <section className="cfg-section">
        <div className="cfg-card">
          {logins === null && !error && <div className="cfg-empty">Loading…</div>}
          {logins?.length === 0 && editing !== 'new' && <div className="cfg-empty">No saved logins yet. Add one here, or tick "Save to my logins" on a Bot's password card.</div>}
          {logins?.map((l) => (editing === l.id
            ? <LoginForm key={l.id} login={l} bots={bots} onDone={() => { setEditing(null); load(); }} />
            : (
              <div key={l.id} className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{l.label || l.site}{l.label ? <span className="cfg-row__sub"> · {l.site}</span> : null}</div>
                  <div className="cfg-row__sub">
                    {[l.userHint || (l.hasUsername ? 'Username saved' : 'No username'), l.hasPassword ? 'password saved' : 'no password',
                      l.bots === null ? 'all your Bots' : l.bots.length ? bots.filter((b) => l.bots!.includes(b.id)).map((b) => b.name).join(', ') : 'no Bot',
                      l.uses ? `used ${l.uses} time${l.uses === 1 ? '' : 's'}${l.lastUsedAt ? `, last ${relativeShort(l.lastUsedAt)}` : ''}` : 'not used yet'].join(' · ')}
                  </div>
                  {l.connectorFirst && <div className="cfg-row__sub">Mail, calendar or money site: Bots use a connected app here first.</div>}
                </div>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setEditing(l.id)}>Change</button>
                <ConfirmButton onConfirm={async () => { await api.deleteVaultLogin(l.id).catch((e) => setError((e as Error).message)); load(); }}>Delete</ConfirmButton>
              </div>
            )))}
          {editing === 'new' && <LoginForm bots={bots} onDone={() => { setEditing(null); load(); }} />}
        </div>
        {editing !== 'new' && <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => setEditing('new')}>Add a login</button>}
        <div className="cfg-field__hint">Kept encrypted on your server and seen only by you. Every use asks you on a card first, and a card can't be answered from a notification.</div>
      </section>
    </>
  );
}

function LoginForm({ login, bots, onDone }: { login?: SavedLogin; bots: { id: string; name: string }[]; onDone: () => void }) {
  const [d, setD] = useState<Draft>(() => (login ? { site: login.site, label: login.label, username: '', password: '', bots: login.bots, connectorFirst: login.connectorFirst } : EMPTY));
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const put = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body: SavedLoginInput = { site: d.site, label: d.label, bots: d.bots ?? 'all', ...(d.connectorFirst !== null ? { connectorFirst: d.connectorFirst } : {}),
        ...(d.username || !login ? { username: d.username } : {}), ...(d.password ? { password: d.password } : {}) };
      if (login) await api.updateVaultLogin(login.id, body); else await api.addVaultLogin(body);
      setD(EMPTY);
      onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const all = d.bots === null;
  return (
    <form className="cfg-editor" autoComplete="off" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <Field label="Site" htmlFor="vault-site" hint="The site's address, like example.com. It also fits the site's other pages, like login.example.com.">
        <input id="vault-site" className="text-input" value={d.site} onChange={(e) => put('site', e.target.value)} placeholder="example.com" autoCapitalize="off" spellCheck={false} />
      </Field>
      <Field label="Name (optional)" htmlFor="vault-label">
        <input id="vault-label" className="text-input" value={d.label} maxLength={60} onChange={(e) => put('label', e.target.value)} placeholder="Water bill" />
      </Field>
      <Field label="Username or email" htmlFor="vault-user" hint={login ? (login.hasUsername ? `Saved (${login.userHint}). Leave empty to keep it.` : 'None saved.') : undefined}>
        <input id="vault-user" className="text-input" value={d.username} onChange={(e) => put('username', e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} data-lpignore="true" data-1p-ignore data-form-type="other" maxLength={512} />
      </Field>
      <Field label="Password" htmlFor="vault-pass" hint={login?.hasPassword ? 'Saved. Leave empty to keep it.' : undefined}>
        <div className="browser-card__input">
          <input id="vault-pass" className="text-input" type={show ? 'text' : 'password'} value={d.password} onChange={(e) => put('password', e.target.value)} autoComplete="new-password" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-lpignore="true" data-1p-ignore data-form-type="other" maxLength={512} />
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
        </div>
      </Field>
      <div className="cfg-section__label">Bots that may ask to use it</div>
      <div className="cfg-row">
        <div className="cfg-row__text"><div className="cfg-row__title">All my Bots</div></div>
        <Switch label="All my Bots" on={all} onChange={(v) => put('bots', v ? null : bots.map((b) => b.id))} />
      </div>
      {!all && bots.map((b) => (
        <div key={b.id} className="cfg-row">
          <div className="cfg-row__text"><div className="cfg-row__title">{b.name}</div></div>
          <Switch label={`${b.name} may ask to use it`} on={d.bots!.includes(b.id)} onChange={(v) => put('bots', v ? [...d.bots!, b.id] : d.bots!.filter((x) => x !== b.id))} />
        </div>
      ))}
      <div className="cfg-row">
        <div className="cfg-row__text">
          <div className="cfg-row__title">Mail, calendar or money site</div>
          <div className="cfg-row__sub">Bots do this work through a connected app first and never switch to the browser when the app fails. The card warns you.</div>
        </div>
        <Switch label="Mail, calendar or money site" on={d.connectorFirst ?? false} onChange={(v) => put('connectorFirst', v)} />
      </div>
      {error && <div className="cfg-error" role="alert">{error}</div>}
      <div className="cfg-editor__actions">
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={onDone}>Cancel</button>
        <button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy || !d.site.trim() || (!login && !d.username.trim() && !d.password)}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}
