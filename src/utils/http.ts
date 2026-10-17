import { config } from '../config.js';
import { VERSION } from '../version.js';
import { Limiter } from './limit.js';

/** Identifying User-Agent for every provider (MET Norway rejects requests without one; others ask for it). */
export const USER_AGENT = `mcp-weather/${VERSION} (+https://github.com/Koneisto/mcp-weather)`;
const requests = new Limiter(config.httpMaxConcurrent, config.httpMaxQueued);

/** GET bounded through the decoded response body, including time spent waiting for an upstream slot.
 * Callers only consume JSON/text; buffering once here gives every provider the same byte limit and deadline.
 * Redirects are rejected: provider URLs are explicit and must not lead to a different/internal origin.
 */
export async function httpGet(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Upstream URL must use HTTPS without credentials');
  const signal = AbortSignal.timeout(config.httpTimeoutMs);
  return requests.run(async () => {
    const res = await fetch(url, { signal, redirect: 'error', headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip', ...headers } });
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      if (reader) while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > config.httpMaxResponseBytes) throw new Error('Upstream response exceeds byte limit');
        chunks.push(value);
      }
      signal.throwIfAborted();
    } catch (err) {
      await reader?.cancel().catch(() => {});
      throw err;
    } finally { reader?.releaseLock(); }
    const responseHeaders = new Headers(res.headers);
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    const body = [204, 205, 304].includes(res.status) ? null : Buffer.concat(chunks, bytes);
    return new Response(body, { status: res.status, statusText: res.statusText, headers: responseHeaders });
  }, signal);
}

/** GET JSON; non-2xx is an error with the provider name and status. */
export async function getJson<T>(url: string, provider: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await httpGet(url, { Accept: 'application/json', ...headers });
  if (!res.ok) throw new Error(`${provider} returned ${res.status}`);
  return await res.json() as T;
}

/** GET text (XML feeds). */
export async function getText(url: string, provider: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await httpGet(url, headers);
  if (!res.ok) throw new Error(`${provider} returned ${res.status}`);
  return await res.text();
}
