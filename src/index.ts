#!/usr/bin/env node
// mcp-weather entry point.
//   node build/index.js          stdio (local MCP clients)
//   node build/index.js --http   Streamable HTTP on PORT (default 3000), path /mcp, health /health
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, startHttpServer, SERVER_VERSION } from './server.js';

async function main() {
  if (process.argv.includes('--http') || process.env.MCP_TRANSPORT === 'http') {
    const port = parseInt(process.env.PORT ?? '3000', 10);
    const http = await startHttpServer(port, process.env.HOST ?? '0.0.0.0');
    console.error(`MCP Weather Server ${SERVER_VERSION} on http://${process.env.HOST ?? '0.0.0.0'}:${port}/mcp (stateless Streamable HTTP)`);
    const stop = () => http.close(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    return;
  }
  await createMcpServer().connect(new StdioServerTransport());
  console.error(`MCP Weather Server ${SERVER_VERSION} running on stdio`);
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
