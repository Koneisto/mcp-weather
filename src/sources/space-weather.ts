import { safeError } from '../utils/errors.js';
import { cache } from '../cache.js';
import { getJson } from '../utils/http.js';

/**
 * Space weather for aurora forecasts: FMI R-index (auroral activity measured by Finnish magnetometers, every 5 min,
 * CC BY 4.0) and NOAA SWPC planetary Kp (observed and 3-day forecast, US public domain).
 */
export const SPACE_ATTRIBUTION = 'Finnish Meteorological Institute R-index (CC BY 4.0); NOAA SWPC Kp (public domain)';

export interface RStation { code: string; name: string; lat: number; lon: number; time: string; r: number; lower: number; higher: number; text: string }
export interface KpSlot { time: string; kp: number; kind: 'observed' | 'estimated' | 'predicted' }

let lastCallTime: string | undefined, lastCallOk: boolean | undefined, lastError: string | undefined;
export function getSpaceWeatherStatus() {
  return { name: 'Space weather (FMI R-index, NOAA Kp)', configured: true, available: true, lastCallTime, lastCallOk, lastError };
}
const track = async <T>(p: Promise<T>): Promise<T> => {
  try { const v = await p; lastCallTime = new Date().toISOString(); lastCallOk = true; return v; }
  catch (err) { lastCallTime = new Date().toISOString(); lastCallOk = false; lastError = safeError(err); throw err; }
};

type RRaw = { data?: Record<string, Record<string, string | number>> };
export function parseRIndex(d: RRaw): RStation[] {
  return Object.entries(d.data ?? {}).map(([code, s]) => ({
    code, name: String(s['Station'] ?? code), lat: Number(s['Geographic latitude']), lon: Number(s['Geographic longitude']),
    time: String(s['Time'] ?? ''), r: Number(s['R-index']), lower: Number(s['Limit value lower']), higher: Number(s['Limit value higher']),
    text: String(s['Probability of auroras'] ?? ''),
  })).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.r));
}

/** FMI R-index stations (Finland). The file says max-age 1 day but updates every 5 minutes: cached 5 min here. */
export async function fetchRIndex(): Promise<RStation[]> {
  return track(cache.getOrFetch('space:rindex', async () => parseRIndex(await getJson<RRaw>('https://space.fmi.fi/MIRACLE/RWC/data/r_index_latest_en.json', 'FMI R-index')), 5 * 60000));
}

type KpRaw = Array<{ time_tag: string; kp: number; observed: string }>;
export function parseKp(d: KpRaw): KpSlot[] {
  return (Array.isArray(d) ? d : []).filter((x) => typeof x.kp === 'number')
    .map((x) => ({ time: x.time_tag.endsWith('Z') ? x.time_tag : x.time_tag + 'Z', kp: x.kp, kind: (['observed', 'estimated', 'predicted'].includes(x.observed) ? x.observed : 'predicted') as KpSlot['kind'] }));
}

/** NOAA planetary Kp in 3-hour slots: observed, estimated (current) and predicted for about 3 days. */
export async function fetchKp(): Promise<KpSlot[]> {
  return track(cache.getOrFetch('space:kp', async () => parseKp(await getJson<KpRaw>('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json', 'NOAA SWPC')), 15 * 60000));
}

/**
 * Kp needed for auroras to be visible (low in the north or higher) at a geographic latitude in the Nordic sector,
 * a common rule of thumb for Fennoscandia: Kp 1 in northern Lapland, Kp 3 around Oulu, Kp 5 in southern Finland and
 * Stockholm, Kp 6 in Denmark and Lithuania.
 */
export function kpNeeded(lat: number): number {
  const T: Array<[number, number]> = [[69, 1], [67, 2], [64.5, 3], [62, 4], [60, 5], [57, 6], [55, 7], [52, 8]];
  if (lat >= T[0][0]) return 1;
  for (let i = 1; i < T.length; i++) {
    const [la, k] = T[i], [lb, kb] = T[i - 1];
    if (lat >= la) return Math.round((k + (kb - k) * (lat - la) / (lb - la)) * 10) / 10;
  }
  return 9;
}
