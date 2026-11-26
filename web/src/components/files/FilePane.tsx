import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Download, ExternalLink, File, FileCode, FileImage, FileSpreadsheet, FileText, Folder, NotebookPen, Pencil, Plus, Presentation, type LucideIcon } from 'lucide-react';
import type { Bot, ChatFile, ChatFileEntry, FileKind, FilePreview, LibraryFile } from '@shared/types';
import { configApi, type LibraryListing } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { useSelectedBot, useStore } from '../../store';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';
import { formatBytes } from '../config/ui';
import { PageViewer } from './PageView';

/**
 * The file pane: what the bot made in this chat and everything in its workspace on the bots' computer,
 * with previews made on that computer (server/src/files.ts). It takes the details panel's place on the
 * right; on a phone-sized window it is a full-screen sheet (styles/files.css). The Windows app shows
 * this same page, and the Android app has the same screens (mobile/src/screens/Files.tsx).
 */

const KIND_ICON: Record<FileKind, LucideIcon> = {
  markdown: FileText, text: FileText, code: FileCode, table: FileSpreadsheet, sheet: FileSpreadsheet,
  image: FileImage, pdf: FileText, office: FileText, page: NotebookPen, other: File,
};
export function fileIcon(f: { kind: FileKind; name: string }): LucideIcon {
  if (f.kind === 'office' && /\.(pptx?|odp)$/i.test(f.name)) return Presentation;
  return KIND_ICON[f.kind] ?? File;
}
export function FileGlyph({ file, size = 16, style }: { file: { kind: FileKind; name: string }; size?: number; style?: CSSProperties }) {
  const I = fileIcon(file);
  return <I aria-hidden size={size} strokeWidth={1.9} style={{ flexShrink: 0, ...style }} />;
}

const kindLabel = (f: { kind: FileKind; name: string }) => {
  if (f.kind === 'page') return 'Page';
  const ext = f.name.includes('.') ? f.name.split('.').pop()!.toUpperCase() : '';
  return ext || (f.kind === 'other' ? 'File' : f.kind);
};

/** Download a bot's file under its own name and in its own format: the browser's save, or on Windows the
 * app's Save dialog (desktop/src/main.js). Used by the file viewer, chat file chips and Pages. */
export async function downloadBotFile(botId: string, path: string, name = path.split('/').pop() || 'file') {
  const { url } = await configApi.downloadFile(botId, path);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}

/** Open the pane, optionally on one file. Used by file chips in the chat, the Pages and Library tabs, and the list here.
 * Back from a file goes where it was opened from: the Files list when picked there, otherwise the agent's panel. */
export function openFile(path: string | null, tab?: 'chat' | 'all') {
  const s = useStore.getState();
  const fromList = s.filesOpen && !s.filesPath;
  // A file opened from inside another file (a Page's file chip) keeps the first one's way back.
  const filesFrom = fromList ? 'list' : s.filesOpen && s.filesPath ? s.filesFrom : 'panel';
  s.set({ filesOpen: true, filesPath: path, filesFrom, ...(tab ? { filesTab: tab } : {}) });
}

/** Leave the file pane for the agent's own side panel (details), which is where Back ends up. */
export function backToPanel() {
  useStore.getState().set({ filesOpen: false, filesPath: null, detailsOpen: true });
}

/** A blank Page you start yourself; the bot can fill it in with you. (An inline box: the Windows app has no prompt().) */
function NewPage({ bot, onDone }: { bot: Bot; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const make = async () => {
    if (!title.trim() || inFlight.current) return; // one Page per press, even with Enter held or double-clicked
    inFlight.current = true;
    setBusy(true); setError(null);
    try { const r = await configApi.newPage(bot.id, title.trim()); onDone(); openFile(r.path); }
    catch (e) { setError((e as Error).message); setBusy(false); }
    finally { inFlight.current = false; }
  };
  return (
    <form className="page-new" onSubmit={(e) => { e.preventDefault(); make(); }}>
      <input className="page-input" autoFocus placeholder="Name the new Page" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onDone(); }} />
      <button type="submit" className="btn btn--sm btn--primary" disabled={busy || !title.trim()}>{busy ? 'Making…' : 'Make Page'}</button>
      <button type="button" className="btn btn--sm btn--secondary" onClick={onDone}>Cancel</button>
      {error && <div className="files-pane__note is-error">{error}</div>}
    </form>
  );
}

