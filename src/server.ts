import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { currentWeatherTool } from './tools/current-weather.js';
import { forecastTool } from './tools/forecast.js';
import { metarTool } from './tools/metar.js';
import { astronomyTool } from './tools/astronomy.js';
import { airQualityTool } from './tools/air-quality.js';
import { sourceStatusTool } from './tools/source-status.js';

export const SERVER_VERSION = '1.0.1';

const tools = [currentWeatherTool, forecastTool, metarTool, astronomyTool, airQualityTool, sourceStatusTool];

/**
 * A new MCP server instance with all tools. Cheap to create: the data cache and source state are module-level,
 * so every instance (one per HTTP request in stateless mode) shares them.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'weather', version: SERVER_VERSION });
  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.schema, outputSchema: t.outputSchema, annotations: t.annotations },
      // the SDK validates structuredContent against outputSchema
      t.handler as never,
    );
  }
  return server;
}

const MAX_BODY_BYTES = 1 << 20;

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

const jsonRpcError = (code: number, message: string) => JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * Streamable HTTP, stateless with JSON responses: POST /mcp, one process for all clients (shared cache),
 * GET /health → "ok". GET/DELETE /mcp → 405: no server-initiated stream and no sessions to end.
 * Replaces the supergateway wrapper, which started a separate process for every client session.
 */
export function startHttpServer(port: number, host = '0.0.0.0'): Promise<Server> {
  const http = createHttpServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/health' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); return; }
    if (path !== '/mcp') { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }).end(jsonRpcError(-32000, 'Method not allowed: stateless server, use POST'));
      return;
    }
    let body: unknown;
    try { body = await readJson(req); } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(jsonRpcError(-32700, `Parse error: ${(err as Error).message}`));
      return;
    }
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error('MCP request failed:', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(jsonRpcError(-32603, 'Internal error'));
    }
  });
  return new Promise((resolve) => http.listen(port, host, () => resolve(http)));
}
