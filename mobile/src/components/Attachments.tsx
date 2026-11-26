// Pictures and files sent with a message: picking them on the phone, the tray above the message box while
// they upload, how they show in a sent message, and a message that is still on its way (src/outbox.ts).
// The same feature as the web's attach tray and pending bubbles (web/src/lib/outbox.ts).
import { useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { MAX_ATTACHMENT, MAX_ATTACHMENTS, type ChatFile, type Client } from '../api';
import { discardPending, retryPending, sizeText, type Pending } from '../outbox';
import { sized } from '../prefs';
import { splitReply } from '../messageText';
import { color, type } from '../theme';
import { Icon } from './Icon';

export interface Attaching {
  id: string; name: string; size: number; uri: string; image: boolean;
  state: 'uploading' | 'done' | 'failed';
  file?: ChatFile; error?: string;
}
export interface Picked { uri: string; name: string; size: number; image: boolean }

/** Ask the phone for pictures (its photo picker), a new photo (its camera) or any files. Empty when cancelled. */
export async function pick(source: 'photos' | 'camera' | 'files'): Promise<Picked[]> {
  if (source === 'files') {
    const r = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: true });
    if (r.canceled) return [];
    return r.assets.map((a) => ({ uri: a.uri, name: a.name || 'File', size: a.size ?? 0, image: (a.mimeType ?? '').startsWith('image/') }));
  }
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error('The camera is not allowed for this app. Allow it in Android settings to take a photo.');
  }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.85, allowsMultipleSelection: source === 'photos', selectionLimit: MAX_ATTACHMENTS };
  const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  if (r.canceled) return [];
  return r.assets.map((a, i) => {
    const ext = (a.mimeType?.split('/')[1] ?? a.uri.split('.').pop() ?? 'jpg').replace('jpeg', 'jpg');
    return { uri: a.uri, name: a.fileName || `${source === 'camera' ? 'Photo' : 'Picture'} ${new Date().toISOString().slice(0, 10)}${i ? ` ${i + 1}` : ''}.${ext}`, size: a.fileSize ?? 0, image: true };
  });
}

/**
 * Start uploading what was picked. `set` updates the chat's tray. Answers a sentence when some could not be added.
 */
export function upload(api: Client, chatId: string, picked: Picked[], have: number, set: (f: (list: Attaching[]) => Attaching[]) => void): string | null {
  const room = Math.max(0, MAX_ATTACHMENTS - have);
  let note: string | null = picked.length > room ? `A message can carry ${MAX_ATTACHMENTS} files at most.` : null;
  for (const p of picked.slice(0, room)) {
    if (p.size > MAX_ATTACHMENT) { note = `${p.name} is larger than 25 MB, which is the most a message can carry.`; continue; }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    set((l) => [...l, { id, name: p.name, size: p.size, uri: p.uri, image: p.image, state: 'uploading' }]);
    api.attach(chatId, p.uri, p.name).then(
      (file) => set((l) => l.map((a) => (a.id === id ? { ...a, state: 'done', file, size: file.size } : a))),
      (e) => set((l) => l.map((a) => (a.id === id ? { ...a, state: 'failed', error: e?.message ?? 'Could not be uploaded.' } : a))),
    );
  }
  return note;
}

