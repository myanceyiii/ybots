// Writes api/openapi.json from the contract (server/src/api-contract.ts): one OpenAPI 3.1 document with every
// call, its path parts, query, body and answer, and the live events (GET /api/events) as `x-events`.
//   node scripts/api/generate.mjs          write it
//   node scripts/api/generate.mjs --check  exit 1 when the committed file is not what the contract makes
// Uses ts-json-schema-generator (MIT) to turn the TypeScript types into JSON Schema.
import fs from 'node:fs';
import path from 'node:path';
import { createGenerator } from 'ts-json-schema-generator';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const OUT = path.join(root, 'api/openapi.json');

const schemaOf = (type) => createGenerator({
  path: path.join(root, 'server/src/api-contract.ts'),
  tsconfig: path.join(root, 'server/tsconfig.json'),
  type, expose: 'export', topRef: false, jsDoc: 'extended', skipTypeCheck: true, additionalProperties: true,
}).createSchema(type);

/** Moves the generator's #/definitions refs to OpenAPI's #/components/schemas. */
const refs = (v) => JSON.parse(JSON.stringify(v).replace(/#\/definitions\//g, '#/components/schemas/'));

export function build() {
  const ops = schemaOf('ApiOperations');
  const events = schemaOf('ApiEvent');
  const error = schemaOf('ApiError');
  const schemas = { ...(ops.definitions ?? {}), ...(events.definitions ?? {}), ApiError: { ...error, definitions: undefined } };
  delete schemas.ApiError.definitions; delete schemas.ApiError.$schema;
  const paths = {};
  for (const [key, op] of Object.entries(ops.properties).sort(([a], [b]) => a.localeCompare(b))) {
    const [method, p] = key.split(' ');
    const props = op.properties ?? {};
    const params = [...p.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const query = props.query;
    for (const [name, s] of Object.entries(query?.properties ?? {})) params.push({ name, in: 'query', required: (query.required ?? []).includes(name), schema: s });
    const o = {
      operationId: key,
      ...(op.description ? { description: op.description } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(props.body ? { requestBody: { required: true, content: { 'application/json': { schema: props.body } } } } : {}),
      responses: {
        200: { description: 'Done', content: { 'application/json': { schema: props.res } } },
        default: { description: 'Refused or failed', content: { 'application/json': { schema: { $ref: '#/definitions/ApiError' } } } },
      },
    };
    (paths[p] ??= {})[method.toLowerCase()] = o;
  }
  const eventSchema = { ...events }; delete eventSchema.definitions; delete eventSchema.$schema;
  return refs({
    openapi: '3.1.0',
    info: { title: 'YBots', version: '1', description: 'Generated from server/src/api-contract.ts by scripts/api/generate.mjs. Do not edit. Rules: docs/api-contract.md.' },
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    'x-events': { path: '/api/events', contentType: 'text/event-stream', schema: eventSchema },
    components: { schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))) },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = `${JSON.stringify(build(), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (now !== text) { console.error('api/openapi.json is not what server/src/api-contract.ts makes. Run: npm run api:generate'); process.exit(1); }
    console.log('api/openapi.json is current');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, text);
    console.log(`wrote api/openapi.json (${Object.keys(JSON.parse(text).paths).length} paths)`);
  }
}
