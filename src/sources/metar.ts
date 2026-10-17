import { httpGet } from '../utils/http.js';
import type { MetarData, SourceResult } from '../types.js';
import { config } from '../config.js';
import { cache } from '../cache.js';
import { knotsToMs, errorText } from '../utils/units.js';

interface MetarApiResponse {
  rawOb: string;
  name: string;
  obsTime: number | string;   // the API returns Unix seconds
  temp: number;
  dewp: number;
  wdir: number;
  wspd: number;
  wgst: number | null;
  visib: string;
  altim: number;
  slp: number | null;
  fltCat: string;
  clouds: Array<{ cover: string; base: number | null }>;
  wxString: string | null;
}

const SOURCE = 'METAR';
const METAR_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
let lastCallTime: string | undefined;
let lastCallOk: boolean | undefined;
let lastError: string | undefined;

/**
 * Visibility in metres. The API gives statute miles ("6+", "10+", "1/2"), but outside the US the METAR reports metres:
 * "9999" and CAVOK mean 10 km or more (before 10/2026 they were shown as 9,7 km = 6 statute miles).
 */
export function metarVisibility(raw: string, visib: string | number): { visibility?: number; visibilityOrMore?: boolean } {
  const body = ` ${raw.split(' RMK')[0]} `;
  if (/ CAVOK /.test(body)) return { visibility: 10000, visibilityOrMore: true };
  const metres = / (\d{4})(?:NDV)? /.exec(body);
  if (metres) {
    const v = parseInt(metres[1], 10);
    return v === 9999 ? { visibility: 10000, visibilityOrMore: true } : { visibility: v };
  }
  const s = String(visib).trim();
  const plus = s.endsWith('+');
  const num = s.replace('+', '');
  const frac = /^(?:(\d+)\s+)?(\d+)\/(\d+)$/.exec(num);
  const miles = frac ? (frac[1] ? parseInt(frac[1], 10) : 0) + parseInt(frac[2], 10) / parseInt(frac[3], 10) : parseFloat(num);
  if (!Number.isFinite(miles)) return {};
  const visibility = Math.round(miles * 1609.34);
  return plus ? { visibility, visibilityOrMore: true } : { visibility };
}

export function getMetarStatus() {
  return { name: SOURCE, configured: true, available: true, lastCallTime, lastCallOk, lastError };
}

export async function fetchMetar(icao: string): Promise<SourceResult<MetarData>> {
  const station = icao.toUpperCase();
  try {
    const data = await cache.getOrFetch<MetarApiResponse[]>(
      `metar:${station}`,
      async () => {
        const res = await httpGet(
          `https://aviationweather.gov/api/data/metar?ids=${station}&format=json`,
        );
        if (!res.ok) throw new Error(`Aviation Weather API returned ${res.status}`);
        // No METAR for the station: HTTP 204 with an empty body (not an error)
        const body = await res.text();
        return body.trim() ? JSON.parse(body) as MetarApiResponse[] : [];
      },
      METAR_CACHE_TTL_MS,
    );

    lastCallTime = new Date().toISOString();
    lastCallOk = true;

    if (!data || data.length === 0) {
      return { ok: false, error: `No METAR data for ${station}`, source: SOURCE };
    }

    const m = data[0];
    const cloudStr = m.clouds
      .map((c) => c.base !== null ? `${c.cover} at ${c.base} ft` : c.cover)
      .join(', ');

    return {
      ok: true,
      source: SOURCE,
      data: {
        raw: m.rawOb,
        station: station,
        observationTime: typeof m.obsTime === 'number' ? new Date(m.obsTime * 1000).toISOString().replace('.000Z', 'Z') : m.obsTime,
        temperature: m.temp,
        dewPoint: m.dewp,
        windSpeed: knotsToMs(m.wspd),
        windDirection: m.wdir,
        windGusts: m.wgst ? knotsToMs(m.wgst) : undefined,
        ...metarVisibility(m.rawOb, m.visib),
        altimeter: m.altim,
        pressure: m.slp ?? m.altim,
        flightCategory: m.fltCat,
        clouds: cloudStr || undefined,
        weather: m.wxString || undefined,
      },
    };
  } catch (err) {
    lastCallTime = new Date().toISOString();
    lastCallOk = false;
    lastError = errorText(err, config.httpTimeoutMs);
    return { ok: false, error: lastError, source: SOURCE };
  }
}
