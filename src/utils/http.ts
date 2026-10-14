import { config } from '../config.js';
import { VERSION } from '../version.js';

/** Identifying User-Agent for every provider (MET Norway rejects requests without one; others ask for it). */
export const USER_AGENT = `mcp-weather/${VERSION} (+https://github.com/Koneisto/mcp-weather)`;

/** GET with timeout, identifying User-Agent and gzip. Throws on network errors; the caller checks res.status. */
export async function httpGet(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip', ...headers } });
  } finally {
    clearTimeout(timeout);
  }
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
