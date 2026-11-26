import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { pluginsApi, type DraftFiles } from '../../lib/pluginsApi';
import { Icon } from '../Icon';

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/**
 * The code a Bot wrote for a plugin, exactly as the server checked it, for the owner to read before
 * pressing Install. Read only: nothing here changes or installs anything. Same view in the web app
 * and the Windows app (which shows this web app); the Android app has its own screen.
 */
export function PluginCode({ draftId, onClose }: { draftId: string; onClose: () => void }) {
  const [data, setData] = useState<DraftFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => {
    pluginsApi.draftFiles(draftId).then((d) => { setData(d); setFile(d.files.find((f) => f.path === 'index.mjs')?.path ?? d.files[0]?.path ?? null); }).catch((e) => setError((e as Error).message));
  }, [draftId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  const shown = data?.files.find((f) => f.path === file);
  return createPortal(
    <div className="modal-root">
      <div className="modal-scrim" onClick={onClose} />
      <div className="modal plugin-code" role="dialog" aria-modal="true" aria-label="Plugin code">
        <div className="modal__header">
          <div>
            <div className="modal__title">{data ? `${data.title}: the code` : 'The code'}</div>
            {data?.digest && (
              <div className="plugin-code__sub">
                Fingerprint <code>{data.digest.slice(0, 16)}</code> · {data.matches ? 'matches the review card' : 'does NOT match the review card; do not install'}
              </div>
            )}
            {data && !data.digest && <div className="plugin-code__sub">Not ready for review yet ({data.status}).</div>}
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close"><Icon name="close" opacity={0.7} /></button>
        </div>
        {error && <div className="cfg-error" role="alert" style={{ margin: 16 }}>{error}</div>}
        {!data && !error && <div className="plugin-code__sub" style={{ padding: 16 }}>Loading…</div>}
        {data && !data.files.length && <div className="plugin-code__sub" style={{ padding: 16 }}>The Bot hasn't sent any files yet.</div>}
        {data && data.files.length > 0 && (
          <div className="plugin-code__body">
            <nav className="plugin-code__files" aria-label="Files">
              {data.files.map((f) => (
                <button key={f.path} type="button" className={`plugin-code__file${f.path === file ? ' is-active' : ''}`} onClick={() => setFile(f.path)} aria-current={f.path === file || undefined}>
                  <span>{f.path}</span><span className="plugin-code__size">{f.kit ? 'server kit' : kb(f.size)}</span>
                </button>
              ))}
            </nav>
            <div className="plugin-code__view">
              {shown?.kit ? (
                <p className="plugin-code__sub">This is YBots's own plugin kit. The server adds the same file to every made plugin; the Bot didn't write it.</p>
              ) : shown?.text === null ? (
                <p className="plugin-code__sub">Too large to show here ({kb(shown.size)}).</p>
              ) : (
                <pre className="plugin-code__pre"><code>{shown?.text}</code></pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
