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
import { marineTool } from './tools/marine.js';
import { roadWeatherTool } from './tools/road-weather.js';
import { lakeTool } from './tools/lake.js';
import { keyNote, serverInstructions } from './keys.js';

import { VERSION } from './version.js';
import { config } from './config.js';

export const SERVER_VERSION = VERSION;

const tools = [currentWeatherTool, forecastTool, nowcastTool, warningsTool, marineTool, lakeTool, roadWeatherTool, airQualityTool, auroraTool, metarTool, astronomyTool, sourceStatusTool];

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

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (err?: Error, value?: unknown) => {
      clearTimeout(timer);
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('error', error);
      req.removeListener('aborted', aborted);
      if (err) { req.pause(); reject(err); } else resolve(value);
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) finish(new RequestError(413, 'request body too large'));
      else chunks.push(chunk);
    };
    const end = () => {
      try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new RequestError(400, 'invalid JSON')); }
    };
    const error = () => finish(new RequestError(400, 'request interrupted'));
    const aborted = () => finish(new RequestError(400, 'request interrupted'));
    const timer = setTimeout(() => finish(new RequestError(408, 'request body timed out')), config.httpTimeoutMs);
    timer.unref();
    req.on('data', data);
    req.on('end', end);
    req.on('error', error);
    req.on('aborted', aborted);
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
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return false;
    return allowed.includes(origin) || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
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
export function startHttpServer(port: number, host = '127.0.0.1'): Promise<Server> {
  let active = 0;
  const http = createHttpServer((req, res) => {
    req.on('error', () => {});   // a disconnected/aborted body can emit error after its reader has settled
    const respond = (status: number, message: string) => {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
          .end(jsonRpcError(status === 400 ? -32700 : -32000, message));
      }
    };
    const handle = async () => {
      let path: string;
      try {
        if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Error('invalid target');
        path = new URL(req.url, 'http://localhost').pathname;
      } catch { respond(400, 'Invalid request target'); return; }
      if (path === '/health' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); return; }
      if (path !== '/mcp') { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
      if (!originAllowed(req.headers.origin)) { respond(403, 'Forbidden: origin not allowed'); return; }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }).end(jsonRpcError(-32000, 'Method not allowed: stateless server, use POST'));
        return;
      }
      if (active >= config.maxHttpRequests) { res.setHeader('retry-after', '1'); respond(503, 'Server busy; retry later'); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { respond(415, 'Content-Type must be application/json'); return; }
      if (Number(req.headers['content-length']) > MAX_BODY_BYTES) { respond(413, 'request body too large'); return; }
      active++;
      try {
        const body = await readJson(req);
        const accept = req.headers.accept ?? '';
        if (!accept.includes('text/event-stream') && (!accept || accept.includes('application/json') || accept.includes('*/*'))) {
          req.headers.accept = 'application/json, text/event-stream';
        }
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => { void transport.close().catch(() => {}); void server.close().catch(() => {}); });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
        } finally { await transport.close(); await server.close(); }
      } finally { active--; }
    };
    void handle().catch((err: unknown) => {
      if (err instanceof RequestError) respond(err.status, err.message);
      else { console.error('MCP request failed'); respond(500, 'Internal error'); }
    });
  });
  http.requestTimeout = config.httpTimeoutMs;
  http.headersTimeout = Math.min(config.httpTimeoutMs, 10000);
  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => { http.removeListener('error', reject); resolve(http); });
  });
}
