import { useCallback, useEffect, useRef, useState } from 'react';
import { useSimple } from '../simple';
import { useBack } from '../back';
import { ActivityIndicator, Image, Platform, Pressable, RefreshControl, ScrollView, Text, TextInput, ToastAndroid, View, useWindowDimensions } from 'react-native';
import { File as FsFile, Directory, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { Bot, ChatFile, ChatFileEntry, Client, FileKind, FileListing, FilePreview } from '../api';
import { Chip, Header, HeaderTitle, Notice, PillButton, RoundButton, refreshLook } from '../components/ui';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { color, type } from '../theme';
import { PageScreen } from './PageScreen';
import { background } from '../../modules/cleft-background/src';

/**
 * The file pane on the phone: a full-screen sheet with this chat's files and the bot's whole workspace,
 * and the same previews as the web and Windows apps (pictures of each page for PDF, Word and PowerPoint,
 * tables for spreadsheets, markdown, text and code). Previews are made on the bots' computer
 * (server/src/files.ts). "Open" saves the file to the phone and hands it to another app (Word, Drive…);
 * "Download" keeps a copy in the phone's Downloads folder, in its own format and under its own name.
 */

export const sizeText = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const extLabel = (name: string) => (/\.page\.json$/i.test(name) ? 'Page' : name.includes('.') ? name.split('.').pop()!.toUpperCase() : 'File');
const shownName = (name: string) => name.replace(/\.page\.json$/i, '');
const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

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

const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  csv: 'text/csv', md: 'text/markdown', txt: 'text/plain', html: 'text/html', json: 'application/json',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
};

const safeName = (path: string) => path.split('/').pop()!.replace(/[^\w .()-]/g, '_') || 'file';
const mimeOf = (name: string) => MIME[name.toLowerCase().split('.').pop() ?? ''] ?? 'application/octet-stream';

/** Fetch the file into the app's own cache. Each copy gets its own folder, so two files with the same
 * name never overwrite each other while another app still has the first one open. */
async function fetchCopy(api: Client, botId: string, path: string) {
  const dir = new Directory(Paths.cache, 'cleft-files', `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  dir.create({ idempotent: true, intermediates: true });
  return FsFile.downloadFileAsync(api.fileDownloadUrl(botId, path), new FsFile(dir, safeName(path)), { headers: api.authHeader, idempotent: true });
}

async function shareCopy(uri: string, name: string) {
  if (!(await Sharing.isAvailableAsync())) throw new Error('This phone can’t hand files to other apps.');
  await Sharing.shareAsync(uri, { mimeType: mimeOf(name), dialogTitle: name });
}

/** Save a copy on the phone and offer it to other apps (Android's "Open with / Share" sheet). */
export async function openOnPhone(api: Client, botId: string, path: string) {
  const file = await fetchCopy(api, botId, path);
  await shareCopy(file.uri, safeName(path));
}

export type Downloaded = { name: string; uri: string; mime: string } | null;

/**
 * Download: keep a copy in the phone's Downloads folder, same name and format as on the bots' computer.
 * Says so in a short Android toast. Returns what was saved (Android may add " (1)" to the name), or null
 * when this phone can't save there (Android 9 or older, or an app built before Download): then the
 * "Save to…" sheet opens instead, so the person can still keep it.
 */
export async function downloadToPhone(api: Client, botId: string, path: string): Promise<Downloaded> {
  const file = await fetchCopy(api, botId, path);
  const name = path.split('/').pop() || safeName(path);
  if (Platform.OS !== 'android' || !background.downloadsAvailable) {
    await shareCopy(file.uri, safeName(path));
    return null;
  }
  try {
    const r = await background.saveToDownloads(file.uri, name);
    ToastAndroid.show(`Saved ${r.name} to Downloads`, ToastAndroid.SHORT);
    return r;
  } finally {
    try { file.delete(); } catch { /* the cache is cleared by Android anyway */ }
  }
}

/** The "Saved to Downloads" line under a file's buttons, with Open for the saved copy. */
export function DownloadedNote({ d }: { d: NonNullable<Downloaded> }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
      <Icon name="check" size={16} color={color.inkMuted} />
      <Text numberOfLines={2} style={[type.caption, { flex: 1 }]}>{`Saved to Downloads as ${d.name}`}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${d.name} from Downloads`} hitSlop={8} onPress={() => background.openDownload(d.uri, d.mime)}>
        <Text style={[type.caption, { color: color.ink, fontWeight: '600' }]}>Open</Text>
      </Pressable>
    </View>
  );
}

