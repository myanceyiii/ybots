// A stand-in for the Hermes MCP sidecar (hermes-mcp): a few of its tool names, none marked read-only,
// exactly like the real server. Each tool just echoes its name.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'hermes-gpt', version: '1.0.0' });
for (const name of ['hermes_plan_list', 'hermes_mission_list', 'hermes_read_file', 'hermes_mission_create',
  'hermes_owner_run_command', 'hermes_gateway_restart', 'hermes_brand_new_tool']) {
  server.registerTool(name, { description: name, inputSchema: { path: z.string().optional(), limit: z.number().optional() } },
    async () => ({ content: [{ type: 'text', text: name }] }));
}
await server.connect(new StdioServerTransport());
