'use strict';
// The page shown when YBots cannot be reached. It says what most likely went wrong, tries again by
// itself (after 5, 10, 20 and then every 30 seconds), and tries at once when the network comes back.
const $ = (id) => document.getElementById(id);
let timer = null;
let going = false;

function retry() {
  if (going) return;
  going = true;
  clearInterval(timer);
  $('countdown').textContent = 'Trying again…';
  $('retry').disabled = true;
  window.cleftSetup.openApp();
}

window.cleftSetup.offlineInfo().then((info) => {
  $('title').textContent = info.title;
  $('hint').textContent = info.hint;
  if (info.address) $('where').textContent = `Address: ${info.address}`;
  if (info.details) $('reason').textContent = `Details: ${info.details}`;
  if (!info.retryIn) { $('countdown').textContent = ''; return; }
  let left = info.retryIn;
  const tick = () => {
    if (left <= 0) return retry();
    $('countdown').textContent = navigator.onLine === false ? 'Waiting for the network to come back…' : `Trying again in ${left} second${left === 1 ? '' : 's'}…`;
    // No countdown while the PC itself is offline: the 'online' event below starts the retry.
    if (navigator.onLine !== false) left--;
  };
  tick();
  timer = setInterval(tick, 1000);
}, () => { $('countdown').textContent = ''; });

window.addEventListener('online', () => setTimeout(retry, 1500));
$('retry').addEventListener('click', retry);
$('change').addEventListener('click', () => { location.href = 'setup.html?mode=address'; });
