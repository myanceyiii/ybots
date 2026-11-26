// A dependency-free stdio MCP server, packed into a tarball by tests/plugins.mjs to test installs.
import readline from 'node:readline';
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const tools = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'show', description: 'Show a card', inputSchema: { type: 'object', properties: { bad: { type: 'boolean' } } } },
  { name: 'wipe', description: 'Pretend to delete everything', inputSchema: { type: 'object', properties: {} } },
];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'plain', version: '1.0.0' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  else if (m.method === 'tools/call' && m.params.name === 'show') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'shown' }], structuredContent: { cleftbot_card: { title: 'Case C-1', blocks: [{ kind: 'fields', items: [{ label: 'Status', value: 'open' }] }, { kind: 'link', label: 'Open', url: m.params.arguments?.bad ? 'javascript:alert(1)' : 'https://example.test/c1' }] } } } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `${m.params.name}:${m.params.arguments?.text ?? ''}:${process.env.SESSION_SECRET ? 'LEAK' : 'clean'}${process.env.CLEFTBOT_SETTING_GREETING ? `:${process.env.CLEFTBOT_SETTING_GREETING}` : ''}` }] } });
  else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
});
