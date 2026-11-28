/**
 * A bar under the status bar when this app is older than the oldest one the server still works with
 * (server/src/app-support.ts, GET /api/app-support). It says so plainly and, when the server names one,
 * offers the place to get the new version. Nothing shows when the app is new enough or the check failed.
 */
import Constants from 'expo-constants';
import { Linking, Pressable, Text, View } from 'react-native';
import { versionBelow } from '../appSupport';
import { color } from '../theme';

export interface AppSupport { minApp: { android: string }; updateUrl: { android: string | null } }

export const appVersion = (): string | null => Constants.expoConfig?.version ?? null;

export function UpdateBanner({ support }: { support: AppSupport | null }) {
  const mine = appVersion();
  if (!support || !versionBelow(mine, support.minApp.android)) return null;
  const url = support.updateUrl.android;
  return (
    <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 16, backgroundColor: color.problemFill }}>
      <Text style={{ flex: 1, fontSize: 13.5, color: color.warnInk }}>
        This app ({mine}) is too old for your server, so some things will not work. Update YBots to {support.minApp.android} or newer.
      </Text>
      {url && (
        <Pressable accessibilityRole="link" onPress={() => { void Linking.openURL(url).catch(() => {}); }} hitSlop={8}>
          <Text style={{ fontSize: 13.5, fontWeight: '700', color: color.link }}>Update</Text>
        </Pressable>
      )}
    </View>
  );
}
