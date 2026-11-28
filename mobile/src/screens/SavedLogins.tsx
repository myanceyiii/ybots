import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import type { Client, SavedLogin, SavedLoginInput } from '../api';
import { Field, Header, HeaderTitle, Notice, PillButton, RoundButton } from '../components/ui';
import { KeyboardSafe } from '../components/KeyboardSafe';
import { color, type } from '../theme';
import { Card, Row, Section } from './BotSettings';

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : m < 48 * 60 ? 'yesterday' : `${Math.round(m / 1440)} days ago`;
};
const secret = { autoCorrect: false, autoCapitalize: 'none', spellCheck: false, importantForAutofill: 'no', autoComplete: 'off' } as const;

/**
 * Saved logins (server/src/vault.ts), as the web's Settings › Saved logins: the signed-in person's own
 * logins. A bot asks on a card each time and the server types the login into the page; no screen ever
 * shows a saved password, only "saved". Change it or delete it.
 */
export function SavedLogins({ api, onBack }: { api: Client; onBack: () => void }) {
  const [logins, setLogins] = useState<SavedLogin[] | null>(null);
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SavedLogin | 'new' | null>(null);
  const load = () => api.vaultLogins().then((r) => { setLogins(r.logins); setBots(r.bots); setError(null); }, (e: any) => setError(e?.message ?? 'The server did not answer.'));
  useEffect(() => { load(); }, [api]);

  if (editing) return <LoginForm api={api} bots={bots} login={editing === 'new' ? undefined : editing} onDone={() => { setEditing(null); load(); }} />;
  const botNames = (l: SavedLogin) => (l.bots === null ? 'all your bots' : l.bots.length ? bots.filter((b) => l.bots!.includes(b.id)).map((b) => b.name).join(', ') : 'no bot');
  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>Saved logins</HeaderTitle>
      </Header>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        <Text style={[type.caption, { color: color.inkSecondary, fontSize: 15, lineHeight: 21, marginBottom: 14 }]}>Save a site's login once. When a bot reaches that site's sign-in page, it asks on a card, and the app types your login into the page. The bot never sees it.</Text>
        {!!error && <View style={{ marginBottom: 14 }}><Notice tone="problem">{error}</Notice></View>}
        {!logins && !error && <Text style={[type.caption, { textAlign: 'center', padding: 24 }]}>Loading…</Text>}
        {logins && (
          <Section hint="Kept encrypted on your server and seen only by you. Every use asks you on a card first, and the card can't be answered from a notification.">
            {logins.length === 0 ? <Notice>No saved logins yet. Add one here, or tick "Save to my logins" on a bot's password card.</Notice> : (
              <Card>
                {logins.map((l, i) => (
                  <Row key={l.id} last={i === logins.length - 1} onPress={() => setEditing(l)} title={l.label || l.site}
                    detail={[l.label ? l.site : '', l.userHint || (l.hasUsername ? 'username saved' : 'no username'), l.hasPassword ? 'password saved' : 'no password', botNames(l),
                      l.uses ? `used ${l.uses}×${l.lastUsedAt ? `, last ${ago(l.lastUsedAt)}` : ''}` : 'not used yet', l.connectorFirst ? 'connected app first' : ''].filter(Boolean).join(' · ')} />
                ))}
              </Card>
            )}
          </Section>
        )}
        {logins && <PillButton title="Add a login" onPress={() => setEditing('new')} />}
      </ScrollView>
    </View>
  );
}

