import type { AirQualityData, SourceResult } from '../types.js';
import { config } from '../config.js';
import { cache } from '../cache.js';
import { errorText } from '../utils/units.js';
import { parseFmiTimeValuePair, distanceKm, isInFinland, type FmiStation } from './fmi.js';

/**
 * Measured air quality from Finnish air quality stations (FMI open data: municipal networks such as HSY via
 * `urban::`, FMI's own background stations via `fmi::`). Hourly averages, CC BY 4.0.
 * Measured values differ clearly from the model: Helsinki Kallio 14 Oct 2026 21:00 measured PM2.5 2,7 / NO2 11,1,
 * Open-Meteo model 4,9 / 5,2 µg/m³. Air quality changes block by block, so only a station within 10 km is used.
 */

const SOURCE = 'FMI';
const WFS = 'https://opendata.fmi.fi/wfs';
const QUERIES = ['urban::observations::airquality::hourly::timevaluepair', 'fmi::observations::airquality::hourly::timevaluepair'];
const PARAMS: Record<string, keyof AirQualityData> = {
  PM25_PT1H_avg: 'pm25', PM10_PT1H_avg: 'pm10', NO2_PT1H_avg: 'no2', O3_PT1H_avg: 'o3', SO2_PT1H_avg: 'so2', CO_PT1H_avg: 'co',
};
const CACHE_TTL_MS = 20 * 60 * 1000;        // hourly averages
const MAX_AGE_MS = 3 * 3600 * 1000;         // hourly values arrive with a delay
export const AIR_QUALITY_RADIUS_KM = 10;

let lastCallTime: string | undefined;
let lastCallOk: boolean | undefined;
let lastError: string | undefined;

export function getFmiAirQualityStatus() {
  return { name: 'FMI air quality', configured: true, available: true, lastCallTime, lastCallOk, lastError };
}

export interface FmiAirQualityObservation {
  station: string;
  distanceKm: number;
  /** latest hour of the values used (end of the averaging hour) */
  observationTime: string;
  data: AirQualityData;
}

/** Fresh measured values of a station mapped to AirQualityData; undefined if it has no PM or NO2 value. */
export function stationToAirQuality(st: FmiStation, now: number): { data: AirQualityData; time: string } | undefined {
  const data: AirQualityData = {};
  let time = '';
  for (const [param, key] of Object.entries(PARAMS)) {
    const v = st.values[param];
    if (!v || now - Date.parse(v.time) > MAX_AGE_MS || v.value < 0) continue;
    (data as Record<string, number>)[key] = v.value;
    if (v.time > time) time = v.time;
  }
  if (data.pm25 === undefined && data.pm10 === undefined && data.no2 === undefined) return undefined;
  return { data, time };
}

export async function fetchFmiAirQuality(lat: number, lon: number, radiusKm = AIR_QUALITY_RADIUS_KM): Promise<SourceResult<FmiAirQualityObservation>> {
  if (!isInFinland(lat, lon)) return { ok: false, error: 'Location is outside Finland', source: SOURCE };
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((x) => x.toFixed(3)).join(',');

  try {
    const stations = await cache.getOrFetch<FmiStation[]>(`fmi-aq:${bbox}`, async () => {
      const start = new Date(Date.now() - MAX_AGE_MS).toISOString().replace(/\.\d+Z$/, 'Z');
      const lists = await Promise.all(QUERIES.map(async (q) => {
        const url = `${WFS}?service=WFS&version=2.0.0&request=getFeature&storedquery_id=${q}&bbox=${bbox}` +
          `&starttime=${start}&parameters=${Object.keys(PARAMS).join(',')}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
        try {
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) throw new Error(`FMI air quality returned ${res.status}`);
          const xml = await res.text();
          if (xml.includes('<ExceptionReport')) throw new Error(`FMI: ${/<ExceptionText>([^<]*)/.exec(xml)?.[1] ?? 'query failed'}`);
          return parseFmiTimeValuePair(xml);
        } finally {
          clearTimeout(timeout);
        }
      }));
      return lists.flat();
    }, CACHE_TTL_MS);

    lastCallTime = new Date().toISOString();
    lastCallOk = true;

    const now = Date.now();
    const best = stations
      .map((s) => ({ s, d: distanceKm(lat, lon, s.lat, s.lon), aq: stationToAirQuality(s, now) }))
      .filter((x) => x.aq && x.d <= radiusKm)
      .sort((a, b) => a.d - b.d)[0];
    if (!best || !best.aq) return { ok: false, error: `No air quality station with fresh data within ${radiusKm} km`, source: SOURCE };
    return {
      ok: true,
      source: SOURCE,
      data: { station: best.s.name, distanceKm: Math.round(best.d * 10) / 10, observationTime: best.aq.time, data: best.aq.data },
    };
  } catch (err) {
    lastCallTime = new Date().toISOString();
    lastCallOk = false;
    lastError = errorText(err, config.httpTimeoutMs);
    return { ok: false, error: lastError, source: SOURCE };
  }
}
