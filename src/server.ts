#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { program } from 'commander';
import { resolveApiKey } from './auth.js';
import { PennylaneClient } from './client.js';
import { registerAllTools } from './generated/tools.js';

const SERVER_NAME = 'pennylane';
const SERVER_VERSION = '0.3.0';

async function main(): Promise<void> {
  program
    .name('pennylane-mcp')
    .description('MCP server for the Pennylane v2 API')
    .option('--apiKey <key>', 'Pennylane API key (overrides PENNYLANE_API_KEY env var)')
    .allowExcessArguments(false)
    .parse(process.argv);

  const opts = program.opts<{ apiKey?: string }>();
  const apiKey = resolveApiKey(opts.apiKey);
  const client = new PennylaneClient(apiKey);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  const count = registerAllTools(server, client);
  process.stderr.write(`pennylane-mcp: registered ${count} tools\n`);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`pennylane-mcp: received ${signal}, shutting down...\n`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pennylane-mcp: fatal: ${msg}\n`);
  process.exit(1);
});
