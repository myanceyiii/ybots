// A connected app over streamable HTTP that forgets our session (as actual-mcp does when it restarts)
// is reconnected and the call is sent once more (server/src/local-apps.ts sessionLost).
// Needs a built server: `npm run build -w server`, then `node tests/app-session-retry.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

let sessions = new Map();
let calls = 0;
function newServer() {
  const s = new McpServer({ name: 'forgetful', version: '1.0.0' });
  s.registerTool('ping', { description: 'ping', inputSchema: { n: z.number() }, annotations: { readOnlyHint: true } }, async ({ n }) => { calls++; return { content: [{ type: 'text', text: `pong ${n}` }] }; });
  return s;
}
const httpServer = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const json = body ? JSON.parse(body) : undefined;
  const sid = req.headers['mcp-session-id'];
  if (sid && sessions.has(sid)) return sessions.get(sid).handleRequest(req, res, json);
  if (sid) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: json?.id ?? null, error: { code: -32001, message: 'Session not found. Please re-initialize by calling initialize without mcp-session-id header.' } }));
  }
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => sessions.set(id, t) });
  await newServer().connect(t);
  return t.handleRequest(req, res, json);
});
await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${httpServer.address().port}/mcp`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-session-'));
const cfg = path.join(dir, 'apps.json');
fs.writeFileSync(cfg, JSON.stringify({ apps: [{ id: 'forget', name: 'Forgetful', url }] }));
process.env.APPS_CONFIG = cfg;
const apps = await import('../server/dist/local-apps.js');

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.stack}`); } };

await test('a first call works', async () => {
  await apps.listAppTools();
  const r = await apps.callAppTool(apps.findAppTool('forget__ping'), { n: 1 });
  assert.equal(r.output, 'pong 1');
});

await test('after the server forgets the session, the call reconnects and goes through once', async () => {
  sessions = new Map();
  const before = calls;
  const r = await apps.callAppTool(apps.findAppTool('forget__ping'), { n: 2 });
  assert.equal(r.isError, false);
  assert.equal(r.output, 'pong 2');
  assert.equal(calls - before, 1);
});

await test('sessionLost spots the error and nothing else', () => {
  assert.equal(apps.sessionLost(new Error('Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"Session not found. Please re-initialize by calling initialize without mcp-session-id header."}}')), true);
  assert.equal(apps.sessionLost(new Error('Invalid arguments for tool ping')), false);
  assert.equal(apps.sessionLost(new Error('Request timed out')), false);
});

await apps.stopApps();
httpServer.closeAllConnections?.();
httpServer.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