export function FilePane() {
  const bot = useSelectedBot();
  const path = useStore((s) => s.filesPath);
  const tab = useStore((s) => s.filesTab);
  const set = useStore((s) => s.set);
  const [naming, setNaming] = useState(false);
  // Another bot's chat starts at its list (a chip opening the pane keeps its file).
  const shownBot = useRef(bot?.id);
  useEffect(() => {
    if (shownBot.current !== bot?.id) { set({ filesPath: null }); setNaming(false); }
    shownBot.current = bot?.id;
  }, [bot?.id, set]);
  if (!bot) return null;
  const close = () => set({ filesOpen: false, filesPath: null });
  // Back from a file: to the list if it was picked there, otherwise straight to the agent's panel.
  const fileBack = () => (useStore.getState().filesFrom === 'list' ? set({ filesPath: null }) : backToPanel());
  return (
    <aside className="details files-pane" aria-label="Files">
      {path && kindOf(path.split('/').pop()!) === 'page' ? (
        <PageViewer key={`${bot.id}:${path}`} bot={bot} path={path} onBack={fileBack} onClose={close} />
      ) : path ? (
        <FileViewer key={`${bot.id}:${path}`} bot={bot} path={path} onBack={fileBack} onClose={close} />
      ) : (
        <>
          <div className="files-pane__top">
            <button type="button" className="icon-btn icon-btn--bordered" onClick={backToPanel} aria-label={`Back to ${bot.name}`} title="Back">
              <Icon name="chev_left" opacity={0.92} />
            </button>
            <div className="files-pane__title">Files</div>
            <div className="segmented">
              <button type="button" className={tab === 'chat' ? 'is-active' : ''} onClick={() => set({ filesTab: 'chat' })}>This chat</button>
              <button type="button" className={tab === 'all' ? 'is-active' : ''} onClick={() => set({ filesTab: 'all' })}>All files</button>
            </div>
            <button type="button" className="icon-btn icon-btn--bordered" onClick={() => setNaming(!naming)} aria-label="New Page" title="New Page">
              <Plus aria-hidden size={16} strokeWidth={2} />
            </button>
            <button type="button" className="icon-btn icon-btn--bordered" onClick={close} aria-label="Close files">
              <Icon name="close" opacity={0.92} />
            </button>
          </div>
          {naming && <NewPage key={bot.id} bot={bot} onDone={() => setNaming(false)} />}
          <div className="details__scroll">
            {/* Keyed by bot: another bot's pane never shows (or opens) the previous bot's folder or list. */}
            {tab === 'chat' ? <ChatFiles key={bot.id} bot={bot} /> : <AllFiles key={bot.id} bot={bot} />}
          </div>
        </>
      )}
    </aside>
  );
}

function FileRow({ f: f0, onOpen, sub }: { f: ChatFile; onOpen: () => void; sub?: string }) {
  const f = f0.kind === 'page' ? { ...f0, name: f0.name.replace(/\.page\.json$/i, '') } : f0;
  return (
    <button type="button" className="file-row" onClick={onOpen} title={`Open ${f.name}`}>
      <span className="file-row__icon"><FileGlyph file={f} size={16} /></span>
      <span className="file-row__text">
        <span className="file-row__name">{f.path.includes('/') ? <><span className="file-row__dir">{f.path.slice(0, f.path.lastIndexOf('/') + 1)}</span>{f.name}</> : f.name}</span>
        <span className="file-row__meta">{sub ?? `${kindLabel(f)} · ${formatBytes(f.size)} · ${relativeShort(f.modifiedAt)}`}</span>
      </span>
    </button>
  );
}

