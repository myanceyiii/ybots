// Every address the Android app calls is one the server answers. The phone is built and installed apart from
// the server, so a route renamed or dropped on the server leaves installed phones calling nothing (the server
// answers `no_route`). This reads each `req('METHOD', '/path')` in the phone's API files and matches it
// against the server's own route list (CLEFT_ROUTE_LIST, server/src/index.ts).
// Needs a built server: `npm run build -w server`, then `node tests/app-routes.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, startServer, until } from './lib/server.mjs';

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); } };

/** The phone files that call the server, and the prefix their paths sit under. */
const CLIENTS = [
  ['mobile/src/api.ts', '/api'],
];

/** The text of the string or template literal that opens at `i`, with each `${...}` given as {expr}. */
function literal(src, i) {
  const q = src[i]; const parts = []; let text = ''; i++;
  while (i < src.length && src[i] !== q) {
    if (src[i] === '\\') { text += src[i + 1]; i += 2; continue; }
    if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
      let depth = 1, j = i + 2;
      while (depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; else if (src[j] === '`') { j = literal(src, j).end; continue; } j++; }
      parts.push(text, { expr: src.slice(i + 2, j - 1) }); text = ''; i = j; continue;
    }
    text += src[i++];
  }
  parts.push(text);
  return { parts, end: i + 1 };
}

/**
 * `req('GET', `/bots/${id}/x?y=${z}`)` -> { method, paths: ['/api/bots/{}/x'] }. A `${...}` that adds a query
 * (`${fresh ? '?fresh=1' : ''}`) ends the path; one that picks between words (`${pc ? 'machines' : 'bots'}`)
 * gives a path for each word; any other stands for a segment, `{}`.
 */
export function calls(source, prefix) {
  const out = [];
  const re = /\breq(?:<[^()]*?>)?\(\s*(?:\w+\s*,\s*)?'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*(?=['`])/g;
  for (const m of source.matchAll(re)) {
    const { parts } = literal(source, m.index + m[0].length);
    let paths = [''];
    for (const part of parts) {
      if (typeof part === 'string') {
        const cut = part.indexOf('?');
        paths = paths.map((p) => p + (cut === -1 ? part : part.slice(0, cut)));
        if (cut !== -1) break;
        continue;
      }
      if (/['"`]\?/.test(part.expr)) break;
      const words = [...part.expr.matchAll(/'([a-z][\w-]*)'/g)].map((w) => w[1]);
      const pick = /\?/.test(part.expr) && /:/.test(part.expr) && words.length >= 2 ? words.slice(-2) : null;
      paths = pick ? paths.flatMap((p) => pick.map((w) => p + w)) : paths.map((p) => `${p}{}`);
    }
    const line = source.slice(0, m.index).split('\n').length;
    for (const p of paths) out.push({ method: m[1], path: `${prefix}${p}`, line });
  }
  return out;
}

const routeRe = (p) => new RegExp(`^${p.split('/').map((seg) => seg === '*' ? '.*' : seg.startsWith(':') ? '[^/]+' : seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('/')}$`);

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'routes-'));
const list = path.join(dir, 'routes.json');
const s = await startServer({ name: 'routes', dir, env: { CLEFT_ROUTE_LIST: list } });
try {
  await until('route list', () => fs.existsSync(list));
  // The catch-all that answers no_route, and middleware (method ALL with a *), match everything: left out.
  const routes = JSON.parse(fs.readFileSync(list, 'utf8'))
    .filter((r) => !(r.method === 'ALL' && r.path.includes('*')))
    .map((r) => ({ ...r, re: routeRe(r.path) }));

  await test('GET /api/app-support answers without a sign-in, with each app\'s minimum', async () => {
    const r = await fetch(`${s.BASE}/api/app-support`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.api, 1);
    assert.match(j.minApp.android, /^\d+\.\d+\.\d+$/);
    assert.match(j.minApp.windows, /^\d+\.\d+\.\d+$/);
    assert.equal(j.updateUrl.android, null);
  });

  await test('the server lists its routes', () => assert.ok(routes.length > 200, `only ${routes.length} routes`));

  // Every call in the contract (server/src/api-contract.ts) is a route: the apps build these addresses from it.
  const contract = fs.readFileSync(path.join(root, 'server/src/api-contract.ts'), 'utf8');
  const ops = [...contract.matchAll(/^\s+'(GET|POST|PUT|PATCH|DELETE) (\/api\/[^']+)':/gm)].map((m) => ({ method: m[1], path: m[2] }));
  await test('the contract names its calls', () => assert.ok(ops.length >= 10, `only ${ops.length}`));
  await test('every contract call has a server route', () => assert.deepEqual(ops.filter((o) => {
    const probe = o.path.replace(/\{\w+\}/g, 'x');
    return !routes.some((r) => (r.method === o.method || r.method === 'ALL') && r.re.test(probe));
  }).map((o) => `${o.method} ${o.path}`), []));

  for (const [file, prefix] of CLIENTS) {
    const found = calls(fs.readFileSync(path.join(root, file), 'utf8'), prefix);
    await test(`${file}: its calls were read`, () => assert.ok(found.length > (file.endsWith('api.ts') ? 150 : 3), `only ${found.length}`));
    // A `{}` that stands for several segments (`/files${path}`) is matched as one or more segments.
    const missing = found.filter((c) => {
      const probe = c.path.replace(/\{\}/g, 'x');
      const wide = c.path.replace(/\{\}/g, 'x/x');
      return !routes.some((r) => (r.method === c.method || r.method === 'ALL') && (r.re.test(probe) || r.re.test(wide)));
    });
    await test(`${file}: every call has a server route`, () => assert.deepEqual(missing.map((c) => `${c.method} ${c.path} (line ${c.line})`), []));
  }
} finally {
  await s.stop();
}
process.exit(failures ? 1 : 0);
