import type { MetarData, SourceResult } from '../types.js';
import { config } from '../config.js';
import { cache } from '../cache.js';
import { knotsToMs } from '../utils/units.js';

interface MetarApiResponse {
  rawOb: string;
  name: string;
  obsTime: string;
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

export function getMetarStatus() {
  return { name: SOURCE, configured: true, available: true, lastCallTime, lastCallOk, lastError };
}

export async function fetchMetar(icao: string): Promise<SourceResult<MetarData>> {
  const station = icao.toUpperCase();
  try {
    const data = await cache.getOrFetch<MetarApiResponse[]>(
      `metar:${station}`,
      async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
        try {
          const res = await fetch(
            `https://aviationweather.gov/api/data/metar?ids=${station}&format=json`,
            { signal: controller.signal },
          );
          if (!res.ok) throw new Error(`Aviation Weather API returned ${res.status}`);
          return await res.json() as MetarApiResponse[];
        } finally {
          clearTimeout(timeout);
        }
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
        observationTime: m.obsTime,
        temperature: m.temp,
        dewPoint: m.dewp,
        windSpeed: knotsToMs(m.wspd),
        windDirection: m.wdir,
        windGusts: m.wgst ? knotsToMs(m.wgst) : undefined,
        visibility: parseFloat(m.visib) * 1609.34, // statute miles to meters
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
    lastError = String(err);
    return { ok: false, error: String(err), source: SOURCE };
  }
}
