/**
 * Something on a screen failed to draw. Without this, one bad row (a card shape the app does not know, a
 * broken picture) closes the whole app, and it closes again every time that chat opens. With it the rest
 * keeps working: the app says what happened in plain words and offers a way on.
 *
 * - <ErrorBoundary> around a whole screen: a full page with Try again, Go back and Copy details.
 * - <RowGuard> around one row of a chat or list: a small grey line in its place.
 */
import { Component, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { appName, color, type } from '../theme';

/** The newest things that failed to draw, for "Copy details" (kept in memory only). */
const recent: string[] = [];
function remember(where: string, error: unknown, stack?: string | null) {
  const e = error as { message?: string; stack?: string } | null;
  const lines = [`${new Date().toISOString()} ${where}: ${e?.message ?? String(error)}`];
  if (stack) lines.push(stack.trim().split('\n').slice(0, 8).join('\n'));
  else if (e?.stack) lines.push(e.stack.split('\n').slice(0, 6).join('\n'));
  recent.push(lines.join('\n'));
  if (recent.length > 5) recent.shift();
}
export const errorDetails = () => `${appName} ${Constants.expoConfig?.version ?? ''}\n\n${recent.join('\n\n')}`.trim();

interface Props {
  children: ReactNode;
  /** What failed, for the details (a screen's name). */
  where: string;
  /** Leaves the screen that failed (not shown on the first screen). */
  onBack?: () => void;
  /** Change this to try again by itself (the screen changed). */
  resetKey?: string;
}
interface State { error: Error | null; copied: boolean; tries: number }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, copied: false, tries: 0 };
  static getDerivedStateFromError(error: Error): Partial<State> { return { error }; }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) { remember(this.props.where, error, info?.componentStack); }
  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, copied: false, tries: 0 });
  }
  render() {
    const { error, copied, tries } = this.state;
    if (!error) return this.props.children;
    const copy = () => { Clipboard.setStringAsync(errorDetails()).then(() => this.setState({ copied: true }), () => {}); };
    return (
      <ScrollView style={{ flex: 1, backgroundColor: color.ground }} contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 14 }}>
        <Text accessibilityRole="header" style={[type.screenTitle, { textAlign: 'center' }]}>This screen ran into a problem</Text>
        <Text style={[type.caption, { textAlign: 'center', fontSize: 15, lineHeight: 21 }]}>
          {tries > 0
            ? 'It failed again. Go back and carry on somewhere else; your chats and anything you have not sent are safe.'
            : 'Nothing was lost. Your chats and anything you have not sent are safe.'}
        </Text>
        <View style={{ alignSelf: 'stretch', gap: 10, marginTop: 6 }}>
          <Button title="Try again" primary onPress={() => this.setState({ error: null, copied: false, tries: tries + 1 })} />
          {this.props.onBack && <Button title="Go back" onPress={() => { this.setState({ error: null, copied: false, tries: 0 }); this.props.onBack?.(); }} />}
          <Button title={copied ? 'Copied' : 'Copy details'} onPress={copy} />
        </View>
        <Text selectable numberOfLines={3} style={[type.caption, { fontSize: 12.5, textAlign: 'center', marginTop: 4 }]}>{error.message || 'Unknown error'}</Text>
      </ScrollView>
    );
  }
}

function Button({ title, onPress, primary }: { title: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}
      style={({ pressed }) => ({ height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: primary ? color.primary : color.secondaryButton, borderWidth: primary ? 0 : 1, borderColor: color.secondaryBorder, opacity: pressed ? 0.8 : 1 })}>
      <Text style={[type.button, { color: primary ? color.onPrimary : color.ink }]}>{title}</Text>
    </Pressable>
  );
}

interface RowProps { children: ReactNode; /** Changes when the row's content does, so a fixed row draws again. */ resetKey?: string; what?: string }

/** One row of a list that could not be drawn shows as a quiet line; every other row is untouched. */
export class RowGuard extends Component<RowProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) { remember(this.props.what ?? 'row', error, info?.componentStack); }
  componentDidUpdate(prev: RowProps) { if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false }); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <View accessibilityRole="text" style={{ alignSelf: 'flex-start', maxWidth: '86%', borderRadius: 14, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: color.fill }}>
        <Text style={[type.caption, { fontSize: 13 }]}>This {this.props.what ?? 'item'} could not be shown on this phone.</Text>
      </View>
    );
  }
}