function ChatFiles({ bot }: { bot: Bot }) {
  // Reload whenever a new file card arrives in this conversation.
  const cards = useStore((s) => {
    const t = s.transcripts[bot.id];
    if (!t) return 0;
    let n = 0;
    for (const r of Object.values(t.bySeq)) if (r.body.type === 'card' && r.body.card === 'files') n += r.seq;
    return n;
  });
  const [files, setFiles] = useState<ChatFileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    configApi.chatFiles(bot.id).then((r) => live && setFiles(r.files), (e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [bot.id, cards]);
  return (
    <div className="details__sections">
      <div className="panel-card">
        {error ? <div className="panel-empty">Couldn’t load files: {error}</div>
          : !files ? <div className="panel-empty">Looking for files…</div>
          : !files.length ? (
            <div className="panel-empty panel-empty--center">
              Files {bot.name} makes in this chat show up here. Try “write that up as a Word document” or “make me a short slide deck”.
              <div style={{ marginTop: 12 }}><button type="button" className="link-btn link-btn--small" onClick={() => useStore.getState().set({ filesTab: 'all' })}>See all files</button></div>
            </div>
          )
          : files.map((f) => f.missing
            ? <div key={f.path} className="file-row is-missing"><span className="file-row__icon"><FileGlyph file={f} /></span><span className="file-row__text"><span className="file-row__name">{f.name}</span><span className="file-row__meta">Moved or deleted</span></span></div>
            : <FileRow key={f.path} f={f} onOpen={() => openFile(f.path)} />)}
      </div>
    </div>
  );
}

function AllFiles({ bot }: { bot: Bot }) {
  const awake = useStore((s) => s.computer?.status === 'running');
  const [dir, setDir] = useState('');
  const [list, setList] = useState<LibraryListing | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the newest request's answer is shown, so a slow listing can't replace the folder opened after it.
  const latest = useRef(0);
  const load = useCallback(async (wake = false) => {
    const mine = ++latest.current;
    setLoading(true);
    try { const r = await configApi.files(bot.id, dir, wake); if (mine === latest.current) setList({ ...r, path: dir }); }
    catch (e) { if (mine === latest.current) setList({ status: 'error', path: dir, files: [], error: (e as Error).message }); }
    finally { if (mine === latest.current) setLoading(false); }
  }, [bot.id, dir]);
  useEffect(() => { load(); }, [load, awake]);
  const open = (next: string) => { if (next !== dir) { setList(null); setDir(next); } };
  // A listing for another folder (still on its way out) is not shown, and its names are never joined to this folder.
  const shown = list && list.path === dir ? list : null;
  const crumbs = dir ? dir.split('/') : [];
  const asFile = (f: LibraryFile): ChatFile => ({ path: dir ? `${dir}/${f.name}` : f.name, name: f.name, size: f.size, modifiedAt: f.modifiedAt, kind: kindOf(f.name) });
  return (
    <div className="details__sections">
      <section>
        <div className="section-label section-label--row">
          <span className="lib-crumbs">
            <button type="button" className="link-btn link-btn--small" onClick={() => open('')}>Workspace</button>
            {crumbs.map((c, i) => (
              <span key={i} className="lib-crumbs__part">
                <Icon name="chev_right" size={8} opacity={0.5} />
                <button type="button" className="link-btn link-btn--small" onClick={() => open(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
              </span>
            ))}
          </span>
          <button type="button" className="link-btn link-btn--small" onClick={() => load()} disabled={loading} aria-label="Refresh files" title="Refresh">
            <Icon name="refresh" size={12} opacity={0.7} style={loading ? { animation: 'cfg-spin 0.8s linear infinite' } : undefined} />
          </button>
        </div>
        <div className="panel-card">
          {shown?.status === 'asleep' ? (
            <div className="lib-empty">
              <div>{bot.name}’s computer is asleep. Wake it to see files.</div>
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => load(true)} disabled={loading}>{loading ? 'Waking…' : 'Wake and show files'}</button>
            </div>
          ) : !shown ? <div className="panel-empty">Looking for files…</div>
            : shown.status === 'error' ? <div className="panel-empty">Couldn’t reach the computer. <span className="lib-err">{shown.error}</span></div>
            : !shown.files.length ? <div className="panel-empty panel-empty--center">{dir ? 'This folder is empty.' : `${bot.name}’s workspace is empty.`}</div>
            : shown.files.map((f) => f.isDir ? (
              <button key={f.name} type="button" className="file-row" onClick={() => open(dir ? `${dir}/${f.name}` : f.name)}>
                <span className="file-row__icon is-dir"><Folder aria-hidden size={16} strokeWidth={1.9} fill="currentColor" /></span>
                <span className="file-row__text"><span className="file-row__name">{f.name}</span><span className="file-row__meta">Folder · {relativeShort(f.modifiedAt)}</span></span>
              </button>
            ) : <FileRow key={f.name} f={asFile(f)} onOpen={() => openFile(asFile(f).path)} />)}
        </div>
      </section>
    </div>
  );
}

/** Same rule as server/src/files.ts fileKind, for listings that don't carry a kind. */
export function kindOf(name: string): FileKind {
  if (name.toLowerCase().endsWith('.page.json')) return 'page';
  if (!name.includes('.')) return 'text';
  const ext = name.toLowerCase().split('.').pop()!;
  if (['md', 'markdown', 'mdx'].includes(ext)) return 'markdown';
  if (['txt', 'log', 'text'].includes(ext)) return 'text';
  if (['csv', 'tsv'].includes(ext)) return 'table';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx', 'odt', 'ppt', 'pptx', 'odp', 'rtf'].includes(ext)) return 'office';
  if (['xls', 'xlsx', 'ods', 'xlsm'].includes(ext)) return 'sheet';
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'json', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'htm', 'css', 'scss', 'sql', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'rb', 'php', 'swift', 'ps1', 'svg', 'env', 'conf', 'cfg'].includes(ext)) return 'code';
  return 'other';
}

