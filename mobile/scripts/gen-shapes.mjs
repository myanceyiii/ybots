// Writes src/shapes.json from the server's bot shapes, so the phone draws the same characters.
// Run from mobile/: node --experimental-strip-types scripts/gen-shapes.mjs
import fs from 'node:fs';
const { SHAPES } = await import('../../server/src/avatar-shapes.ts');
fs.writeFileSync(new URL('../src/shapes.json', import.meta.url), JSON.stringify(SHAPES));
console.log(`${Object.keys(SHAPES).length} shapes written`);