function FileIcon({ kind, dir, name }: { kind: FileKind; dir?: boolean; name?: string }) {
  const slides = kind === 'office' && !!name && /\.(pptx?|odp)$/i.test(name);
  return (
    <View style={{ width: 40, height: 40, borderRadius: 11, backgroundColor: color.fill, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={dir ? 'folder' : kind === 'page' ? 'check' : kind === 'image' ? 'image' : kind === 'table' || kind === 'sheet' ? 'table' : kind === 'code' ? 'text' : slides ? 'slides' : 'file'} size={20} color={color.ink} />
    </View>
  );
}

function FileRow({ f, onPress, dir, detail, last }: { f: { name: string; kind: FileKind; path?: string }; onPress?: () => void; dir?: boolean; detail: string; last?: boolean }) {
  const folder = f.path && f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole="button" accessibilityLabel={`Open ${f.name}`}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 12, backgroundColor: pressed ? color.pressed : 'transparent', borderBottomWidth: last ? 0 : 1, borderBottomColor: color.hairline, opacity: onPress ? 1 : 0.5 })}>
      <FileIcon kind={f.kind} dir={dir} name={f.name} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 16, color: color.ink }}>{folder ? <Text style={{ color: color.inkMuted }}>{folder}</Text> : null}{shownName(f.name)}</Text>
        <Text numberOfLines={1} style={[type.caption, { fontSize: 13 }]}>{detail}</Text>
      </View>
      {onPress && <Icon name="chevron" size={16} color={color.inkMuted} />}
    </Pressable>
  );
}

export function Files({ api, bot, startPath, onBack }: { api: Client; bot: Bot; startPath?: string | null; onBack: () => void }) {
  const simple = useSimple();
  const [path, setPath] = useState<string | null>(startPath ?? null);
  const [tab, setTab] = useState<'chat' | 'all'>('chat');
  const [naming, setNaming] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const making = useRef(false);
  const back = () => (startPath && path === startPath ? onBack() : setPath(null));
  // The phone's back button closes the open file (or the New Page box) before it leaves the files.
  useBack(!!path && !(startPath && path === startPath), () => setPath(null));
  useBack(!path && naming !== null, () => setNaming(null));
  if (path && kindOf(path.split('/').pop()!) === 'page') return <PageScreen api={api} bot={bot} path={path} onBack={back} onOpenFile={setPath} />;
  if (path) return <FileView api={api} bot={bot} path={path} onBack={back} />;
  const makePage = async () => {
    if (!naming?.trim() || making.current) return;
    making.current = true;
    setNameError(null);
    try { const r = await api.newPage(bot.id, naming.trim()); setNaming(null); setPath(r.path); }
    catch (e: any) { setNameError(e?.message ?? 'Couldn’t make it'); }
    finally { making.current = false; }
  };
  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>{simple ? `Files ${bot.name} made` : `${bot.name}'s files`}</HeaderTitle>
        <RoundButton icon="plus" label="New Page" onPress={() => setNaming(naming === null ? '' : null)} />
      </Header>
      {naming !== null && (
        <View style={{ paddingHorizontal: 16, paddingBottom: 10, gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <TextInput value={naming} onChangeText={setNaming} autoFocus placeholder="Name the new Page" placeholderTextColor={color.timestamp} returnKeyType="done" onSubmitEditing={makePage}
              style={{ flex: 1, height: 44, paddingHorizontal: 12, borderRadius: 12, backgroundColor: color.surface, borderWidth: 1, borderColor: color.secondaryBorder, fontSize: 16, color: color.ink }} />
            <PillButton title="Make Page" disabled={!naming.trim()} onPress={makePage} />
          </View>
          {nameError && <Notice tone="problem">{nameError}</Notice>}
        </View>
      )}
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 10 }}>
        <Chip title="This chat" selected={tab === 'chat'} onPress={() => setTab('chat')} />
        <Chip title="All files" selected={tab === 'all'} onPress={() => setTab('all')} />
      </View>
      {tab === 'chat' ? <ChatList api={api} bot={bot} onOpen={setPath} onAll={() => setTab('all')} /> : <AllList api={api} bot={bot} onOpen={setPath} />}
    </View>
  );
}

