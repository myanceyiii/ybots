import qrcode from 'qrcode-generator';
import { toast } from '../toast';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, Share, Text, View, useWindowDimensions } from 'react-native';
import { SvgXml } from 'react-native-svg';
import type { Client } from '../api';
import { Header, HeaderTitle, Notice, PillButton, RoundButton } from '../components/ui';
import { appName, color, type } from '../theme';
import { useSimple } from '../simple';

/**
 * Sign in another device from this phone, as the web's account menu › Sign in another device
 * (web/src/components/modals/DeviceLinkModal.tsx): a one-time link (15 minutes, one use) for this account,
 * shown as a QR code for another phone's camera, with Copy and Share for a computer or a tablet.
 */
export function DeviceLink({ api, onBack }: { api: Client; onBack: () => void }) {
  const [link, setLink] = useState<{ url: string; appLink: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const { width } = useWindowDimensions();
  // The simple view leaves the long link out: the code, Copy and Share cover it.
  const simple = useSimple();

  const make = useCallback(async () => {
    setError(null); setNote(null); setBusy(true);
    try { setLink(await api.deviceLink()); } catch (e: any) { setError(e?.message ?? 'Could not make a sign-in link.'); } finally { setBusy(false); }
  }, [api]);
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
  const size = Math.min(280, width - 64);

  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>Sign in another device</HeaderTitle>
      </Header>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 48 }}>
        <Text style={[type.caption, { color: color.inkSecondary, fontSize: 15, lineHeight: 21 }]}>
          Scan this with the {appName} app on another phone, or open the link on a computer. It works once and only for the next 15 minutes.
        </Text>
        {/* The code stays dark on white in dark mode too, so every camera can read it. */}
        <View style={{ alignSelf: 'center', width: size, height: size, borderRadius: 20, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          {link && !expired ? <SvgXml xml={svg} width={size - 16} height={size - 16} accessibilityLabel="Sign-in code" />
            : busy ? <ActivityIndicator color="#111111" />
            : <Text style={{ color: color.inkSecondary, fontSize: 15, textAlign: 'center', padding: 24 }}>{expired ? 'This code has expired. Make a new one.' : 'No code yet.'}</Text>}
        </View>
        {link && !expired && <Text style={[type.caption, { textAlign: 'center' }]}>Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</Text>}
        {link && !expired && !simple && <Text selectable numberOfLines={3} style={{ fontSize: 13, color: color.inkMuted, fontFamily: 'monospace', textAlign: 'center' }}>{link.url}</Text>}
        {error && <Notice tone="problem">{error}</Notice>}
        {note && <Notice>{note}</Notice>}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <PillButton title="Copy link" kind="secondary" disabled={!link || expired} style={{ flex: 1 }}
            onPress={() => { if (link) Clipboard.setStringAsync(link.url).then(() => setNote('Copied. Paste it into the browser on the other device.')).catch(() => setError('Could not copy.')); }} />
          <PillButton title="Share" kind="secondary" disabled={!link || expired} style={{ flex: 1 }}
            onPress={() => { if (link) Share.share({ message: link.url }).catch(() => toast("Couldn't open the share sheet.")); }} />
        </View>
        <PillButton title={busy ? 'Making…' : 'New code'} disabled={busy} onPress={make} />
      </ScrollView>
    </View>
  );
}
