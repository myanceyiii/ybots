import qrcode from 'qrcode-generator';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { Modal } from './Modal';

/**
 * Sign in another device from this one: a one-time link (15 minutes, one use) for this account, as a
 * QR code for the phone app's camera, a link to copy, and an app link to tap on the phone itself.
 */
export function DeviceLinkModal() {
  const setModal = useStore((s) => s.setModal);
  const close = useCallback(() => setModal(null), [setModal]);
  const [link, setLink] = useState<{ url: string; appLink: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());

  const make = useCallback(async () => {
    setError(null); setCopied(false);
    try { setLink(await api.deviceLink()); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { make(); }, [make]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const svg = useMemo(() => {
    if (!link) return '';
    const qr = qrcode(0, 'M');
    qr.addData(link.url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [link]);

  const left = link ? Math.max(0, Math.round((link.expiresAt - now) / 1000)) : 0;
  const expired = !!link && left === 0;
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.url); setCopied(true); } catch { setError('Could not copy. Select the link and copy it instead.'); }
  };

  return (
    <Modal onClose={close} className="create-modal device-link" label="Sign in another device">
      <div className="modal__header">
        <div className="modal__title">Sign in another device</div>
        <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button>
      </div>
      <div className="create-modal__body device-link__body">
        <p className="device-link__lead">Scan this with the YBots phone app, or open the link on the other device. It works once and only for the next 15 minutes.</p>
        {link && !expired && <div className="device-link__qr" role="img" aria-label="Sign-in code" dangerouslySetInnerHTML={{ __html: svg }} />}
        {link && !expired && <input className="text-input device-link__url" readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} aria-label="Sign-in link" />}
        {link && !expired && <div className="device-link__meta">Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}. On the phone itself, <a href={link.appLink}>open it in the app</a>.</div>}
        {expired && <div className="device-link__meta">This link has expired.</div>}
        {error && <div className="card__error">{error}</div>}
      </div>
      <div className="modal__footer">
        <button type="button" className="btn btn--secondary btn--sm" onClick={make}>New link</button>
        <button type="button" className="btn btn--primary btn--sm" onClick={copy} disabled={!link || expired}>{copied ? 'Copied' : 'Copy link'}</button>
      </div>
    </Modal>
  );
}
