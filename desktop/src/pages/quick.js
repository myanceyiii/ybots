'use strict';
// Quick Chat: pick a bot, type, Enter. Alt+1..9 or Tab picks the bot, Shift+Enter makes a new line,
// Esc puts the window away. The answer arrives in the chat itself.
const $ = (id) => document.getElementById(id);
const clean = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const HINT = 'Enter sends · Shift+Enter new line · Esc closes';
let attached = [];
let bots = [];
let picked = '';
let sending = false;
let loadedAt = 0;

function say(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`.trim();
}

function ready() {
  $('send').disabled = sending || !picked || (!$('text').value.trim() && !attached.length);
}

/** The files that will go with the message, each with a way to take it off again. */
function showFiles(list) {
  attached = Array.isArray(list) ? list : [];
  $('files').hidden = !attached.length;
  $('files').replaceChildren(...attached.map((f) => {
    const el = document.createElement('div');
    el.className = 'file';
    let pic;
    if (f.thumb) { pic = document.createElement('img'); pic.src = f.thumb; pic.alt = ''; }
    else { pic = document.createElement('span'); pic.className = 'doc'; pic.textContent = (f.name.includes('.') ? f.name.split('.').pop() : 'file').slice(0, 4); }
    const meta = document.createElement('span');
    meta.className = 'meta';
    const name = document.createElement('b');
    name.textContent = f.name;
    name.title = f.name;
    const size = document.createElement('small');
    size.textContent = f.size;
    meta.append(name, size);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'x';
    x.textContent = '×';
    x.title = `Remove ${f.name}`;
    x.setAttribute('aria-label', `Remove ${f.name}`);
    x.addEventListener('click', () => window.cleftQuick.remove(f.id).then(showFiles, (e) => say(clean(e), 'error')));
    el.append(pic, meta, x);
    return el;
  }));
  ready();
}
const attachWith = (fn) => fn().then((list) => { if (list) { showFiles(list); say(HINT); } $('text').focus(); return list; }, (e) => { say(clean(e), 'error'); window.cleftQuick.files().then(showFiles, () => {}); });

function pick(id, focusText = true) {
  picked = id;
  for (const el of $('bots').children) {
    const on = el.dataset.id === id;
    el.setAttribute('aria-checked', String(on));
    el.tabIndex = on ? 0 : -1;
    if (on) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  const bot = bots.find((b) => b.id === id);
  $('text').placeholder = bot ? `Message ${bot.name}` : 'Message';
  if (focusText) $('text').focus();
  ready();
}

function draw() {
  const row = $('bots');
  row.replaceChildren(...bots.map((b, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'bot';
    el.dataset.id = b.id;
    el.setAttribute('role', 'radio');
    const why = b.needs === 'waiting' ? ' is waiting for you' : b.needs === 'unread' ? ' has something new' : '';
    el.title = `${b.name}${why}${i < 9 ? ` (Alt+${i + 1})` : ''}`;
    if (b.needs) el.classList.add(b.needs);
    const face = document.createElement('span');
    face.className = `face ${b.color ?? ''}`.trim();
    face.textContent = (b.name.trim()[0] ?? '?').toUpperCase();
    face.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = b.name;
    el.append(face, name);
    if (i < 9) { const n = document.createElement('span'); n.className = 'n'; n.textContent = String(i + 1); n.setAttribute('aria-hidden', 'true'); el.append(n); }
    el.addEventListener('click', () => pick(b.id));
    return el;
  }));
  if (!bots.length) {
    const none = document.createElement('span');
    none.className = 'empty';
    none.textContent = 'No bots yet. Open YBots to make one.';
    row.append(none);
  }
}

async function load(lastBot) {
  try {
    bots = await window.cleftQuick.bots();
    loadedAt = Date.now();
    draw();
    const keep = bots.find((b) => b.id === picked) ?? bots.find((b) => b.id === lastBot) ?? bots[0];
    pick(keep ? keep.id : '');
    if (!$('status').classList.contains('ok')) say(bots.length ? HINT : '');
  } catch (err) {
    bots = [];
    draw();
    picked = '';
    ready();
    say(clean(err), 'error');
  }
}

async function send() {
  const text = $('text').value.trim();
  if (sending || !picked || (!text && !attached.length)) return;
  const bot = bots.find((b) => b.id === picked);
  sending = true;
  ready();
  say(attached.length ? `Sending ${attached.length === 1 ? '1 file' : `${attached.length} files`} to ${bot?.name ?? 'the bot'}…` : `Sending to ${bot?.name ?? 'the bot'}…`);
  try {
    await window.cleftQuick.send(picked, text);
    $('text').value = '';
    showFiles([]);
    say(`Sent to ${bot?.name ?? 'the bot'}. The answer will be in its chat.`, 'ok');
    setTimeout(() => { if ($('status').classList.contains('ok')) { say(HINT); window.cleftQuick.hide(); } }, 1100);
  } catch (err) {
    say(clean(err), 'error'); // the text stays in the box, to send again
  } finally {
    sending = false;
    ready();
  }
}

$('text').addEventListener('input', () => { ready(); if ($('status').classList.contains('error')) say(HINT); });
$('text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$('send').addEventListener('click', send);
$('shot').addEventListener('click', () => attachWith(() => window.cleftQuick.screenshot()));
$('attach').addEventListener('click', () => attachWith(() => window.cleftQuick.pickFiles()));
// Ctrl+V with a picture on the clipboard (a snip, a copied image) attaches it; text pastes as usual.
$('text').addEventListener('paste', (e) => {
  const types = [...(e.clipboardData?.types ?? [])];
  if (types.includes('text/plain') && e.clipboardData.getData('text/plain')) return;
  if (!types.includes('Files') && ![...(e.clipboardData?.items ?? [])].some((i) => i.type.startsWith('image/'))) return;
  e.preventDefault();
  attachWith(() => window.cleftQuick.pasteImage());
});
const quickBox = document.querySelector('.quick');
window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; quickBox.classList.add('dropping'); } });
window.addEventListener('dragleave', () => quickBox.classList.remove('dropping'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  quickBox.classList.remove('dropping');
  if (e.dataTransfer?.files?.length) attachWith(() => window.cleftQuick.drop(e.dataTransfer.files));
});
$('open').addEventListener('click', () => window.cleftQuick.open(picked));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); window.cleftQuick.hide(); return; }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); attachWith(() => window.cleftQuick.screenshot()); return; }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); attachWith(() => window.cleftQuick.pickFiles()); return; }
  if (e.altKey && /^[1-9]$/.test(e.key)) { const b = bots[Number(e.key) - 1]; if (b) { e.preventDefault(); pick(b.id); } return; }
  // Left and Right move between bots while the row has the focus.
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && document.activeElement?.classList.contains('bot')) {
    const at = bots.findIndex((b) => b.id === picked);
    const next = bots[(at + (e.key === 'ArrowRight' ? 1 : -1) + bots.length) % bots.length];
    if (next) { e.preventDefault(); pick(next.id, false); document.querySelector(`.bot[data-id="${CSS.escape(next.id)}"]`)?.focus(); }
  }
});

window.cleftQuick.onShow(({ lastBot, files }) => {
  $('text').focus();
  showFiles(files);
  // The list is read again each time the window opens, unless it was read a moment ago.
  if (Date.now() - loadedAt > 3000) load(lastBot);
});
say('');
