'use strict';
// Puts the YBots icon and name into YanceyBot.exe after packing. electron-builder does this with
// rcedit, which needs wine on Linux; resedit (MIT, plain JavaScript) does it anywhere.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const { productFilename } = context.packager.appInfo;
  const version = context.packager.appInfo.version;
  const exe = path.join(context.appOutDir, `${productFilename}.exe`);
  const ico = path.join(__dirname, 'icon.ico');

  const program = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(program);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const id = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, iconFile.icons.map((i) => i.data));

  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (vi) {
    const [a, b, c] = version.split('.').map(Number);
    vi.setFileVersion(a, b, c, 0, 1033);
    vi.setProductVersion(a, b, c, 0, 1033);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      FileDescription: 'YBots',
      ProductName: 'YBots',
      InternalName: 'YBots',
      OriginalFilename: `${productFilename}.exe`,
      CompanyName: 'YBots',
      LegalCopyright: 'MIT License',
    });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(program);
  fs.writeFileSync(exe, Buffer.from(program.generate()));
};