function ChatList({ api, bot, onOpen, onAll }: { api: Client; bot: Bot; onOpen: (p: string) => void; onAll: () => void }) {
  const [files, setFiles] = useState<ChatFileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true); setError(null);
    try { setFiles((await api.chatFiles(bot.id)).files); } catch (e: any) { setError(e?.message ?? 'Couldn’t load files'); } finally { setBusy(false); }
  }, [api, bot.id]);
  useEffect(() => { load(); }, [load]);
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 12 }} refreshControl={<RefreshControl {...refreshLook()} refreshing={busy && !!files} onRefresh={load} />}>
      {error && <Notice tone="problem">{error}</Notice>}
      {!files && !error && <ActivityIndicator color={color.ink} />}
      {files && !files.length && (
        <View style={{ gap: 12, paddingVertical: 24, alignItems: 'center' }}>
          <Text style={[type.caption, { textAlign: 'center' }]}>Files {bot.name} makes in this chat show up here. Try “write that up as a Word document” or “make me a short slide deck”.</Text>
          <PillButton title="See all files" kind="secondary" onPress={onAll} />
        </View>
      )}
      {!!files?.length && (
        <View style={{ backgroundColor: color.surface, borderRadius: 16, overflow: 'hidden' }}>
          {files.map((f, i) => <FileRow key={f.path} f={f} last={i === files.length - 1} onPress={f.missing ? undefined : () => onOpen(f.path)}
            detail={f.missing ? 'Moved or deleted' : `${extLabel(f.name)} · ${sizeText(f.size)} · ${ago(f.modifiedAt)}`} />)}
        </View>
      )}
    </ScrollView>
  );
}

