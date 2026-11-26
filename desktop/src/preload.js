'use strict';
// Only our own local pages (first-run setup, the offline page, settings, find, Quick Chat, "Use this PC"
// and the in-use bar) get
// these calls. The YBots web app gets cleftShell: show the window, a notification while it is hidden
// or not in front, and the chat to open when one is clicked; main.js checks they come from the app's own
// address. Nothing here can answer an approval.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('cleftSetup', {
    getSettings: () => ipcRenderer.invoke('cleft:get-settings'),
    saveAddress: (address) => ipcRenderer.invoke('cleft:save-address', address),
    openApp: () => ipcRenderer.invoke('cleft:open-app'),
    signInWithLink: (link) => ipcRenderer.invoke('cleft:sign-in-link', link),
    startPairing: () => ipcRenderer.invoke('cleft:pair-start'),
    stopPairing: () => ipcRenderer.invoke('cleft:pair-stop'),
    onPairUpdate: (fn) => ipcRenderer.on('cleft:pair-update', (_e, update) => fn(update)),
    // Only ever a sign-in link for this YBots (main.js checks), for the "Paste" button.
    clipboardLink: () => ipcRenderer.invoke('cleft:read-clipboard-link'),
    offlineInfo: () => ipcRenderer.invoke('cleft:offline-info'),
  });
  // The app's own settings window.
  contextBridge.exposeInMainWorld('cleftApp', {
    get: () => ipcRenderer.invoke('cleft:prefs-get'),
    set: (key, value) => ipcRenderer.invoke('cleft:prefs-set', key, value),
    startAtLogin: (on) => ipcRenderer.invoke('cleft:start-at-login', !!on),
    action: (name) => ipcRenderer.invoke('cleft:action', String(name)),
    onChange: (fn) => ipcRenderer.on('cleft:prefs', (_e, s) => fn(s)),
  });
  // Find on the page (the small bar at the top right).
  contextBridge.exposeInMainWorld('cleftFind', {
    find: (text, opts) => ipcRenderer.send('cleft:find', String(text ?? ''), { forward: opts?.forward !== false, again: !!opts?.again }),
    stop: () => ipcRenderer.send('cleft:find-stop'),
    onResult: (fn) => ipcRenderer.on('cleft:find-result', (_e, r) => fn(r)),
    onFocus: (fn) => ipcRenderer.on('cleft:find-focus', (_e, text) => fn(String(text ?? ''))),
  });
  // Quick Chat: list the bots, send one message, open a chat. It cannot answer an approval.
  contextBridge.exposeInMainWorld('cleftQuick', {
    bots: () => ipcRenderer.invoke('cleft:quick-bots'),
    send: (botId, text) => ipcRenderer.invoke('cleft:quick-send', String(botId), String(text ?? '')),
    open: (botId) => ipcRenderer.invoke('cleft:quick-open', botId ? String(botId) : ''),
    hide: () => ipcRenderer.invoke('cleft:quick-hide'),
    files: () => ipcRenderer.invoke('cleft:quick-files'),
    screenshot: () => ipcRenderer.invoke('cleft:quick-screenshot'),
    pasteImage: () => ipcRenderer.invoke('cleft:quick-paste-image'),
    pickFiles: () => ipcRenderer.invoke('cleft:quick-pick-files'),
    // Files dropped on the window: only their paths cross over, and the shell reads them.
    drop: (fileList) => ipcRenderer.invoke('cleft:quick-drop', [...(fileList ?? [])].map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean)),
    remove: (id) => ipcRenderer.invoke('cleft:quick-remove', String(id)),
    onShow: (fn) => ipcRenderer.on('cleft:quick-show', (_e, info) => fn(info ?? {})),
  });
  contextBridge.exposeInMainWorld('cleftRemote', {
    get: () => ipcRenderer.invoke('cleft:remote-get'),
    pair: () => ipcRenderer.invoke('cleft:remote-pair'),
    stopPairing: () => ipcRenderer.invoke('cleft:remote-pair-stop'),
    enable: (on) => ipcRenderer.invoke('cleft:remote-enable', on),
    addFolder: () => ipcRenderer.invoke('cleft:remote-add-folder'),
    removeFolder: (p) => ipcRenderer.invoke('cleft:remote-remove-folder', p),
    openFolder: (p) => ipcRenderer.invoke('cleft:remote-open-folder', String(p)),
    clearLog: () => ipcRenderer.invoke('cleft:remote-clear-log'),
    set: (key, value) => ipcRenderer.invoke('cleft:remote-set', key, value),
    forget: () => ipcRenderer.invoke('cleft:remote-forget'),
    onUpdate: (fn) => ipcRenderer.on('cleft:remote-update', (_e, s) => fn(s)),
    onPair: (fn) => ipcRenderer.on('cleft:remote-pair', (_e, s) => fn(s)),
  });
  contextBridge.exposeInMainWorld('cleftBar', {
    onText: (fn) => ipcRenderer.on('cleft:bar', (_e, t) => fn(t)),
    stop: () => ipcRenderer.send('cleft:bar-stop'),
  });
}

if (location.protocol === 'https:' || location.protocol === 'http:') {
  contextBridge.exposeInMainWorld('cleftShell', {
    show: () => ipcRenderer.send('cleft:app-show'),
    notify: (title, body, opts) => ipcRenderer.send('cleft:app-notify', String(title ?? ''), String(body ?? ''),
      { botId: typeof opts?.botId === 'string' ? opts.botId : undefined, silent: !!opts?.silent, tag: typeof opts?.tag === 'string' ? opts.tag : undefined,
        // The bot's face, drawn round by the page as a PNG data URL (0.7.7+).
        icon: typeof opts?.icon === 'string' && opts.icon.startsWith('data:image/png;base64,') && opts.icon.length < 400_000 ? opts.icon : undefined }),
    setTheme: (theme) => ipcRenderer.send('cleft:app-theme', theme === 'light' || theme === 'dark' ? theme : 'system'),
    // Take down notifications that no longer apply (an approval answered or a chat read on another device).
    clear: (tags) => ipcRenderer.send('cleft:app-notify-clear', Array.isArray(tags) ? tags.filter((t) => typeof t === 'string').slice(0, 200) : []),
    // A click on one of those notifications: the web app opens that chat.
    onOpenChat: (fn) => ipcRenderer.on('cleft:open-chat', (_e, botId) => fn(String(botId))),
    // The Talk shortcut or tray item: the web app opens the talk Bot's chat and starts dictating.
    onTalk: (fn) => ipcRenderer.on('cleft:talk', () => fn()),
    // The Talk popup (talkpopup.js, 0.13.0+): the page /?talk&popup=1 in a small window at the bottom of the screen.
    // main.js only answers these from that window, on the signed-in address.
    talkPopup: {
      resize: (height) => ipcRenderer.invoke('cleft:talk-size', Number(height) || 0),
      close: () => ipcRenderer.invoke('cleft:talk-close'),
      openChat: (botId) => ipcRenderer.invoke('cleft:talk-open', typeof botId === 'string' ? botId : null),
      captureScreen: () => ipcRenderer.invoke('cleft:talk-capture'),
      busy: (on) => ipcRenderer.invoke('cleft:talk-busy', !!on),
      onStart: (fn) => ipcRenderer.on('cleft:talk-start', () => fn()),
      onStop: (fn) => ipcRenderer.on('cleft:talk-stop', () => fn()),
    },
  });
}
