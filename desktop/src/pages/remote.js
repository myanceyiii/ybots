'use strict';
const $ = (id) => document.getElementById(id);
const say = (err) => { $('error').textContent = err ? String(err.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : ''; };
let state = null;
let countdown = null;

function li(text, ...buttons) {
  const el = document.createElement('li');
  const span = document.createElement('span');
  span.textContent = text;
  el.append(span, ...buttons.filter(Boolean));
  return el;
}
const button = (label, fn) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'secondary'; b.textContent = label;
  b.addEventListener('click', fn);
  return b;
};
/** "Today 3:42 PM", "Yesterday 9:05 AM", then the date: the list is read for "when was that?". */
function when(at) {
  const d = new Date(at);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}
let forgetArmed = null;

function render(s) {
  state = s;
  $('status').textContent = s.statusText;
  $('dot').className = `dot ${s.status === 'online' ? (s.viewers ? 'watch' : 'on') : ''}`;
  $('device').textContent = `${s.device}${s.keyProtected ? '' : ' · Windows cannot protect a key here, so pairing is not possible.'}`;
  $('pair').hidden = s.paired;
  $('pair').disabled = !s.keyProtected;
  $('toggle').hidden = !s.paired;
  $('toggle').textContent = s.enabled ? 'Turn off' : 'Turn on';
  $('settings').hidden = !s.paired;
  $('log-card').hidden = !s.paired && !s.log.length;
  $('clear-log').hidden = !s.log.length;
  $('forget').hidden = !s.paired;
  $('folders').replaceChildren(...(s.folders.length ? s.folders.map((f) => {
    const row = li(f.missing ? `${f.path} (no longer there)` : f.path,
      f.missing ? null : button('Open', () => { say(); window.cleftRemote.openFolder(f.path).catch(say); }),
      button('Stop sharing', () => window.cleftRemote.removeFolder(f.path).then(render, say)));
    if (f.missing) row.classList.add('missing');
    return row;
  }) : [li('No folders shared yet.')]));
  $('commands').checked = s.commands;
  $('screen').checked = s.screen;
  $('control').checked = s.screen && s.control;
  $('control').disabled = !s.screen;
  $('clipboard').checked = s.screen && s.control && s.clipboard;
  $('clipboard').disabled = !(s.screen && s.control);
  if (document.activeElement !== $('blocked')) $('blocked').value = s.blocked.join(', ');
  $('log').replaceChildren(...s.log.map((l) => {
    const el = document.createElement('li');
    const t = document.createElement('time');
    t.textContent = when(l.at);
    t.title = new Date(l.at).toLocaleString();
    el.append(t, document.createTextNode(l.text));
    return el;
  }));
}

async function pair() {
  say();
  clearInterval(countdown);
  $('pair-card').hidden = false;
  $('pair-qr').innerHTML = '';
  $('pair-error').textContent = '';
  $('pair-status').textContent = 'Making a code…';
  try {
    const p = await window.cleftRemote.pair();
    $('pair-qr').innerHTML = p.svg; // made here from the pairing address, not from the server's text
    $('pair-code').textContent = p.code;
    const tick = () => {
      const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
      $('pair-status').textContent = left ? `Waiting for your phone. This code works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.` : 'This code has expired. Try again.';
      if (!left) { clearInterval(countdown); $('pair-qr').innerHTML = ''; }
    };
    tick();
    countdown = setInterval(tick, 1000);
  } catch (e) {
    $('pair-status').textContent = '';
    $('pair-error').textContent = String(e.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
}

window.cleftRemote.onUpdate((s) => { render(s); if (s.paired) { clearInterval(countdown); $('pair-card').hidden = true; } });
window.cleftRemote.onPair(({ state: st }) => {
  clearInterval(countdown);
  $('pair-qr').innerHTML = '';
  $('pair-status').textContent = st === 'denied' ? 'Your phone said no.' : 'This code has expired. Try again.';
});
$('pair').addEventListener('click', pair);
$('pair-cancel').addEventListener('click', () => { clearInterval(countdown); window.cleftRemote.stopPairing(); $('pair-card').hidden = true; });
$('toggle').addEventListener('click', () => window.cleftRemote.enable(!state.enabled).then(render, say));
$('add-folder').addEventListener('click', () => window.cleftRemote.addFolder().then(render, say));
$('commands').addEventListener('change', (e) => window.cleftRemote.set('commands', e.target.checked).then(render, say));
$('screen').addEventListener('change', (e) => window.cleftRemote.set('screen', e.target.checked).then(render, say));
$('control').addEventListener('change', (e) => window.cleftRemote.set('control', e.target.checked).then(render, say));
$('clipboard').addEventListener('change', (e) => window.cleftRemote.set('clipboard', e.target.checked).then(render, say));
const saveBlocked = () => window.cleftRemote.set('blocked', $('blocked').value.split(',')).then((s) => {
  $('blocked').blur();
  render(s);
  $('blocked-saved').textContent = 'Saved.';
  setTimeout(() => { $('blocked-saved').textContent = ''; }, 2000);
}, say);
$('save-blocked').addEventListener('click', saveBlocked);
$('blocked').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveBlocked(); } });
$('clear-log').addEventListener('click', () => window.cleftRemote.clearLog().then(render, say));
// Forgetting is asked twice: the first click only changes the button, and it changes back by itself.
$('forget').addEventListener('click', () => {
  if (!forgetArmed) {
    $('forget').textContent = 'Really forget? Click again';
    forgetArmed = setTimeout(() => { forgetArmed = null; $('forget').textContent = 'Forget this pairing'; }, 4000);
    return;
  }
  clearTimeout(forgetArmed);
  forgetArmed = null;
  $('forget').textContent = 'Forget this pairing';
  window.cleftRemote.forget().then(render, say);
});
$('back').addEventListener('click', () => window.cleftSetup.openApp());

window.cleftRemote.get().then(render, say);