function FileViewer({ bot, path, onBack, onClose }: { bot: Bot; path: string; onBack: () => void; onClose: () => void }) {
  const [p, setP] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const name = path.split('/').pop()!;

  const load = useCallback(() => {
    setError(null);
    return configApi.filePreview(bot.id, path).then(setP, (e) => setError((e as Error).message));
  }, [bot.id, path]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!p) return;
    setBusy('save'); setNote(null);
    try {
      const f = await configApi.saveFileText(bot.id, path, draft, p.modifiedAt);
      setP({ ...p, ...f, text: draft, sheets: p.kind === 'table' ? undefined : p.sheets });
      setEditing(false);
      if (p.kind === 'table') load();
      setNote('Saved');
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(null); }
  };
  const dl = async () => {
    setBusy('dl'); setNote(null);
    try { await downloadBotFile(bot.id, path, name); } catch (e) { setNote(`Couldn’t download: ${(e as Error).message}`); } finally { setBusy(null); }
  };
  const canOpenRaw = p && (p.kind === 'image' || p.kind === 'pdf');

  return (
    <>
      <div className="files-pane__top files-pane__top--file">
        <button type="button" className="icon-btn icon-btn--plain" onClick={onBack} aria-label="Back" title="Back">
          <Icon name="chev_left" opacity={0.8} />
        </button>
        <div className="files-pane__name" title={path}>
          <FileGlyph file={p ?? { kind: kindOf(name), name }} size={16} style={{ opacity: 0.7 }} />
          <span>{name}</span>
        </div>
        <button type="button" className="icon-btn icon-btn--bordered" onClick={onClose} aria-label="Close files">
          <Icon name="close" opacity={0.92} />
        </button>
      </div>
      <div className="files-pane__actions">
        {p && <span className="file-row__meta">{kindLabel(p)} · {formatBytes(p.size)} · {relativeShort(p.modifiedAt)}</span>}
        <span style={{ flex: 1 }} />
        {p?.editable && !editing && (
          <button type="button" className="btn btn--sm btn--secondary" onClick={() => { setDraft(p.text ?? ''); setEditing(true); setNote(null); }}>
            <Pencil aria-hidden size={13} strokeWidth={2} /> Edit
          </button>
        )}
        {editing && <>
          <button type="button" className="btn btn--sm btn--secondary" onClick={() => setEditing(false)} disabled={busy === 'save'}>Cancel</button>
          <button type="button" className="btn btn--sm btn--primary" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        </>}
        {!editing && canOpenRaw && (
          <a className="btn btn--sm btn--secondary" href={configApi.fileRawUrl(bot.id, path, p?.modifiedAt)} target="_blank" rel="noreferrer noopener" title="Open in a new tab">
            <ExternalLink aria-hidden size={13} strokeWidth={2} /> Open
          </a>
        )}
        {!editing && <button type="button" className="btn btn--sm btn--secondary" onClick={dl} disabled={busy === 'dl'}><Download aria-hidden size={13} strokeWidth={2} /> {busy === 'dl' ? 'Getting…' : 'Download'}</button>}
      </div>
      {note && <div className={`files-pane__note${note === 'Saved' ? '' : ' is-error'}`}>{note}</div>}
      <div className="details__scroll files-pane__body">
        {error ? <div className="panel-empty">Couldn’t open it: {error}</div>
          : !p ? <div className="panel-empty">Opening…</div>
          : editing ? <textarea className="files-edit" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={p.kind === 'markdown' || p.kind === 'text'} autoFocus />
          : <PreviewBody bot={bot} p={p} />}
      </div>
    </>
  );
}

