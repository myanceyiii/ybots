'use strict';
// The right-click menu. Electron shows none by default, so until 0.9.0 right-clicking in the Windows app
// did nothing: no Paste, no spelling suggestions, no "Copy link". This builds the usual one from what
// was clicked.

const { Menu, clipboard } = require('electron');

const webLink = (url) => /^(https?:|mailto:)/i.test(url ?? '');

/**
 * The menu's rows for a click, as plain data (labels and what each does), so it can be tested without
 * a window. `p` is Electron's context-menu params.
 */
function contextTemplate(p, { dev = false } = {}) {
  const t = [];
  const sep = () => { if (t.length && t[t.length - 1].type !== 'separator') t.push({ type: 'separator' }); };
  if (p.misspelledWord) {
    const fixes = (p.dictionarySuggestions ?? []).slice(0, 6);
    for (const s of fixes) t.push({ label: s, do: 'replace', arg: s });
    if (!fixes.length) t.push({ label: 'No spelling suggestions', enabled: false });
    t.push({ label: `Add “${p.misspelledWord.slice(0, 40)}” to the dictionary`, do: 'learn', arg: p.misspelledWord });
    sep();
  }
  if (p.linkURL && webLink(p.linkURL)) {
    t.push({ label: p.linkURL.startsWith('mailto:') ? 'Write an email' : 'Open link in your browser', do: 'open', arg: p.linkURL });
    t.push({ label: p.linkURL.startsWith('mailto:') ? 'Copy email address' : 'Copy link', do: 'copy-text', arg: p.linkURL.replace(/^mailto:/i, '').split('?')[0] });
    sep();
  }
  if (p.mediaType === 'image' && p.hasImageContents !== false) {
    t.push({ label: 'Copy picture', do: 'copy-image' });
    if (/^(https?:|data:|blob:)/i.test(p.srcURL ?? '')) t.push({ label: 'Save picture as…', do: 'save', arg: p.srcURL });
    sep();
  }
  const flags = p.editFlags ?? {};
  const selected = !!(p.selectionText ?? '').trim();
  if (p.isEditable) {
    t.push({ label: 'Cut', role: 'cut', enabled: !!flags.canCut && selected });
    t.push({ label: 'Copy', role: 'copy', enabled: !!flags.canCopy && selected });
    t.push({ label: 'Paste', role: 'paste', enabled: !!flags.canPaste });
    t.push({ label: 'Paste as plain text', role: 'pasteAndMatchStyle', enabled: !!flags.canPaste });
    sep();
    t.push({ label: 'Select all', role: 'selectAll', enabled: flags.canSelectAll !== false });
  } else if (selected) {
    t.push({ label: 'Copy', role: 'copy' });
    const words = p.selectionText.trim().replace(/\s+/g, ' ');
    t.push({ label: `Search the web for “${words.length > 28 ? `${words.slice(0, 27)}…` : words}”`, do: 'open', arg: `https://www.google.com/search?q=${encodeURIComponent(words.slice(0, 500))}` });
    sep();
    t.push({ label: 'Select all', role: 'selectAll' });
  }
  if (dev) { sep(); t.push({ label: 'Inspect', do: 'inspect' }); }
  while (t.length && t[t.length - 1].type === 'separator') t.pop();
  return t;
}

function attachContextMenu(contents, { openExternal, dev = false }) {
  contents.on('context-menu', (_event, p) => {
    const rows = contextTemplate(p, { dev });
    if (!rows.length) return;
    const act = (row) => () => {
      if (row.do === 'replace') contents.replaceMisspelling(row.arg);
      else if (row.do === 'learn') contents.session.addWordToSpellCheckerDictionary(row.arg);
      else if (row.do === 'open') openExternal(row.arg);
      else if (row.do === 'copy-text') clipboard.writeText(row.arg);
      else if (row.do === 'copy-image') contents.copyImageAt(p.x, p.y);
      else if (row.do === 'save') contents.downloadURL(row.arg);
      else if (row.do === 'inspect') contents.inspectElement(p.x, p.y);
    };
    Menu.buildFromTemplate(rows.map((r) => (r.type === 'separator' ? r : { label: r.label, enabled: r.enabled !== false, ...(r.role ? { role: r.role } : { click: act(r) }) }))).popup();
  });
}

module.exports = { attachContextMenu, contextTemplate };
