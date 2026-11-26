'use strict';
// The bar at the top of the screen while someone watches this PC or a bot works on it. Stop turns
// remote use off at once (the link closes and every viewer is dropped).
window.cleftBar.onText((text) => { document.getElementById('text').textContent = text; });
document.getElementById('stop').addEventListener('click', () => window.cleftBar.stop());