/** The pictures and files waiting above the message box, each with a remove button. */
export function AttachTray({ list, onRemove }: { list: Attaching[]; onRemove: (id: string) => void }) {
  if (!list.length) return null;
  return (
    <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginTop: 6 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
      {list.map((a) => (
        <View key={a.id} accessible accessibilityLabel={`${a.name}, ${a.state === 'uploading' ? 'uploading' : a.state === 'failed' ? `failed: ${a.error}` : 'ready'}`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 56, maxWidth: 240, paddingLeft: 6, paddingRight: 4, borderRadius: 14, backgroundColor: a.state === 'failed' ? color.problemFill : color.fill }}>
          {a.image
            ? <Image source={{ uri: a.uri }} style={{ width: 44, height: 44, borderRadius: 10, opacity: a.state === 'uploading' ? 0.5 : 1 }} />
            : <View style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: color.surface, alignItems: 'center', justifyContent: 'center' }}><Icon name="file" size={20} color={color.inkSecondary} /></View>}
          <View style={{ flexShrink: 1 }}>
            <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '500', color: a.state === 'failed' ? color.problemInk : color.ink }}>{a.name}</Text>
            <Text numberOfLines={1} style={[type.caption, { fontSize: 12.5, color: a.state === 'failed' ? color.problemInk : color.inkMuted }]}>{a.state === 'uploading' ? 'Uploading…' : a.state === 'failed' ? a.error ?? 'Could not be uploaded.' : sizeText(a.size)}</Text>
          </View>
          {a.state === 'uploading' && <ActivityIndicator size="small" color={color.inkMuted} />}
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${a.name}`} onPress={() => onRemove(a.id)} hitSlop={6}
            style={({ pressed }) => ({ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.pressed : 'transparent' })}>
            <Icon name="close" size={15} color={color.inkSecondary} />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const isPicture = (f: ChatFile) => f.kind === 'image';

/**
 * The pictures and files of a sent message. A picture opens large on a tap; a file opens in the files screen.
 * `ownerId` is the bot whose Library holds them (a side chat's files live under its bot).
 */
export function MessageAttachments({ api, ownerId, files, mine, onOpenFile, local }: { api: Client; ownerId: string; files: ChatFile[]; mine: boolean; onOpenFile?: (path: string) => void; /** Not sent yet: no taps. */ local?: boolean }) {
  const [big, setBig] = useState<ChatFile | null>(null);
  if (!files.length) return null;
  const pictures = files.filter(isPicture);
  const others = files.filter((f) => !isPicture(f));
  const src = (f: ChatFile) => ({ uri: api.fileRawUrl(ownerId, f.path, f.modifiedAt), headers: api.authHeader });
  const side = pictures.length === 1 ? 200 : 120;
  return (
    <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', alignItems: mine ? 'flex-end' : 'flex-start', maxWidth: '86%', gap: 6, marginBottom: 4 }}>
      {pictures.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: mine ? 'flex-end' : 'flex-start' }}>
          {pictures.map((f) => (
            <Pressable key={f.path} disabled={local} accessibilityRole="imagebutton" accessibilityLabel={`${f.name}. Open the picture`} onPress={() => setBig(f)}
              style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
              <Image source={src(f)} resizeMode="cover" style={{ width: side, height: side, borderRadius: 16, backgroundColor: color.fill }} />
            </Pressable>
          ))}
        </View>
      )}
      {others.map((f) => (
        <Pressable key={f.path} disabled={local || !onOpenFile} accessibilityRole="button" accessibilityLabel={`Open ${f.name}`} onPress={() => onOpenFile?.(f.path)}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingLeft: 10, paddingRight: 14, borderRadius: 14, backgroundColor: pressed ? color.pressed : color.surface, borderWidth: 1, borderColor: color.hairline, maxWidth: 280 })}>
          <Icon name="file" size={20} color={color.inkSecondary} />
          <View style={{ flexShrink: 1 }}>
            <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '500', color: color.ink }}>{f.name}</Text>
            <Text style={[type.caption, { fontSize: 12.5 }]}>{sizeText(f.size)}</Text>
          </View>
        </Pressable>
      ))}
      <Modal visible={!!big} transparent animationType="fade" onRequestClose={() => setBig(null)} statusBarTranslucent>
        <Pressable accessibilityLabel="Close the picture" onPress={() => setBig(null)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' }}>
          {big && <Image source={src(big)} resizeMode="contain" style={{ width: '100%', height: '82%' }} />}
          {big && <Text numberOfLines={1} style={{ position: 'absolute', bottom: 36, left: 24, right: 24, textAlign: 'center', color: '#FFFFFF', fontSize: 14, opacity: 0.85 }}>{big.name}</Text>}
          <View style={{ position: 'absolute', top: 44, right: 16, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={20} color="#FFFFFF" />
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

/**
 * A message on its way: shown at once, a little faded. With no connection it waits and goes by itself;
 * if the server refuses it, Try again sends it again and Edit puts its words back in the message box.
 */
export function PendingBubble({ api, ownerId, p, onEdit }: { api: Client; ownerId: string; p: Pending; onEdit: (p: Pending) => void }) {
  const reply = splitReply(p.text);
  const failed = p.state === 'failed';
  return (
    <View accessibilityLiveRegion="polite">
      <View style={{ opacity: failed ? 1 : 0.6 }}>
        <MessageAttachments api={api} ownerId={ownerId} files={p.attachments} mine local />
        {!!p.text && (
          <View style={{ alignSelf: 'flex-end', maxWidth: '86%', backgroundColor: color.bubbleMine, borderRadius: 20, paddingVertical: 10, paddingHorizontal: 15 }}>
            {!!reply.quote && <Text numberOfLines={4} style={{ color: color.onBubbleMine, opacity: 0.75, fontSize: 14, lineHeight: 19, borderLeftWidth: 2, borderLeftColor: 'rgba(255,255,255,0.45)', paddingLeft: 9, marginBottom: 6 }}>{reply.quote}</Text>}
            <Text style={{ color: color.onBubbleMine, fontSize: sized(16), lineHeight: sized(22) }}>{reply.body}</Text>
          </View>
        )}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 4, marginTop: 3, marginHorizontal: 6 }}>
        <Text style={[type.time, { flexShrink: 1, textAlign: 'right', color: failed ? color.problemInk : color.timestamp }]}>
          {p.state === 'sending' ? 'Sending…' : p.state === 'waiting' ? 'No connection. This goes by itself when it is back.' : `Not sent: ${p.error ?? 'the server refused it.'}`}
        </Text>
        {failed && <Small title="Try again" onPress={() => retryPending(p.clientId)} />}
        {p.state !== 'sending' && <Small title={failed ? 'Edit' : 'Cancel'} onPress={() => { const taken = discardPending(p.clientId); if (taken) onEdit(taken); }} />}
      </View>
    </View>
  );
}

function Small({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8}
      style={({ pressed }) => ({ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: pressed ? color.pressed : color.fill })}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: color.ink }}>{title}</Text>
    </Pressable>
  );
}