function LoginForm({ api, bots, login, onDone }: { api: Client; bots: { id: string; name: string }[]; login?: SavedLogin; onDone: () => void }) {
  const [site, setSite] = useState(login?.site ?? '');
  const [label, setLabel] = useState(login?.label ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [chosen, setChosen] = useState<string[] | null>(login ? login.bots : null);
  const [cf, setCf] = useState<boolean | null>(login ? login.connectorFirst : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body: SavedLoginInput = { site, label, bots: chosen ?? 'all', ...(cf !== null ? { connectorFirst: cf } : {}), ...(username || !login ? { username } : {}), ...(password ? { password } : {}) };
      if (login) await api.updateVaultLogin(login.id, body); else await api.addVaultLogin(body);
      setPassword(''); setUsername('');
      onDone();
    } catch (e: any) { setError(e?.message ?? 'Something went wrong.'); } finally { setBusy(false); }
  };
  const remove = () => Alert.alert('Delete this login?', `${login?.label || login?.site}: bots can't use it any more.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => { api.deleteVaultLogin(login!.id).then(onDone, (e: any) => setError(e?.message ?? 'Something went wrong.')); } },
  ]);
  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onDone} />
        <HeaderTitle>{login ? 'Change login' : 'Add a login'}</HeaderTitle>
      </Header>
      <KeyboardSafe style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 4 }} keyboardShouldPersistTaps="handled">
          <Section title="Site" hint="Like example.com. It also fits the site's other pages, like login.example.com.">
            <Field value={site} onChangeText={setSite} placeholder="example.com" {...secret} keyboardType="url" accessibilityLabel="Site" />
          </Section>
          <Section title="Name (optional)">
            <Field value={label} onChangeText={setLabel} placeholder="Water bill" maxLength={60} accessibilityLabel="Name" />
          </Section>
          <Section title="Username or email" hint={login ? (login.hasUsername ? `Saved (${login.userHint}). Leave empty to keep it.` : 'None saved.') : undefined}>
            <Field value={username} onChangeText={setUsername} {...secret} keyboardType="email-address" maxLength={512} accessibilityLabel="Username or email" />
          </Section>
          <Section title="Password" hint={login?.hasPassword ? 'Saved. Leave empty to keep it.' : undefined}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <TextInput value={password} onChangeText={setPassword} secureTextEntry={!show} {...secret} maxLength={512} accessibilityLabel="Password" placeholderTextColor={color.timestamp}
                style={{ flex: 1, minHeight: 48, borderRadius: 24, backgroundColor: color.fill, paddingHorizontal: 18, paddingVertical: 12, fontSize: 16, color: color.ink }} />
              <Pressable onPress={() => setShow(!show)} accessibilityRole="button" accessibilityLabel={show ? 'Hide what you typed' : 'Show what you typed'} hitSlop={8} style={{ paddingHorizontal: 6, paddingVertical: 8 }}>
                <Text style={{ fontSize: 15, fontWeight: '500', color: color.link }}>{show ? 'Hide' : 'Show'}</Text>
              </Pressable>
            </View>
          </Section>
          <Section title="Bots that may ask to use it">
            <Card>
              <Row title="All my bots" last={chosen === null || !bots.length} right={<Switch value={chosen === null} onValueChange={(v) => setChosen(v ? null : bots.map((b) => b.id))} accessibilityLabel="All my bots" />} />
              {chosen !== null && bots.map((b, i) => (
                <Row key={b.id} title={b.name} last={i === bots.length - 1}
                  right={<Switch value={chosen.includes(b.id)} onValueChange={(v) => setChosen(v ? [...chosen, b.id] : chosen.filter((x) => x !== b.id))} accessibilityLabel={`${b.name} may ask to use it`} />} />
              ))}
            </Card>
          </Section>
          <Section hint="Bots do mail, calendar and money work through a connected app first, and never switch to the browser when the app fails. The card warns you.">
            <Card>
              <Row title="Mail, calendar or money site" last right={<Switch value={cf ?? false} onValueChange={setCf} accessibilityLabel="Mail, calendar or money site" />} />
            </Card>
          </Section>
          {!!error && <View style={{ marginBottom: 12 }}><Notice tone="problem">{error}</Notice></View>}
          <PillButton title={busy ? 'Saving…' : 'Save'} disabled={busy || !site.trim() || (!login && !username.trim() && !password)} onPress={save} />
          {login && <View style={{ marginTop: 10 }}><PillButton title="Delete" kind="secondary" disabled={busy} onPress={remove} /></View>}
        </ScrollView>
      </KeyboardSafe>
    </View>
  );
}
