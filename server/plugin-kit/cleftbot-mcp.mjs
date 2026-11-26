// YBots plugin kit: a dependency-free MCP server over stdio (newline-delimited JSON-RPC).
// The server copies this file into every plugin the AI builder makes, so plugins need no npm packages.
//
//   import { serve } from './cleftbot-mcp.mjs';
//   serve({
//     name: 'my-plugin', version: '1.0.0',
//     tools: [{
//       name: 'lookup', description: 'Look something up',
//       inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
//       readOnly: true,
//       run: async ({ q }) => `result for ${q}`,                  // a string, or
//       // run: async () => ({ text: '...', card: { title, blocks } })  // text plus a card (docs/plugins.md)
//     }],
//   });
//
// Settings the owner entered arrive as process.env.CLEFTBOT_SETTING_<KEY>.
import readline from 'node:readline';

export function serve({ name, version = '1.0.0', tools }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const list = tools.map((t) => ({
    name: t.name,
    description: t.description ?? t.name,
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    ...(t.readOnly ? { annotations: { readOnlyHint: true } } : {}),
  }));
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || m.id === undefined || m.id === null) return;
    const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
    const error = (code, message) => send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    switch (m.method) {
      case 'initialize':
        return reply({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version } });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: list });
      case 'tools/call': {
        const t = byName.get(m.params?.name);
        if (!t) return error(-32602, `No tool ${m.params?.name}`);
        try {
          const out = await t.run(m.params?.arguments ?? {});
          if (out && typeof out === 'object') {
            return reply({ content: [{ type: 'text', text: String(out.text ?? '') }], ...(out.card ? { structuredContent: { cleftbot_card: out.card } } : {}) });
          }
          return reply({ content: [{ type: 'text', text: String(out ?? '') }] });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: `Error: ${e?.message ?? e}` }], isError: true });
        }
      }
      default:
        return error(-32601, `Method not found: ${m.method}`);
    }
  });
}
