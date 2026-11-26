import { CameraView, scanFromURLAsync, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { signInWithLink, type Session } from '../api';
import { Field, Header, ListGroup, ListRow, Notice, PillButton, RoundButton } from '../components/ui';
import { color } from '../theme';

/**
 * Sign in with the code that scripts/sign-in-link.sh makes on the server. Every way ends in the same
 * link: scan it with the camera, read it from a photo or screenshot already on the phone, pick an
 * image file, paste the link, or tap the app link (handled in App.tsx). The link carries the server's
 * address (and this phone's access key), so there is nothing else to type.
 */
export function SignIn({ onBack, onSignedIn }: { onBack: () => void; onSignedIn: (s: Session) => Promise<void> | void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [camera, setCamera] = useState(false);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  const tryLink = async (value: string) => {
    if (handled.current) return;
    handled.current = true;
    setBusy(true);
    setError(null);
    try { await onSignedIn(await signInWithLink(value)); }
    catch (e: any) { setError(e?.message ?? 'Sign-in failed.'); handled.current = false; }
    finally { setBusy(false); }
  };

  /** Reads a QR code out of a picture on the phone. */
  const scanImage = async (uri: string) => {
    setError(null);
    try {
      const found = await scanFromURLAsync(uri, ['qr']);
      if (!found.length) { setError("Couldn't find a sign-in code in that picture. Try a closer screenshot of the code."); return; }
      await tryLink(found[0].data);
    } catch { setError("Couldn't read that picture."); }
  };
  // A picker that cannot open (no photo app, permission refused) says so instead of doing nothing.
  const fromPhotos = async () => {
    try {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (!r.canceled && r.assets[0]) await scanImage(r.assets[0].uri);
    } catch (e: any) { setError(`Couldn't open your photos${e?.message ? `: ${e.message}` : '.'} Use one of the other ways.`); }
  };
  const fromFiles = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({ type: ['image/*'], copyToCacheDirectory: true });
      if (!r.canceled && r.assets[0]) await scanImage(r.assets[0].uri);
    } catch (e: any) { setError(`Couldn't open your files${e?.message ? `: ${e.message}` : '.'} Use one of the other ways.`); }
  };
  const fromClipboard = async () => {
    let text = '';
    try { text = (await Clipboard.getStringAsync()).trim(); } catch { setError("Couldn't read what you copied. Type the link below instead."); return; }
    if (!text) { setError('Nothing is copied yet. Copy the sign-in link first.'); return; }
    setLink(text);
    await tryLink(text);
  };
  const openCamera = async () => {
    setError(null);
    try {
      if (!permission?.granted && !(await requestPermission()).granted) { setError('The camera is off for this app. Use one of the other ways.'); return; }
    } catch { setError("Couldn't open the camera. Use one of the other ways."); return; }
    setCamera(true);
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.ground }}>
      <Header><RoundButton icon="back" label="Back" onPress={onBack} /></Header>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }}>
        <View style={{ alignItems: 'center', paddingHorizontal: 12 }}>
          <Text style={{ fontSize: 30, fontWeight: '600', letterSpacing: -0.5, color: color.ink, textAlign: 'center' }}>Sign in</Text>
          <Text style={{ marginTop: 8, marginBottom: 24, fontSize: 16, lineHeight: 22, color: color.inkMuted, textAlign: 'center' }}>
            Use the sign-in code from your server. Any of these ways works.
          </Text>
        </View>
        {camera ? (
          <View style={{ alignSelf: 'center', width: 280, height: 280, borderRadius: 28, overflow: 'hidden', backgroundColor: '#1A1A1A', marginBottom: 20 }}>
            <CameraView style={{ width: 280, height: 280 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={busy ? undefined : ({ data }) => tryLink(data)} />
          </View>
        ) : (
          <PillButton title="Scan the code" icon="camera" disabled={busy} onPress={openCamera} style={{ marginBottom: 14 }} />
        )}
        {camera && <PillButton title="Stop scanning" kind="secondary" onPress={() => setCamera(false)} style={{ marginBottom: 14 }} />}
        <ListGroup>
          <ListRow icon="image" title="Use a screenshot or photo" disabled={busy} onPress={fromPhotos} />
          <ListRow icon="clipboard" title="Paste the copied link" disabled={busy} onPress={fromClipboard} />
          <ListRow icon="file" title="Pick an image file" disabled={busy} onPress={fromFiles} last />
        </ListGroup>
        <View style={{ marginTop: 14, gap: 10 }}>
          <Field value={link} onChangeText={setLink} placeholder="Or type the link here" autoCapitalize="none" autoCorrect={false}
            keyboardType="url" returnKeyType="go" editable={!busy} accessibilityLabel="Sign-in link"
            onSubmitEditing={() => link.trim() && tryLink(link)} />
          {!!link.trim() && <PillButton title="Sign in with this link" disabled={busy} onPress={() => tryLink(link)} />}
        </View>
        {busy && <ActivityIndicator color={color.ink} style={{ marginTop: 16 }} />}
        {error && <View style={{ marginTop: 16 }}><Notice tone="problem">{error}</Notice></View>}
      </ScrollView>
    </View>
  );
}
