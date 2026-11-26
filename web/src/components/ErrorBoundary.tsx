/**
 * Something on the page failed to draw. Without this the whole app goes blank (on the web and in the
 * Windows app) and stays blank until it is reloaded by hand. With it the app says what happened in plain
 * words and offers Try again, Reload and Copy details (the same screen as the Android app's ErrorBoundary).
 */
import { Component, type ReactNode } from 'react';

interface State { error: Error | null; stack: string; copied: boolean; tries: number }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, stack: '', copied: false, tries: 0 };
  static getDerivedStateFromError(error: Error): Partial<State> { return { error }; }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    this.setState({ stack: (info?.componentStack ?? '').trim().split('\n').slice(0, 8).join('\n') });
    console.error('The app failed to draw', error);
  }
  render() {
    const { error, stack, copied, tries } = this.state;
    if (!error) return this.props.children;
    const details = `${new Date().toISOString()} ${location.pathname}\n${error.message}\n${stack || (error.stack ?? '').split('\n').slice(0, 6).join('\n')}`;
    const copy = () => { navigator.clipboard?.writeText(details).then(() => this.setState({ copied: true }), () => {}); };
    return (
      <div role="alert" style={{ height: '100%', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 28, textAlign: 'center', background: 'var(--color-bg-chrome)', color: 'var(--color-text-primary)' }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>The app ran into a problem</h1>
        <p style={{ margin: 0, maxWidth: 420, color: 'var(--color-text-secondary)' }}>
          {tries > 0 ? 'It failed again. Reload the app; your chats and anything you have not sent are safe.' : 'Nothing was lost. Your chats and anything you have not sent are safe.'}
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 6 }}>
          <button type="button" className="btn btn--primary" onClick={() => this.setState({ error: null, stack: '', copied: false, tries: tries + 1 })}>Try again</button>
          <button type="button" className="btn" onClick={() => location.reload()}>Reload</button>
          <button type="button" className="btn" onClick={copy}>{copied ? 'Copied' : 'Copy details'}</button>
        </div>
        <p style={{ margin: 0, maxWidth: 520, fontSize: 12.5, color: 'var(--color-text-tertiary)', overflowWrap: 'anywhere' }}>{error.message || 'Unknown error'}</p>
      </div>
    );
  }
}
