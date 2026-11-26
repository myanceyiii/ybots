// App-icon shortcuts (hold the icon on the home screen). Static shortcuts: an XML list the launcher reads,
// each one a link the app already understands (src/quick.ts). No native code.
const { withAndroidManifest, withStringsXml, withDangerousMod, AndroidConfig } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/** shortcuts: [{ id, short, long, url }], at most four; `url` must not contain "&". */
module.exports = function withShortcuts(config, { shortcuts }) {
  const pkg = config.android.package;
  config = withStringsXml(config, (c) => {
    for (const s of shortcuts) {
      c.modResults = AndroidConfig.Strings.setStringItem([
        { $: { name: `shortcut_${s.id}_short`, translatable: 'false' }, _: s.short },
        { $: { name: `shortcut_${s.id}_long`, translatable: 'false' }, _: s.long },
      ], c.modResults);
    }
    return c;
  });
  config = withAndroidManifest(config, (c) => {
    const main = AndroidConfig.Manifest.getMainActivityOrThrow(c.modResults);
    main['meta-data'] = (main['meta-data'] ?? []).filter((m) => m.$['android:name'] !== 'android.app.shortcuts');
    main['meta-data'].push({ $: { 'android:name': 'android.app.shortcuts', 'android:resource': '@xml/shortcuts' } });
    return c;
  });
  return withDangerousMod(config, ['android', async (c) => {
    const dir = path.join(c.modRequest.platformProjectRoot, 'app/src/main/res/xml');
    fs.mkdirSync(dir, { recursive: true });
    const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const items = shortcuts.map((s) => `  <shortcut android:shortcutId="${esc(s.id)}" android:enabled="true" android:icon="@mipmap/ic_launcher"
    android:shortcutShortLabel="@string/shortcut_${s.id}_short" android:shortcutLongLabel="@string/shortcut_${s.id}_long">
    <intent android:action="android.intent.action.VIEW" android:targetPackage="${esc(pkg)}" android:targetClass="${esc(pkg)}.MainActivity" android:data="${esc(s.url)}" />
  </shortcut>`).join('\n');
    fs.writeFileSync(path.join(dir, 'shortcuts.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">\n${items}\n</shortcuts>\n`);
    return c;
  }]);
};