function AllList({ api, bot, onOpen }: { api: Client; bot: Bot; onOpen: (p: string) => void }) {
  const simple = useSimple();
  const [dir, setDir] = useState('');
  const [shown, setList] = useState<FileListing | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the newest request is shown: tapping folders quickly never leaves an older folder's list on screen.
  const latest = useRef(0);
  const load = useCallback(async (wake = false) => {
    const id = ++latest.current;
    setBusy(true);
    try { const r = await api.files(bot.id, dir, wake); if (id === latest.current) setList(r); }
    catch (e: any) { if (id === latest.current) setList({ status: 'error', path: dir, files: [], error: e?.message }); }
    finally { if (id === latest.current) setBusy(false); }
  }, [api, bot.id, dir]);
  useEffect(() => { load(); }, [load]);
  const crumbs = dir ? dir.split('/') : [];
  // The phone's back button goes up one folder.
  useBack(!!dir, () => setDir(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''));
  // A listing for another folder (still loading the one just tapped) is not shown as this one.
  const list = shown && shown.path === dir ? shown : null;
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 12 }} refreshControl={<RefreshControl {...refreshLook()} refreshing={busy && !!list} onRefresh={() => load()} />}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, alignItems: 'center' }}>
        <Chip title={simple ? 'All files' : 'Workspace'} selected={!dir} onPress={() => setDir('')} />
        {crumbs.map((c, i) => <Chip key={i} title={c} selected={i === crumbs.length - 1} onPress={() => setDir(crumbs.slice(0, i + 1).join('/'))} />)}
      </ScrollView>
      {!list && <ActivityIndicator color={color.ink} />}
      {list?.status === 'asleep' && (
        <View style={{ gap: 12, alignItems: 'center', paddingVertical: 16 }}>
          <Text style={type.caption}>{simple ? `${bot.name}’s files are put away for now.` : `${bot.name}’s computer is asleep.`}</Text>
          <PillButton title={busy ? (simple ? 'Getting them…' : 'Waking…') : simple ? 'Show the files' : 'Wake and show files'} kind="secondary" disabled={busy} onPress={() => load(true)} />
        </View>
      )}
      {list?.status === 'error' && <Notice tone="problem">{`Couldn’t reach the computer. ${list.error ?? ''}`}</Notice>}
      {list?.status === 'ok' && !list.files.length && <Text style={[type.caption, { textAlign: 'center', paddingVertical: 24 }]}>{dir ? 'This folder is empty.' : (simple ? 'No files yet.' : `${bot.name}’s workspace is empty.`)}</Text>}
      {list?.status === 'ok' && !!list.files.length && (
        <View style={{ backgroundColor: color.surface, borderRadius: 16, overflow: 'hidden' }}>
          {list.files.map((f, i) => {
            const p = dir ? `${dir}/${f.name}` : f.name;
            return <FileRow key={f.name} f={{ name: f.name, kind: kindOf(f.name) }} dir={f.isDir} last={i === list.files.length - 1}
              detail={f.isDir ? `Folder · ${ago(f.modifiedAt)}` : `${extLabel(f.name)} · ${sizeText(f.size)} · ${ago(f.modifiedAt)}`}
              onPress={() => (f.isDir ? setDir(p) : onOpen(p))} />;
          })}
        </View>
      )}
    </ScrollView>
  );
}

