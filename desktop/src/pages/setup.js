'use strict';
const $ = (id) => document.getElementById(id);
const mode = new URLSearchParams(location.search).get('mode');
const say = (el, err) => { el.textContent = err ? String(err.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : ''; };

function showOnly(id) {
  for (const el of ['address-form', 'pair-card', 'link-form']) $(el).hidden = el !== id;
}

let countdown = null;
async function startPairing() {
  clearInterval(countdown);
  say($('pair-error'));
  $('pair-qr').innerHTML = '';
  $('pair-code').textContent = '…';
  $('pair-code-big').textContent = '';
  $('pair-copy').hidden = true;
  $('pair-status').textContent = 'Making a code…';
  try {
    const p = await window.cleftSetup.startPairing();
    if (p.needsAccess) {
      // This YBots sits behind Cloudflare Access: its sign-in opens in this window, and after it
      // the web app signs in on its own. No phone needed.
      $('pair-code').textContent = '…';
      $('pair-status').textContent = 'Opening the Cloudflare sign-in. Enter your email, then the code Cloudflare sends you.';
      setTimeout(() => window.cleftSetup.openApp(), 1200);
      return;
    }
    $('pair-qr').innerHTML = p.svg; // made by the app itself from the pairing address, not from the server's text
    $('pair-code').textContent = p.code;
    $('pair-code-big').textContent = p.code;
    $('pair-copy').hidden = false;
    $('pair-copy').onclick = () => {
      // Select-and-copy needs no clipboard permission, which local pages do not have.
      const range = document.createRange();
      range.selectNodeContents($('pair-code-big'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = document.execCommand('copy');
      sel.removeAllRanges();
      if (ok) { $('pair-copy').textContent = 'Copied'; setTimeout(() => { $('pair-copy').textContent = 'Copy code'; }, 1500); }
    };
    const tick = () => {
      const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
      $('pair-status').textContent = left ? `Waiting for your phone. This code works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.` : 'This code has expired. Make a new one.';
      if (!left) { clearInterval(countdown); $('pair-qr').innerHTML = ''; $('pair-code-big').textContent = ''; $('pair-copy').hidden = true; }
    };
    tick();
    countdown = setInterval(tick, 1000);
  } catch (err) {
    $('pair-status').textContent = '';
    say($('pair-error'), err);
  }
}

window.cleftSetup.onPairUpdate(({ state }) => {
  clearInterval(countdown);
  $('pair-qr').innerHTML = '';
  $('pair-code-big').textContent = '';
  $('pair-copy').hidden = true;
  $('pair-status').textContent = state === 'denied' ? 'Your phone said no. Make a new code to try again.' : 'This code has expired. Make a new one.';
});

$('pair-new').addEventListener('click', startPairing);
$('pair-link').addEventListener('click', () => { window.cleftSetup.stopPairing(); clearInterval(countdown); showOnly('link-form'); $('link').focus(); });
$('pair-open').addEventListener('click', () => window.cleftSetup.openApp());

async function init() {
  const { address, recent = [] } = await window.cleftSetup.getSettings();
  if (address) {
    $('address').value = address;
    $('current').textContent = `Connected to ${address}`;
    // Changing the address of an app that already has one: Cancel goes back without changing anything.
    $('address-back').hidden = false;
  }
  if (recent.length) {
    // Addresses used here before, one click to go back to.
    $('recent').hidden = false;
    $('recent').replaceChildren(...recent.map((a) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'secondary'; b.textContent = a.replace(/^https?:\/\//, ''); b.title = `Use ${a}`;
      b.addEventListener('click', () => { $('address').value = a; $('address-form').requestSubmit(); });
      return b;
    }));
  }
  if (mode === 'link' && address) {
    showOnly('link-form');
    $('link').focus();
  } else if (mode === 'pair' && address) {
    showOnly('pair-card');
    startPairing();
  } else {
    $('address').focus();
  }
}

$('address-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  say($('address-error'));
  try {
    await window.cleftSetup.saveAddress($('address').value);
    if (mode === 'address') await window.cleftSetup.openApp();
    else { showOnly('pair-card'); startPairing(); }
  } catch (err) {
    say($('address-error'), err);
  }
});

$('link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  say($('link-error'));
  try {
    await window.cleftSetup.signInWithLink($('link').value);
  } catch (err) {
    say($('link-error'), err);
  }
});

$('skip-link').addEventListener('click', () => window.cleftSetup.openApp());
$('address-back').addEventListener('click', () => window.cleftSetup.openApp());
$('address').addEventListener('input', () => say($('address-error')));
$('link').addEventListener('input', () => say($('link-error')));
// Paste puts in the clipboard's sign-in link, if that is what it holds (the app checks; nothing else is read).
$('link-paste').addEventListener('click', async () => {
  const link = await window.cleftSetup.clipboardLink().catch(() => '');
  if (link) { $('link').value = link; say($('link-error')); $('link-form').requestSubmit(); }
  else say($('link-error'), 'There is no YBots sign-in link on the clipboard. Copy it on your other device first.');
});

init();
