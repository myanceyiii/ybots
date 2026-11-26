import { Modal, Pressable, Text, TextInput, View, useWindowDimensions, type TextInputProps, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from './Icon';
import { color, type } from '../theme';
import { useKeyboardInset } from './KeyboardSafe';

/** Grok Bot's round header buttons: a light grey disc with a thin icon (dark disc on the computer view). */
export function RoundButton({ icon, label, onPress, dark, size = 44, disabled }: { icon: IconName; label: string; onPress?: () => void; dark?: boolean; size?: number; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} onPress={disabled ? undefined : onPress} hitSlop={6}
      style={({ pressed }) => ({ width: size, height: size, borderRadius: size / 2, backgroundColor: dark ? color.computerControl : color.fill, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : pressed ? 0.65 : 1 })}>
      <Icon name={icon} size={size >= 56 ? 26 : 21} color={dark ? '#FFFFFF' : color.ink} />
    </Pressable>
  );
}

/** Card buttons: black primary, light grey secondary with a hairline border. */
export function PillButton({ title, onPress, kind = 'primary', disabled, style, icon }: { title: string; onPress?: () => void; kind?: 'primary' | 'secondary' | 'plain'; disabled?: boolean; style?: ViewStyle; icon?: IconName }) {
  const primary = kind === 'primary';
  const bg = primary ? color.primary : kind === 'plain' ? color.surface : color.secondaryButton;
  const fg = primary ? color.onPrimary : color.ink;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [{ height: 46, borderRadius: 12, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, backgroundColor: bg, borderWidth: kind === 'secondary' ? 1 : 0, borderColor: color.secondaryBorder, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 }, style]}>
      {icon && <Icon name={icon} size={18} color={fg} />}
      <Text numberOfLines={1} adjustsFontSizeToFit style={[type.button, { color: fg, flexShrink: 1 }]}>{title}</Text>
    </Pressable>
  );
}

/** A small black pill for a header action such as Save or Create. */
export function HeaderAction({ title, onPress, disabled }: { title: string; onPress?: () => void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} onPress={disabled ? undefined : onPress} hitSlop={4}
      style={({ pressed }) => ({ height: 44, paddingHorizontal: 20, borderRadius: 22, backgroundColor: disabled ? color.fill : color.primary, justifyContent: 'center', opacity: pressed ? 0.8 : 1 })}>
      <Text style={[type.button, { fontSize: 16, color: disabled ? color.timestamp : color.onPrimary }]}>{title}</Text>
    </Pressable>
  );
}

export function Header({ children, dark }: { children: React.ReactNode; dark?: boolean }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, backgroundColor: dark ? color.computer : undefined }}>{children}</View>;
}

/** The title of a screen without a bot pill, beside the back button. */
export function HeaderTitle({ children }: { children: React.ReactNode }) {
  return <Text numberOfLines={1} style={[type.screenTitle, { flex: 1, marginLeft: 4 }]}>{children}</Text>;
}

/** A grey rounded panel, like Grok Bot's action cards. */
export function Panel({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[{ backgroundColor: color.fill, borderRadius: 18, padding: 14, gap: 12 }, style]}>{children}</View>;
}

/** A small grey caption over a group of controls. */
export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={[type.caption, { color: color.inkMuted, marginBottom: 8, marginLeft: 4 }]}>{children}</Text>;
}

export function Field(props: TextInputProps) {
  return <TextInput placeholderTextColor={color.timestamp} {...props}
    style={[{ minHeight: 48, borderRadius: 24, backgroundColor: color.fill, paddingHorizontal: 18, paddingVertical: 12, fontSize: 16, color: color.ink }, props.style as any]} />;
}

/** A row in a grouped list: icon, label and a chevron. */
export function ListRow({ icon, title, detail, onPress, disabled, last, danger }: { icon: IconName; title: string; detail?: string; onPress?: () => void; disabled?: boolean; last?: boolean; danger?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} onPress={disabled ? undefined : onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 16, backgroundColor: pressed ? color.pressed : 'transparent', opacity: disabled ? 0.45 : 1, borderBottomWidth: last ? 0 : 1, borderBottomColor: color.hairline })}>
      <Icon name={icon} size={21} color={danger ? color.danger : color.ink} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.body, { color: danger ? color.danger : color.ink, fontWeight: '500' }]}>{title}</Text>
        {!!detail && <Text style={[type.caption, { color: color.inkMuted }]}>{detail}</Text>}
      </View>
      {!danger && <Icon name="chevron" size={18} color={color.timestamp} />}
    </Pressable>
  );
}

export function ListGroup({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[{ backgroundColor: color.fill, borderRadius: 18, overflow: 'hidden' }, style]}>{children}</View>;
}