/** A picture from the server, as wide as the screen and as tall as it needs to be. */
function Picture({ uri, headers, label, guess = 0.77 }: { uri: string; headers: Record<string, string>; label: string; guess?: number }) {
  const [ratio, setRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  if (failed) return <Notice tone="problem">{`Couldn’t draw ${label.toLowerCase()}.`}</Notice>;
  return (
    <Image source={{ uri, headers }} accessibilityLabel={label} resizeMode="contain"
      onLoad={(e) => { const s = e.nativeEvent.source; if (s?.width && s?.height) setRatio(s.width / s.height); }}
      onError={() => setFailed(true)}
      style={{ width: '100%', aspectRatio: ratio ?? guess, borderRadius: 8, backgroundColor: color.surface, borderWidth: 1, borderColor: color.hairline }} />
  );
}

function FileView({ api, bot, path, onBack }: { api: Client; bot: Bot; path: string; onBack: () => void }) {
  const name = path.split('/').pop()!;
  const [p, setP] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saved, setSaved] = useState<Downloaded>(null);
  const [sheet, setSheet] = useState(0);
  const [pagesShown, setPagesShown] = useState(10);
  const { height } = useWindowDimensions();

  const latest = useRef(0);
  const load = useCallback(() => {
    const id = ++latest.current;
    setError(null);
    return api.filePreview(bot.id, path).then((r) => { if (id === latest.current) setP(r); }, (e: any) => { if (id === latest.current) setError(e?.message ?? 'Couldn’t open it'); });
  }, [api, bot.id, path]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!p) return;
    setBusy('save'); setNote(null);
    try {
      const f = await api.saveFileText(bot.id, path, draft, p.modifiedAt);
      setP({ ...p, ...f, text: draft });
      setEditing(false); setNote('Saved');
      if (p.kind === 'table') load();
    } catch (e: any) { setNote(e?.message ?? 'Couldn’t save'); }
    finally { setBusy(null); }
  };
  const open = async () => {
    setBusy('open'); setNote(null);
    try { await openOnPhone(api, bot.id, path); } catch (e: any) { setNote(e?.message ?? 'Couldn’t open it'); } finally { setBusy(null); }
  };
  const download = async () => {
    setBusy('download'); setNote(null); setSaved(null);
    try { setSaved(await downloadToPhone(api, bot.id, path)); } catch (e: any) { setNote(`Couldn’t download it: ${e?.message ?? 'unknown error'}`); } finally { setBusy(null); }
  };

  let body: React.ReactNode = null;
  if (error) body = <Notice tone="problem">{error}</Notice>;
  else if (!p) body = <ActivityIndicator color={color.ink} />;
  else if (editing) body = (
    <TextInput value={draft} onChangeText={setDraft} multiline autoFocus textAlignVertical="top" autoCapitalize="none" autoCorrect={p.kind !== 'code'}
      style={{ minHeight: height * 0.6, padding: 12, borderRadius: 12, backgroundColor: color.surface, borderWidth: 1, borderColor: color.secondaryBorder, fontFamily: p.kind === 'code' || p.kind === 'table' ? 'monospace' : undefined, fontSize: 15, lineHeight: 21, color: color.ink }} />
  );
  else if (p.error) body = <Notice tone="note">{p.error}</Notice>;
  else if (p.kind === 'markdown') body = <View style={{ backgroundColor: color.surface, borderRadius: 12, padding: 14 }}><Markdown text={p.text ?? ''} /></View>;
  else if (p.kind === 'text' || p.kind === 'code') body = (
    <ScrollView horizontal={p.kind === 'code'} style={{ backgroundColor: color.surface, borderRadius: 12 }} contentContainerStyle={{ padding: 12 }}>
      <Text selectable style={{ fontFamily: 'monospace', fontSize: 12.5, lineHeight: 19, color: color.ink }}>{p.text}</Text>
    </ScrollView>
  );
  else if (p.kind === 'image') body = <Picture uri={api.fileRawUrl(bot.id, path, p.modifiedAt)} headers={api.authHeader} label={name} />;
  else if (p.kind === 'pdf' || p.kind === 'office') {
    const n = Math.min(p.pages ?? 0, pagesShown);
    body = (
      <View style={{ gap: 12 }}>
        {Array.from({ length: n }, (_, i) => <Picture key={i} uri={api.filePageUrl(bot.id, path, i + 1, p.modifiedAt)} headers={api.authHeader} label={`Page ${i + 1}`} guess={/\.(pptx?|odp)$/i.test(name) ? 16 / 9 : 0.707} />)}
        {(p.pages ?? 0) > n && <PillButton title={`Show more pages (${n} of ${p.pages})`} kind="secondary" onPress={() => setPagesShown((x) => x + 10)} />}
      </View>
    );
  } else if (p.kind === 'table' || p.kind === 'sheet') {
    const sheets = p.sheets ?? [];
    const s = sheets[Math.min(sheet, sheets.length - 1)];
    body = !s ? <Text style={type.caption}>This spreadsheet is empty.</Text> : (
      <View style={{ gap: 10 }}>
        {sheets.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {sheets.map((x, i) => <Chip key={i} title={x.name} selected={i === sheet} onPress={() => setSheet(i)} />)}
          </ScrollView>
        )}
        <ScrollView horizontal style={{ backgroundColor: color.surface, borderRadius: 12 }}>
          <View>
            {s.rows.slice(0, 300).map((r, i) => (
              <View key={i} style={{ flexDirection: 'row', backgroundColor: i === 0 ? color.fill : undefined }}>
                <Text style={{ width: 36, padding: 6, fontSize: 12, color: color.inkMuted, textAlign: 'right', borderRightWidth: 1, borderBottomWidth: 1, borderColor: color.hairline }}>{i + 1}</Text>
                {r.map((c, j) => (
                  <Text key={j} numberOfLines={2} style={{ width: 120, padding: 6, fontSize: 13, fontWeight: i === 0 ? '600' : '400', color: color.ink, borderRightWidth: 1, borderBottomWidth: 1, borderColor: color.hairline }}>{c}</Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
        {(s.truncated || s.rows.length > 300) && <Text style={type.caption}>Only the start is shown. Open it to see everything.</Text>}
      </View>
    );
  } else body = <Text style={[type.caption, { textAlign: 'center', paddingVertical: 24 }]}>There’s no preview for this kind of file. Tap Open to use another app.</Text>;

  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>{name}</HeaderTitle>
      </Header>
      {/* Three buttons and the size line don't fit side by side on a narrow phone: the buttons then move to
          their own line, on the right. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: 6, columnGap: 8, paddingHorizontal: 16, paddingBottom: 10 }}>
        <Text numberOfLines={1} style={[type.caption, { flexGrow: 1, flexShrink: 1, flexBasis: 110, fontSize: 13 }]}>{p ? `${extLabel(p.name)} · ${sizeText(p.size)} · ${ago(p.modifiedAt)}` : ''}</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginLeft: 'auto' }}>
        {editing ? (
          <>
            <PillButton title="Cancel" kind="secondary" onPress={() => setEditing(false)} disabled={busy === 'save'} />
            <PillButton title={busy === 'save' ? 'Saving…' : 'Save'} onPress={save} disabled={busy === 'save'} />
          </>
        ) : (
          <>
            {p?.editable && <PillButton title="Edit" kind="secondary" onPress={() => { setDraft(p.text ?? ''); setEditing(true); setNote(null); }} />}
            <PillButton title={busy === 'open' ? 'Getting…' : 'Open'} kind="secondary" disabled={!!busy} onPress={open} />
            <PillButton title={busy === 'download' ? 'Saving…' : 'Download'} icon="download" kind="secondary" disabled={!!busy} onPress={download} />
          </>
        )}
        </View>
      </View>
      {note && <Text style={[type.caption, { paddingHorizontal: 16, paddingBottom: 8, color: note === 'Saved' ? color.inkMuted : color.problemInk }]}>{note}</Text>}
      {saved && !editing && <DownloadedNote d={saved} />}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
        {body}
      </ScrollView>
    </View>
  );
}

/** File chips under a bot's reply: each opens the file on the files screen; the arrow downloads it. */
export function FileChips({ files, onOpen, onDownload }: { files: ChatFile[]; onOpen: (path: string) => void; onDownload?: (path: string) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignSelf: 'flex-start', maxWidth: '92%' }}>
      {files.map((f) => (
        <Pressable key={f.path} onPress={() => onOpen(f.path)} accessibilityRole="button" accessibilityLabel={`Open ${f.name}`}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingLeft: 8, paddingRight: 14, borderRadius: 14, backgroundColor: pressed ? color.pressed : color.surface, borderWidth: 1, borderColor: color.hairline, maxWidth: 300 })}>
          <FileIcon kind={f.kind} name={f.name} />
          <View style={{ flexShrink: 1 }}>
            <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '500', color: color.ink }}>{shownName(f.name)}</Text>
            <Text style={[type.caption, { fontSize: 12.5 }]}>{extLabel(f.name)} · {sizeText(f.size)}</Text>
          </View>
          {onDownload && !(f as ChatFileEntry).missing && kindOf(f.name) !== 'page' && (
            <Pressable accessibilityRole="button" accessibilityLabel={`Download ${f.name}`} hitSlop={6} disabled={busy === f.path}
              onPress={() => { setBusy(f.path); onDownload(f.path).finally(() => setBusy(null)); }}
              style={({ pressed }) => ({ width: 34, height: 34, borderRadius: 10, marginLeft: 2, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.pressed : 'transparent' })}>
              {busy === f.path ? <ActivityIndicator size="small" color={color.ink} /> : <Icon name="download" size={18} color={color.inkMuted} />}
            </Pressable>
          )}
        </Pressable>
      ))}
    </View>
  );
}
