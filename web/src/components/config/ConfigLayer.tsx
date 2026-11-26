import { useConfigUI } from '../../configStore';
import { lazily } from '../../lib/lazy';

// Settings are most of the app's code and are opened rarely: they load when first opened.
const AppSettings = lazily(() => import('./AppSettings').then((m) => m.AppSettings));
const BotSettingsModal = lazily(() => import('./BotSettingsModal').then((m) => m.BotSettingsModal));

/** Overlays owned by the settings feature: bot settings dialog and the app settings page. */
export function ConfigLayer() {
  const botSettings = useConfigUI((s) => !!s.botSettings);
  const appSettings = useConfigUI((s) => !!s.appSettings);
  return (
    <>
      {appSettings && <AppSettings />}
      {botSettings && <BotSettingsModal />}
    </>
  );
}