/** A selectable chip (style choices and the like). */
/** A pill to pick from a row. `onCard` draws it white, for use on a grey card. */
export function Chip({ title, selected, onPress, onCard }: { title: string; selected?: boolean; onPress?: () => void; onCard?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} hitSlop={{ top: 5, bottom: 5 }}
      style={({ pressed }) => ({ height: 38, paddingHorizontal: 16, borderRadius: 19, justifyContent: 'center', backgroundColor: selected ? color.primary : onCard ? color.surface : color.fill, opacity: pressed ? 0.8 : 1 })}>
      <Text style={{ fontSize: 15, fontWeight: '500', color: selected ? color.onPrimary : color.ink }}>{title}</Text>
    </Pressable>
  );
}

/** A quiet message inside a screen: grey for notes, light red for problems. */
export function Notice({ children, tone = 'note' }: { children: React.ReactNode; tone?: 'note' | 'problem' }) {
  return (
    <View style={{ borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14, backgroundColor: tone === 'problem' ? color.problemFill : color.fill }}>
      <Text style={[type.caption, { fontSize: 15, lineHeight: 21, color: tone === 'problem' ? color.problemInk : color.inkSecondary }]}>{children}</Text>
    </View>
  );
}

/** A bottom sheet of actions, as Grok Bot's + menus. */
export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  // The app draws edge to edge, so a sheet's window does not shrink for the keyboard: lift the sheet above it
  // ourselves (a field in a sheet, such as a side chat's name, was hidden under the keyboard), and keep it on screen.
  const kb = useKeyboardInset();
  const { height } = useWindowDimensions();
  const room = height - kb.inset - insets.top - 12;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View ref={kb.ref} collapsable={false} style={{ flex: 1, paddingBottom: kb.inset, backgroundColor: 'rgba(0,0,0,0.28)' }}>
      <Pressable accessibilityLabel="Close" onPress={onClose} style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable onPress={() => {}} style={{ maxHeight: room, backgroundColor: color.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 10, paddingBottom: kb.inset ? 12 : Math.max(insets.bottom, 16) + 8, paddingHorizontal: 12 }}>
          <View style={{ alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: color.secondaryBorder, marginBottom: 10 }} />
          {!!title && <Text style={[type.caption, { color: color.inkMuted, paddingHorizontal: 12, paddingBottom: 6 }]}>{title}</Text>}
          {children}
        </Pressable>
      </Pressable>
      </View>
    </Modal>
  );
}

export function SheetRow({ icon, title, onPress, danger }: { icon: IconName; title: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, height: 54, paddingHorizontal: 12, borderRadius: 14, backgroundColor: pressed ? color.fill : 'transparent' })}>
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: color.fill, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={20} color={danger ? color.danger : color.ink} />
      </View>
      <Text style={[type.body, { fontWeight: '500', color: danger ? color.danger : color.ink }]}>{title}</Text>
    </Pressable>
  );
}

/** A small "via Slack" tag for a bot that lives outside the app (Sheldon), like the web's badge. */
export function OutsideTag({ bot }: { bot: { outside?: { via: string } | null } }) {
  if (!bot.outside) return null;
  return (
    <View accessibilityLabel="Linked through Slack" style={{ alignSelf: 'flex-start', paddingHorizontal: 6, borderRadius: 4, backgroundColor: color.slackFill }}>
      <Text style={{ fontSize: 11, lineHeight: 16, fontWeight: '600', letterSpacing: 0.3, color: color.slackInk }}>via Slack</Text>
    </View>
  );
}

/** A floating bar at the bottom of the screen with one action, such as Undo (plugin switches, New conversation). */
export function UndoBar({ text, action = 'Undo', onPress }: { text: string; action?: string | null; onPress?: () => void }) {
  // Above the phone's gesture bar, not under it.
  const insets = useSafeAreaInsets();
  return (
    <View accessibilityLiveRegion="polite" pointerEvents="box-none" style={{ position: 'absolute', left: 16, right: 16, bottom: Math.max(insets.bottom, 8) + 16, alignItems: 'center' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: color.primary, borderRadius: 999, paddingLeft: 18, paddingRight: action ? 6 : 18, paddingVertical: action ? 6 : 14, maxWidth: '100%', elevation: 6 }}>
        <Text numberOfLines={2} style={{ color: color.onPrimary, fontSize: 15, flexShrink: 1 }}>{text}</Text>
        {!!action && (
          <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={action} hitSlop={8}
            style={({ pressed }) => ({ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: pressed ? 'rgba(127,127,127,0.25)' : 'transparent' })}>
            <Text style={{ color: color.onPrimary, fontSize: 15, fontWeight: '700' }}>{action}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** The look of a pull-to-refresh spinner in light and dark: `<RefreshControl {...refreshLook()} …/>`. */
export const refreshLook = () => ({ tintColor: color.inkMuted, colors: [color.ink], progressBackgroundColor: color.surface });
