import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { currentWeatherTool } from './tools/current-weather.js';
import { forecastTool } from './tools/forecast.js';
import { metarTool } from './tools/metar.js';
import { astronomyTool } from './tools/astronomy.js';
import { airQualityTool } from './tools/air-quality.js';
import { sourceStatusTool } from './tools/source-status.js';
import { warningsTool } from './tools/warnings.js';
import { nowcastTool } from './tools/nowcast.js';
import { auroraTool } from './tools/aurora.js';
import { keyNote, serverInstructions } from './keys.js';

import { VERSION } from './version.js';

export const SERVER_VERSION = VERSION;

const tools = [currentWeatherTool, forecastTool, nowcastTool, warningsTool, airQualityTool, auroraTool, metarTool, astronomyTool, sourceStatusTool];

/**
 * A new MCP server instance with all tools. Cheap to create: the data cache and source state are module-level,
 * so every instance (one per HTTP request in stateless mode) shares them.
 */
let keyNoteShown = false;   // once per process: the first successful answer tells about missing optional API keys

/** Tests only: show the one-time key note again. */
export function resetKeyNote(): void {
  keyNoteShown = false;
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'weather', version: SERVER_VERSION }, { instructions: serverInstructions() });
  for (const t of tools) {
    const handler = async (args: never, extra: never) => {
      const result = await (t.handler as (a: never, e: never) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>)(args, extra);
      if (!keyNoteShown && !result.isError && t.name !== 'get_weather_source_status') {
        keyNoteShown = true;
        const note = keyNote();
        if (note) result.content.push({ type: 'text', text: note });   // text only: structuredContent stays as the schema says
      }
      return result;
    };
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.schema, outputSchema: t.outputSchema, annotations: t.annotations },
      // the SDK validates structuredContent against outputSchema
      handler as never,
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
 * Origin check against DNS rebinding (MCP spec: servers MUST validate Origin on Streamable HTTP). Requests without an
 * Origin header come from non-browser clients and are allowed; browser origins only from localhost or ALLOWED_ORIGINS
 * (comma-separated, e.g. https://inspector.example.com).
 */
export function originAllowed(origin: string | undefined, allowed: string[] = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)): boolean {
  if (!origin) return true;
  if (allowed.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Streamable HTTP, stateless with JSON responses: POST /mcp, one process for all clients (shared cache),
 * GET /health → "ok". GET/DELETE /mcp → 405: no server-initiated stream and no sessions to end.
 * The server never sends Server-Sent Events, so clients that accept only application/json are served too
 * (the SDK otherwise answers 406 unless the client also lists text/event-stream).
 */
export function startHttpServer(port: number, host = '0.0.0.0'): Promise<Server> {
  const http = createHttpServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/health' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); return; }
    if (path !== '/mcp') { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    if (!originAllowed(req.headers.origin)) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(jsonRpcError(-32000, 'Forbidden: origin not allowed'));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }).end(jsonRpcError(-32000, 'Method not allowed: stateless server, use POST'));
      return;
    }
    let body: unknown;
    try { body = await readJson(req); } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(jsonRpcError(-32700, `Parse error: ${(err as Error).message}`));
      return;
    }
    const accept = req.headers.accept ?? '';
    if (!accept.includes('text/event-stream') && (!accept || accept.includes('application/json') || accept.includes('*/*'))) {
      req.headers.accept = 'application/json, text/event-stream';   // JSON-only client: responses are JSON anyway (enableJsonResponse)
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