function PreviewBody({ bot, p }: { bot: Bot; p: FilePreview }) {
  const [sheet, setSheet] = useState(0);
  const pages = useMemo(() => Array.from({ length: Math.min(p.pages ?? 0, 300) }, (_, i) => i + 1), [p.pages]);
  if (p.error) return <div className="files-empty">{p.error}</div>;
  switch (p.kind) {
    case 'markdown':
      return <div className="files-doc"><Markdown text={p.text ?? ''} />{p.truncated && <Truncated />}</div>;
    case 'text': case 'code':
      return <><pre className={`files-text${p.kind === 'code' ? ' is-code' : ''}`}>{p.text}</pre>{p.truncated && <Truncated />}</>;
    case 'image':
      return <div className="files-image"><img src={configApi.fileRawUrl(bot.id, p.path, p.modifiedAt)} alt={p.name} /></div>;
    case 'pdf': case 'office':
      return (
        <div className="files-pages">
          {pages.map((n) => (
            <img key={n} src={configApi.filePageUrl(bot.id, p.path, n, p.modifiedAt)} alt={`Page ${n} of ${p.pages}`} loading="lazy" className="files-page" />
          ))}
          {(p.pages ?? 0) > pages.length && <div className="files-empty">Showing the first {pages.length} of {p.pages} pages. Download it to see the rest.</div>}
        </div>
      );
    case 'table': case 'sheet': {
      const sheets = p.sheets ?? [];
      const s = sheets[Math.min(sheet, sheets.length - 1)];
      if (!s) return <div className="files-empty">This spreadsheet is empty.</div>;
      return (
        <div className="files-sheet">
          {sheets.length > 1 && (
            <div className="segmented files-sheet__tabs">
              {sheets.map((x, i) => <button key={i} type="button" className={i === sheet ? 'is-active' : ''} onClick={() => setSheet(i)}>{x.name}</button>)}
            </div>
          )}
          <div className="files-table-wrap">
            <table className="files-table">
              <tbody>
                {s.rows.map((r, i) => (
                  <tr key={i}>
                    <th scope="row">{i + 1}</th>
                    {r.map((c, j) => i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {s.truncated && <Truncated what="rows or columns" />}
        </div>
      );
    }
    default:
      return <div className="files-empty">There’s no preview for this kind of file. Download it to open it.</div>;
  }
}

const Truncated = ({ what = 'the file' }: { what?: string }) => <div className="files-empty">Only the start of {what} is shown here. Download it to see everything.</div>;
