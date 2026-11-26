'use strict';
// Downloads (a bot's file, a Page saved as Word or PDF, a picture). Either Windows' own Save dialog,
// opening in Downloads with the file's own name and type, or straight into Downloads with a free name
// ("report (1).pdf"), as picked in the app's settings. The taskbar button shows the progress, and a
// notice at the end opens the folder with the file picked. A failed download says so.

const { Notification, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { freeName } = require('./policy');

function createDownloads({ app, getWin, getSettings, toastsReady, log }) {
  const active = new Set();
  let last = null;

  function folder() {
    const picked = getSettings().downloads.folder;
    try { if (picked && fs.statSync(picked).isDirectory()) return picked; } catch { /* gone: fall back */ }
    return app.getPath('downloads');
  }

  function progress() {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    if (!active.size) { win.setProgressBar(-1); return; }
    let total = 0, got = 0, unknown = false;
    for (const i of active) { const t = i.getTotalBytes(); if (!t) unknown = true; total += t; got += i.getReceivedBytes(); }
    win.setProgressBar(unknown || !total ? 2 : Math.min(1, got / total), unknown || !total ? { mode: 'indeterminate' } : undefined);
  }

  function notice(title, body, onClick) {
    if (!toastsReady() || !Notification.isSupported()) return;
    const n = new Notification({ title: title.slice(0, 120), body, silent: true });
    if (onClick) n.on('click', onClick);
    n.show();
  }

  function onDownload(_event, item) {
    const name = item.getFilename() || 'file';
    const ext = path.extname(name).slice(1);
    const dir = folder();
    if (getSettings().downloads.ask) {
      item.setSaveDialogOptions({
        title: `Save ${name}`,
        defaultPath: path.join(dir, name),
        ...(ext ? { filters: [{ name: `${ext.toUpperCase()} file`, extensions: [ext] }, { name: 'All files', extensions: ['*'] }] } : {}),
      });
    } else {
      item.setSavePath(path.join(dir, freeName(name, (n) => fs.existsSync(path.join(dir, n)))));
    }
    active.add(item);
    item.on('updated', progress);
    item.once('done', (_e, state) => {
      active.delete(item);
      progress();
      const saved = item.getSavePath();
      if (state === 'completed' && saved) {
        last = saved;
        log.info('download finished');
        notice(`Downloaded ${path.basename(saved)}`, 'Click to show it in its folder.', () => shell.showItemInFolder(saved));
      } else if (state === 'interrupted') {
        log.warn('download interrupted');
        notice(`Couldn't download ${name}`, 'The connection dropped before it finished. Try it again from the chat.');
      }
    });
    progress();
  }

  return {
    onDownload,
    folder,
    showLast: () => { if (last && fs.existsSync(last)) shell.showItemInFolder(last); else shell.openPath(folder()); },
    get last() { return last; },
  };
}

module.exports = { createDownloads };
