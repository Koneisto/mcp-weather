import { cache } from '../cache.js';
import { getText } from '../utils/http.js';
import type { DailyForecast } from '../types.js';

/**
 * FMI's meteorologist-edited forecast for Finland ("edited Scandinavia point forecast"): the forecast FMI publishes on
 * ilmatieteenlaitos.fi, hourly for about 9 days. No key, CC BY 4.0. Fetched as multipointcoverage, the compact format
 * (about 6 kB gzipped for 9 days against over 500 kB as time-value pairs).
 * Daily values are aggregated in local time; a day counts only when it has at least 18 forecast hours, so a partial
 * first or last day stays with the model, whose daily values cover the whole day.
 */
export const FMI_FORECAST_ATTRIBUTION = 'Finnish Meteorological Institute, meteorologist-edited forecast (CC BY 4.0)';
const PARAMS = ['Temperature', 'Precipitation1h', 'PoP', 'WindSpeedMS', 'WindDirection', 'WeatherSymbol3'];
const TTL = 30 * 60000, MIN_HOURS = 18;

export interface FmiHour { time: string; values: Record<string, number> }

/** multipointcoverage: positions "lat lon epoch" and one tuple of values per position, in the order of swe:field. */
export function parseFmiMultipoint(xml: string): FmiHour[] {
  const fields = [...xml.matchAll(/<swe:field name="([^"]+)"/g)].map((m) => m[1]);
  const pos = (/<gmlcov:positions>([\s\S]*?)<\/gmlcov:positions>/.exec(xml)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
  const vals = (/<gml:doubleOrNilReasonTupleList>([\s\S]*?)<\/gml:doubleOrNilReasonTupleList>/.exec(xml)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
  const out: FmiHour[] = [];
  for (let i = 0; i * 3 + 2 < pos.length; i++) {
    const values: Record<string, number> = {};
    fields.forEach((f, j) => { const v = parseFloat(vals[i * fields.length + j]); if (Number.isFinite(v)) values[f] = v; });   // NaN = missing
    out.push({ time: new Date(Number(pos[i * 3 + 2]) * 1000).toISOString(), values });
  }
  return out;
}

// WeatherSymbol3 → text and severity (the day shows its most severe symbol, like the model's daily weather code)
const SYMBOL: Record<number, [string, number]> = {
  1: ['Clear sky', 0], 2: ['Partly cloudy', 1], 3: ['Overcast', 2], 91: ['Haze', 3], 92: ['Fog', 4],
  21: ['Light showers', 10], 31: ['Light rain', 11], 41: ['Light snow showers', 12], 71: ['Light sleet showers', 13], 51: ['Light snowfall', 14], 81: ['Light sleet', 15],
  22: ['Showers', 20], 32: ['Rain', 21], 42: ['Snow showers', 22], 72: ['Sleet showers', 23], 52: ['Snowfall', 24], 82: ['Sleet', 25],
  23: ['Heavy showers', 30], 33: ['Heavy rain', 31], 43: ['Heavy snow showers', 32], 73: ['Heavy sleet showers', 33], 53: ['Heavy snowfall', 34], 83: ['Heavy sleet', 35],
  61: ['Thundershowers', 40], 63: ['Thunderstorm', 41], 62: ['Heavy thundershowers', 42], 64: ['Heavy thunderstorm', 43],
};
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Hourly forecast → daily values per local date (only days with at least 18 hours). */
export function fmiDaily(hours: FmiHour[], timeZone = 'Europe/Helsinki', minHours = MIN_HOURS): DailyForecast[] {
  const dateOf = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const byDate = new Map<string, FmiHour[]>();
  for (const h of hours) {
    const d = dateOf.format(new Date(h.time));
    byDate.set(d, [...(byDate.get(d) ?? []), h]);
  }
  const out: DailyForecast[] = [];
  for (const [date, hs] of byDate) {
    if (hs.length < minHours) continue;
    const series = (k: string) => hs.map((h) => h.values[k]).filter((v): v is number => v !== undefined);
    const t = series('Temperature'), p = series('Precipitation1h'), pop = series('PoP'), ws = series('WindSpeedMS');
    // dominant wind direction: vector mean weighted by wind speed
    let x = 0, y = 0;
    for (const h of hs) {
      const s = h.values.WindSpeedMS, d = h.values.WindDirection;
      if (s !== undefined && d !== undefined) { x += s * Math.sin(d * Math.PI / 180); y += s * Math.cos(d * Math.PI / 180); }
    }
    const sym = series('WeatherSymbol3').filter((s) => SYMBOL[s]).sort((a, b) => SYMBOL[b][1] - SYMBOL[a][1])[0];
    out.push({
      date,
      tempMax: t.length ? r1(Math.max(...t)) : undefined,
      tempMin: t.length ? r1(Math.min(...t)) : undefined,
      precipitationSum: p.length ? r1(p.reduce((a, b) => a + b, 0)) : undefined,
      precipitationProbability: pop.length ? Math.round(Math.max(...pop)) : undefined,
      windSpeedMax: ws.length ? r1(Math.max(...ws)) : undefined,
      windDirection: x || y ? Math.round((Math.atan2(x, y) * 180 / Math.PI + 360) % 360) : undefined,
      weatherDescription: sym !== undefined ? SYMBOL[sym][0] : undefined,
    });
  }
  return out;
}

let lastCallTime: string | undefined, lastCallOk: boolean | undefined, lastError: string | undefined;
export function getFmiForecastStatus() {
  return { name: 'FMI forecast (meteorologist-edited)', configured: true, available: true, lastCallTime, lastCallOk, lastError };
}

/** Daily FMI forecast for a point in Finland; empty when FMI has no forecast there. */
export async function fetchFmiDailyForecast(lat: number, lon: number): Promise<DailyForecast[]> {
  try {
    const hours = await cache.getOrFetch(`fmi:forecast:${lat.toFixed(3)},${lon.toFixed(3)}`, async () => {
      const xml = await getText('https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=getFeature' +
        `&storedquery_id=fmi::forecast::edited::weather::scandinavia::point::multipointcoverage&latlon=${lat.toFixed(4)},${lon.toFixed(4)}` +
        `&parameters=${PARAMS.join(',')}&endtime=${new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10)}T00:00:00Z`, 'FMI open data');
      if (xml.includes('<ExceptionReport')) throw new Error(`FMI: ${/<ExceptionText>([^<]*)/.exec(xml)?.[1] ?? 'query failed'}`);
      return parseFmiMultipoint(xml);
    }, TTL);
    lastCallTime = new Date().toISOString(); lastCallOk = true;
    return fmiDaily(hours);
  } catch (err) {
    lastCallTime = new Date().toISOString(); lastCallOk = false; lastError = String(err instanceof Error ? err.message : err);
    return [];
  }
}
