import { httpGet } from '../utils/http.js';

/**
 * MET Norway (api.met.no) client following the terms of service: identifying User-Agent, coordinates truncated to
 * 4 decimals, no new request before the Expires time, and If-Modified-Since with the stored Last-Modified (304 reuses
 * the stored body). Licence CC BY 4.0, credit "MET Norway".
 */
export const MET_ATTRIBUTION = 'MET Norway (api.met.no), CC BY 4.0';

interface Stored { body: unknown; expires: number; lastModified?: string }
const store = new Map<string, Stored>();
const MAX_STORED = 300;
let lastCallTime: string | undefined, lastCallOk: boolean | undefined, lastError: string | undefined;

export function getMetNorwayStatus() {
  return { name: 'MET Norway', configured: true, available: true, lastCallTime, lastCallOk, lastError };
}

export const met4 = (x: number) => Math.trunc(x * 10000) / 10000;

/** Tests only. */
export function clearMetStore(): void {
  store.clear();
}

export async function metGet<T>(product: string, lat: number, lon: number, extra: Record<string, string> = {}): Promise<T> {
  const params = new URLSearchParams({ lat: String(met4(lat)), lon: String(met4(lon)), ...extra });
  const url = `https://api.met.no/weatherapi/${product}?${params}`;
  const now = Date.now(), hit = store.get(url);
  if (hit && hit.expires > now) return hit.body as T;
  try {
    const res = await httpGet(url, { Accept: 'application/json', ...(hit?.lastModified ? { 'If-Modified-Since': hit.lastModified } : {}) });
    const expires = Date.parse(res.headers.get('expires') ?? '') || now + 5 * 60000;
    lastCallTime = new Date().toISOString();
    if (res.status === 304 && hit) {
      hit.expires = expires; lastCallOk = true;
      return hit.body as T;
    }
    if (!res.ok) throw new Error(`MET Norway ${product} returned ${res.status}`);
    if (res.status === 203) console.error(`MET Norway: ${product} is deprecated (HTTP 203)`);
    const body = await res.json();
    store.set(url, { body, expires, lastModified: res.headers.get('last-modified') ?? undefined });
    while (store.size > MAX_STORED) store.delete(store.keys().next().value as string);
    lastCallOk = true;
    return body as T;
  } catch (err) {
    lastCallTime = new Date().toISOString(); lastCallOk = false; lastError = String(err);
    throw err;
  }
}
