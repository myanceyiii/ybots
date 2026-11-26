import { useState } from 'react';
import { BotAvatar } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { useStore } from '../store';

export function SignIn() {
  const devLogin = useStore((s) => s.devLogin);
  const checkAuth = useStore((s) => s.checkAuth);
  const signIn = useStore((s) => s.signIn);
  const onAccessUrl = (() => { try { return !!signIn.accessUrl && new URL(signIn.accessUrl).origin === location.origin; } catch { return false; } })();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => (new URLSearchParams(location.search).get('login') === 'failed' ? 'Sign-in didn’t finish. Try again.' : null));

  // After the sign-in request, ask who we are. If that can't be answered, say so and let the person try
  // again (the button is never left busy).
  const finish = async (signInRequest: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try {
      await signInRequest();
      const outcome = await checkAuth();
      if (outcome === 'error') setError('Signed in, but the app couldn’t load your account. Check your connection and try again.');
      else if (outcome === 'signed-out') setError('Sign-in didn’t finish. Try again.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dev = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@')) { setError('Enter an email address'); return; }
    await finish(() => api.devLogin(email.trim(), name.trim() || undefined));
  };

  const continueWithAccess = () => finish(() => api.accessSignIn());

  return (
    <div className="signin">
      <div className="signin__card">
        <div className="signin__hero">
          <BotAvatar shape="blob" color="black" size={84} />
        </div>
        <h1 className="signin__title">YBots</h1>
        <p className="signin__sub">AI teammates with their own computers. Hand them a task and they get it done.</p>
        {signIn.accessReady ? (
          <div className="signin__actions">
            <button type="button" className="btn btn--primary" disabled={busy} onClick={continueWithAccess}>{busy ? 'Signing in…' : 'Continue'}</button>
          </div>
        ) : (
          <ol className="signin__steps">
            {signIn.accessUrl && !onAccessUrl && <li>Open <a href={signIn.accessUrl}>{signIn.accessUrl.replace(/^https?:\/\//, '')}</a> and you are signed in automatically.</li>}
            <li>Or, on a device that is already signed in, open your account menu and choose <b>Sign in another device</b>. Scan the code or open the link here.</li>
          </ol>
        )}
        {signIn.accessRefused && <div className="card__error signin__error">{signIn.accessRefused} is not on this app&rsquo;s allowed list. Ask the owner to add it.</div>}
        {devLogin && (
          <form className="signin__dev" onSubmit={dev}>
            <div className="signin__divider"><span>Dev sign-in</span></div>
            <input className="text-input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
            <input className="text-input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
            <button type="submit" className="btn btn--secondary" disabled={busy}>{busy ? 'Signing in…' : 'Continue with email'}</button>
          </form>
        )}
        {error && <div className="card__error signin__error">{error}</div>}
        <p className="signin__foot">Open source. Self-hosted fork of Bot HQ. Not affiliated with xAI.</p>
      </div>
    </div>
  );
}
