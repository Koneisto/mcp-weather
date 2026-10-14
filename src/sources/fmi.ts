import type { CurrentWeather, SourceResult } from '../types.js';
import { config } from '../config.js';
import { cache } from '../cache.js';
import { errorText } from '../utils/units.js';

/**
 * Finnish Meteorological Institute (FMI) open data: measured 10-minute observations from the
 * nearest weather station. No API key. Data license CC BY 4.0, so output must credit FMI.
 *
 * Used in two places:
 *  - get_current_weather: measured values take precedence over model data for locations in Finland
 *  - get_metar: fallback for Finnish airports (EF**) when aviationweather.gov is unavailable.
 *    FMI open data does not publish METAR messages, so the fallback is the airport station's
 *    observation, not a METAR (no raw message, flight category or cloud base).
 */

const SOURCE = 'FMI';
const WFS = 'https://opendata.fmi.fi/wfs';
const QUERY = 'fmi::observations::weather::timevaluepair';
const PARAMS = ['t2m', 'td', 'rh', 'ws_10min', 'wg_10min', 'wd_10min', 'p_sea', 'vis', 'n_man', 'r_1h'];
const CACHE_TTL_MS = 10 * 60 * 1000;      // stations report every 10 minutes
const MAX_AGE_MS = 60 * 60 * 1000;        // older values are not "current"
// Measurement beats the model only when the station is near: 30 km away a lakeside and an inland spot can differ by
// several degrees, while the model is computed for the exact point.
const DEFAULT_RADIUS_KM = 15;

// Rough bounding box of Finland: outside it FMI has no stations, so no request is made.
const FINLAND = { latMin: 59.4, latMax: 70.2, lonMin: 19.0, lonMax: 31.7 };

let lastCallTime: string | undefined;
let lastCallOk: boolean | undefined;
let lastError: string | undefined;

export function getFmiStatus() {
  return { name: SOURCE, configured: true, available: true, lastCallTime, lastCallOk, lastError };
}

export function isInFinland(lat: number, lon: number): boolean {
  return lat >= FINLAND.latMin && lat <= FINLAND.latMax && lon >= FINLAND.lonMin && lon <= FINLAND.lonMax;
}

export interface FmiStation {
  fmisid: string;
  name: string;
  lat: number;
  lon: number;
  /** latest valid value per parameter */
  values: Record<string, { time: string; value: number }>;
}

export interface FmiObservation {
  station: string;
  fmisid: string;
  distanceKm: number;
  observationTime: string;
  weather: CurrentWeather;
}

/** Parse a WFS timevaluepair response into stations with the latest non-NaN value of each parameter. */
export function parseFmiTimeValuePair(xml: string): FmiStation[] {
  const stations = new Map<string, FmiStation>();
  for (const member of xml.split('<wfs:member>').slice(1)) {
    const fmisid = /<gml:identifier codeSpace="[^"]*fmisid">\s*([^<\s]+)/.exec(member)?.[1];
    const name = /<gml:name codeSpace="[^"]*locationcode\/name">\s*([^<]+?)\s*</.exec(member)?.[1];
    const pos = /<gml:pos>\s*([-\d.]+)\s+([-\d.]+)/.exec(member);
    const param = /<wml2:MeasurementTimeseries gml:id="obs-obs-[\d-]+-([A-Za-z0-9_]+)"/.exec(member)?.[1];
    if (!fmisid || !name || !pos || !param) continue;

    let st = stations.get(fmisid);
    if (!st) {
      st = { fmisid, name, lat: parseFloat(pos[1]), lon: parseFloat(pos[2]), values: {} };
      stations.set(fmisid, st);
    }
    const tvp = /<wml2:time>([^<]+)<\/wml2:time>\s*<wml2:value>([^<]*)<\/wml2:value>/g;
    let m: RegExpExecArray | null;
    while ((m = tvp.exec(member))) {
      const v = parseFloat(m[2]);
      if (Number.isFinite(v)) st.values[param] = { time: m[1], value: v };   // NaN = not measured
    }
  }
  return [...stations.values()];
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** FMI station values → CurrentWeather (only measured fields; conditions text comes from other sources). */
export function stationToWeather(st: FmiStation): CurrentWeather {
  const v = (p: string) => st.values[p]?.value;
  const clouds = v('n_man');                       // octas 0–8, 9 = sky obscured (fog)
  const precip = v('r_1h');                        // negative = no precipitation
  return {
    temperature: v('t2m'),
    dewPoint: v('td'),
    humidity: v('rh'),
    windSpeed: v('ws_10min'),
    windGusts: v('wg_10min'),
    windDirection: v('wd_10min'),
    pressure: v('p_sea'),
    visibility: v('vis'),
    cloudCover: clouds === undefined ? undefined : clouds >= 9 ? 100 : Math.round((clouds / 8) * 100),
    precipitation: precip === undefined ? undefined : Math.max(0, precip),
  };
}

/**
 * Observation from the nearest FMI station within `radiusKm` that has a fresh temperature reading.
 * Returns ok:false outside Finland or when no station is close enough.
 */
export async function fetchFmiObservation(lat: number, lon: number, radiusKm = DEFAULT_RADIUS_KM): Promise<SourceResult<FmiObservation>> {
  if (!isInFinland(lat, lon)) return { ok: false, error: 'Location is outside Finland', source: SOURCE };

  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((x) => x.toFixed(3)).join(',');
  const key = `fmi:${bbox}`;

  try {
    const stations = await cache.getOrFetch<FmiStation[]>(
      key,
      async () => {
        const start = new Date(Date.now() - MAX_AGE_MS).toISOString().replace(/\.\d+Z$/, 'Z');
        const url = `${WFS}?service=WFS&version=2.0.0&request=getFeature&storedquery_id=${QUERY}` +
          `&bbox=${bbox}&starttime=${start}&parameters=${PARAMS.join(',')}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
        try {
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) throw new Error(`FMI open data returned ${res.status}`);
          const xml = await res.text();
          if (xml.includes('<ExceptionReport')) {
            throw new Error(`FMI: ${/<ExceptionText>([^<]*)/.exec(xml)?.[1] ?? 'query failed'}`);
          }
          return parseFmiTimeValuePair(xml);
        } finally {
          clearTimeout(timeout);
        }
      },
      CACHE_TTL_MS,
    );

    lastCallTime = new Date().toISOString();
    lastCallOk = true;

    const now = Date.now();
    const best = stations
      .filter((s) => s.values.t2m && now - Date.parse(s.values.t2m.time) <= MAX_AGE_MS)
      .map((s) => ({ s, d: distanceKm(lat, lon, s.lat, s.lon) }))
      .filter((x) => x.d <= radiusKm)
      .sort((a, b) => a.d - b.d)[0];
    if (!best) return { ok: false, error: `No FMI station with fresh data within ${radiusKm} km`, source: SOURCE };

    return {
      ok: true,
      source: SOURCE,
      data: {
        station: best.s.name,
        fmisid: best.s.fmisid,
        distanceKm: Math.round(best.d * 10) / 10,
        observationTime: best.s.values.t2m.time,
        weather: stationToWeather(best.s),
      },
    };
  } catch (err) {
    lastCallTime = new Date().toISOString();
    lastCallOk = false;
    lastError = errorText(err, config.httpTimeoutMs);
    return { ok: false, error: lastError, source: SOURCE };
  }
}
