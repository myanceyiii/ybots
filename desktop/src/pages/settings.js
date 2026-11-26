'use strict';
const $ = (id) => document.getElementById(id);
const clean = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const say = (err) => { $('error').textContent = err ? clean(err) : ''; };
let state = null;
let startedWithAccel = null;
// The shortcut recorders: Quick Chat's and Talk's. `recording` is the one listening for keys, or null.
const TARGETS = [
  { key: 'quickChat', state: 'quickShortcut', button: 'shortcut', clear: 'shortcut-clear', error: 'shortcut-error' },
  { key: 'talk', state: 'talkShortcut', button: 'talk-shortcut', clear: 'talk-shortcut-clear', error: 'talk-shortcut-error' },
];
let recording = null;

const at = (obj, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

function render(s) {
  state = s;
  if (startedWithAccel === null) startedWithAccel = s.settings.hardwareAcceleration;
  $('startAtLogin').checked = s.startAtLogin;
  for (const el of document.querySelectorAll('input[data-key]')) el.checked = !!at(s.settings, el.dataset.key);
  $('restart-note').hidden = s.settings.hardwareAcceleration === startedWithAccel;
  for (const k of ['notifications.sound', 'notifications.flash']) document.querySelector(`input[data-key="${k}"]`).disabled = !s.settings.notifications.enabled;
  $('paused-note').hidden = !s.paused;
  if (s.paused) $('paused-text').textContent = `Notifications are paused until ${new Date(s.settings.notifications.pausedUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`;
  $('toast-note').textContent = s.toasts ? 'Notifications show as Windows notifications and stay in the Notification Centre.' : 'Windows notifications could not be set up on this PC, so they show as a balloon by the tray icon instead.';
  for (const t of TARGETS) {
    const conf = s.settings[t.key] ?? { shortcut: '', enabled: false };
    if (recording !== t) $(t.button).textContent = conf.shortcut || 'No shortcut. Click to set one.';
    $(t.button).disabled = !conf.enabled;
    $(t.clear).hidden = !conf.shortcut;
    $(t.error).textContent = conf.enabled ? (s[t.state]?.error ?? '') : '';
  }
  $('zoom').textContent = `${s.zoom}%`;
  $('downloads-folder').textContent = s.downloadsFolder;
  $('reset-downloads').hidden = !s.settings.downloads.folder;
  $('remote-status').textContent = s.remote ? `${s.remote}.` : '';
  const u = s.update;
  const working = !!u && ['checking', 'downloading', 'unpacking'].includes(u.phase);
  $('update-status').textContent = u?.text || (u?.lastCheck ? `Last checked ${new Date(u.lastCheck).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : 'Not checked yet.');
  $('check-updates').disabled = working;
  $('restart-to-update').hidden = !(u && u.phase === 'ready' && u.canApply);
  $('update-notes').hidden = !(u && u.phase === 'ready' && u.notes);
  $('update-notes').textContent = u?.notes ? `What's new: ${u.notes}` : '';
  $('about').textContent = `YBots for Windows ${s.version}${s.packaged ? '' : ' (development run)'}. ${s.address ? `Connected to ${s.address}.` : 'No address set yet.'}`;
}

for (const el of document.querySelectorAll('input[data-key]')) {
  el.addEventListener('change', () => { say(); window.cleftApp.set(el.dataset.key, el.checked).then(render, (e) => { say(e); el.checked = !el.checked; }); });
}
$('startAtLogin').addEventListener('change', (e) => { say(); window.cleftApp.startAtLogin(e.target.checked).then(render, say); });
for (const el of document.querySelectorAll('button[data-action]')) {
  el.addEventListener('click', () => {
    say();
    window.cleftApp.action(el.dataset.action).then((s) => {
      render(s);
      if (el.id === 'copy-diag') { el.textContent = 'Copied'; setTimeout(() => { el.textContent = 'Copy diagnostics'; }, 1500); }
    }, say);
  });
}
$('resume').addEventListener('click', () => window.cleftApp.set('notifications.pausedUntil', 0).then(render, say));
$('done').addEventListener('click', () => window.close());

// ----- the shortcut recorder -----
const KEYS = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', '+': '=', Escape: null };
function accelerator(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
  let key = e.key in KEYS ? KEYS[e.key] : e.key;
  if (!key) return null;
  // The letter or digit on the key itself, whatever Shift or Alt turned it into.
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (key.length === 1) key = key.toUpperCase();
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super', key].filter(Boolean).join('+');
}
function stopRecording() {
  const t = recording;
  recording = null;
  if (t) $(t.button).classList.remove('recording');
  if (state) render(state);
}
for (const t of TARGETS) {
  $(t.button).addEventListener('click', () => {
    if (recording) return stopRecording();
    recording = t;
    say();
    $(t.error).textContent = '';
    $(t.button).classList.add('recording');
    $(t.button).textContent = 'Press the keys… (Esc to cancel)';
  });
  $(t.button).addEventListener('blur', () => { if (recording === t) stopRecording(); });
  $(t.clear).addEventListener('click', () => window.cleftApp.set(`${t.key}.shortcut`, '').then(render, say));
}
window.addEventListener('keydown', (e) => {
  const t = recording;
  if (!t) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') return stopRecording();
  const acc = accelerator(e);
  if (!acc) return; // only modifiers so far
  recording = null;
  $(t.button).classList.remove('recording');
  window.cleftApp.set(`${t.key}.shortcut`, acc).then(render, (err) => { if (state) render(state); $(t.error).textContent = clean(err); });
}, true);

window.cleftApp.onChange(render);
window.cleftApp.get().then(render, say);
