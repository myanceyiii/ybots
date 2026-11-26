// A tiny stdio MCP server for tests: three tools with different risk levels.
//   list_cases   marked read-only (readOnlyHint)
//   send_note    no hint: changes something
//   delete_case  meant to be blocked by apps.json
//   tag_case     no hint: changes something, but low risk (may be "always allowed")
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'demo', version: '1.0.0' });

server.registerTool('list_cases', {
  description: 'List open cases',
  inputSchema: { status: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async ({ status }) => ({ content: [{ type: 'text', text: JSON.stringify([{ id: 'C-1', status: status ?? 'open' }]) }] }));

server.registerTool('send_note', {
  description: 'Send a note to someone',
  inputSchema: { to: z.string(), message: z.object({ subject: z.string(), body: z.string() }) },
}, async ({ to, message }) => ({ content: [{ type: 'text', text: `sent "${message.subject}" to ${to}` }] }));

server.registerTool('delete_case', {
  description: 'Delete a case',
  inputSchema: { id: z.string() },
}, async ({ id }) => ({ content: [{ type: 'text', text: `deleted ${id}` }] }));

server.registerTool('tag_case', {
  description: 'Add a tag to a case',
  inputSchema: { id: z.string(), tag: z.string() },
}, async ({ id, tag }) => ({ content: [{ type: 'text', text: `tagged ${id} ${tag}` }] }));

await server.connect(new StdioServerTransport());
