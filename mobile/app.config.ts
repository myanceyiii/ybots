import type { ExpoConfig } from 'expo/config';

/** The app's id is fixed once the first build is installed: Android cannot change it without a reinstall. */
const art = './assets/cleftbot';

const config: ExpoConfig = {
  name: 'YBots',
  slug: 'cleft-bot',
  version: '0.1.36',
  orientation: 'portrait',
  icon: `${art}/icon.png`,
  userInterfaceStyle: 'automatic',
  scheme: 'cleftbot',
  android: {
    // Your own build: set YBOTS_ANDROID_PACKAGE to an id of yours (docs/android.md).
    package: process.env.YBOTS_ANDROID_PACKAGE || 'com.yancey.cleftbot',
    versionCode: 30,
    adaptiveIcon: {
      backgroundColor: '#F5A63F',
      backgroundImage: `${art}/android-icon-background.png`,
      foregroundImage: `${art}/android-icon-foreground.png`,
      monochromeImage: `${art}/android-icon-monochrome.png`,
    },
    predictiveBackGestureEnabled: false,
    // Only what this build uses. RECORD_AUDIO and MODIFY_AUDIO_SETTINGS are for voice calls and dictation
    // (modules/cleft-voice: the microphone, and the speaker or headset in call mode). The last four are for slow
    // work in the background (modules/cleft-background): a foreground service that follows a drawing job,
    // its "done" note, and the opt-in "Keep running in the background" setting (Android asks the person).
    permissions: ['android.permission.CAMERA', 'android.permission.INTERNET',
      'android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
      'android.permission.POST_NOTIFICATIONS', 'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
      // The notification link (NotifyService): a service that stays on, and starts again after a restart.
      'android.permission.FOREGROUND_SERVICE_SPECIAL_USE', 'android.permission.RECEIVE_BOOT_COMPLETED',
      // Phone timers and alarms (modules/cleft-background PhoneActions.kt): the Clock app's intents, and
      // "Display over other apps", which the person may turn on so the app can open the Clock app from the
      // background (Android allows that only then). The app never draws over other apps with it.
      'com.android.alarm.permission.SET_ALARM', 'android.permission.SYSTEM_ALERT_WINDOW'],
    // Share text or a link to the app from any other app (src/quick.ts reads it; nothing is sent by itself).
    // The phone's assistant (the card over other apps) is declared by modules/cleft-assist, not here.
    intentFilters: [{ action: 'SEND', category: ['DEFAULT'], data: [{ mimeType: 'text/plain' }] }],
  },
  plugins: [
    ['expo-camera', { cameraPermission: 'Used to scan the sign-in code from your server.', microphonePermission: false, recordAudioAndroid: false }],
    // No cameraPermission: false here: it would block CAMERA, which the sign-in scanner needs. Nor
    // microphonePermission: false: it would block RECORD_AUDIO, which voice calls and dictation need.
    ['expo-image-picker', { photosPermission: 'Used to pick a picture for a bot.', microphonePermission: 'Used to talk to your bots and to dictate messages.' }],
    'expo-secure-store',
    ['expo-splash-screen', { image: `${art}/splash-icon.png`, imageWidth: 160, backgroundColor: '#FAFAFA' }],
    // Tailscale Serve gives the server an https address, so plain http is never needed.
    ['expo-build-properties', { android: { usesCleartextTraffic: false } }],
    // Hold the app icon for these (plugins/withShortcuts.js). Each opens a link src/quick.ts understands.
    ['./plugins/withShortcuts', { shortcuts: [
      { id: 'ask', short: 'New message', long: 'Message your main bot', url: 'cleftbot://ask' },
      { id: 'tasks', short: 'Tasks', long: 'Tasks', url: 'cleftbot://tasks' },
    ] }],
  ],
  extra: { variant: 'cleftbot' },
};

export default config;
