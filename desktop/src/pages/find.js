'use strict';
const q = document.getElementById('q');
const count = document.getElementById('count');
let timer = null;

function search(opts) {
  window.cleftFind.find(q.value, opts);
  if (!q.value) { count.textContent = ''; count.className = ''; }
}

// Typing searches after a short pause, so each letter is not a search of its own.
q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => search({ forward: true, again: false }), 120); });
document.getElementById('form').addEventListener('submit', (e) => e.preventDefault());
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); search({ forward: !e.shiftKey, again: true }); }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); window.cleftFind.stop(); }
  else if (e.key === 'F3' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g')) { e.preventDefault(); search({ forward: !e.shiftKey, again: true }); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); q.select(); }
});
document.getElementById('next').addEventListener('click', () => { search({ forward: true, again: true }); q.focus(); });
document.getElementById('prev').addEventListener('click', () => { search({ forward: false, again: true }); q.focus(); });
document.getElementById('close').addEventListener('click', () => window.cleftFind.stop());

window.cleftFind.onResult(({ matches, active }) => {
  if (!q.value) { count.textContent = ''; count.className = ''; return; }
  count.textContent = matches ? `${active} of ${matches}` : 'No matches';
  count.className = matches ? '' : 'none';
});
window.cleftFind.onFocus((text) => {
  if (text && !q.value) q.value = text;
  q.focus();
  q.select();
  if (q.value) search({ forward: true, again: false });
});
