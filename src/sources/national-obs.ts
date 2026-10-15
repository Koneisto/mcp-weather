import { cache } from '../cache.js';
import { getJson, getText } from '../utils/http.js';
import { kmBetween, type NordicCountry } from '../utils/region.js';
import { fetchFmiObservation } from './fmi.js';
import { metGet, MET_ATTRIBUTION } from './met-norway.js';
import { wmoCodeToDescription } from '../utils/units.js';
import type { CurrentWeather, SourceResult } from '../types.js';

/**
 * Station observations from each country's national weather service, so that current weather is measured, not modelled:
 * Finland FMI, Sweden SMHI, Denmark DMI, Iceland IMO (vedur.is), Lithuania LHMT (meteo.lt), Estonia Keskkonnaagentuur.
 * Norway's station API (Frost) needs a registered client id, so Norway uses MET Norway's MET Nordic analysis instead
 * (observations and radar on a 1 km grid, from the nowcast). Latvia publishes bulk files only and is not covered.
 */
export interface Observation {
  provider: string;
  attribution: string;
  station: string;
  distanceKm: number;
  observationTime: string;
  weather: CurrentWeather;
  /** gridded analysis (MET Nordic), not a single station */
  analysis?: boolean;
}

const OBS_TTL = 10 * 60000, STATIONS_TTL = 24 * 3600000, MAX_AGE_MS = 3 * 3600000;
const n = (v: unknown): number | undefined => { const x = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN; return Number.isFinite(x) ? x : undefined; };
const WHOLE = new Set(['humidity', 'cloudCover', 'windDirection', 'visibility']);
/** Drop missing values and round like FMI's output: one decimal, whole numbers for %, degrees and metres. */
const clean = (w: CurrentWeather): CurrentWeather => Object.fromEntries(Object.entries(w).filter(([, v]) => v !== undefined)
  .map(([k, v]) => [k, typeof v === 'number' ? (WHOLE.has(k) ? Math.round(v) : Math.round(v * 10) / 10) : v])) as CurrentWeather;

interface Candidate { name: string; lat: number; lon: number; time: string; weather: CurrentWeather }
function nearest(cands: Candidate[], lat: number, lon: number, radiusKm: number) {
  const now = Date.now();
  return cands.filter((c) => c.weather.temperature !== undefined && now - Date.parse(c.time) <= MAX_AGE_MS)
    .map((c) => ({ c, d: kmBetween(lat, lon, c.lat, c.lon) })).filter((x) => x.d <= radiusKm).sort((a, b) => a.d - b.d)[0];
}
const toObs = (x: { c: Candidate; d: number }, provider: string, attribution: string): Observation =>
  ({ provider, attribution, station: x.c.name, distanceKm: Math.round(x.d * 10) / 10, observationTime: x.c.time, weather: clean(x.c.weather) });

// ---------- Sweden: SMHI metobs, latest hour of all stations per parameter ----------
const SMHI_PARAMS: Record<string, keyof CurrentWeather> = { '1': 'temperature', '6': 'humidity', '4': 'windSpeed', '3': 'windDirection', '21': 'windGusts',
  '9': 'pressure', '16': 'cloudCover', '7': 'precipitation', '39': 'dewPoint', '12': 'visibility' };
type SmhiSet = { station?: Array<{ key: string; name: string; latitude: number; longitude: number; value?: Array<{ date: number; value: string }> | null }> };
export function mergeSmhi(sets: Record<string, SmhiSet>): Candidate[] {
  const by = new Map<string, Candidate>();
  for (const [p, set] of Object.entries(sets)) {
    for (const s of set.station ?? []) {
      const v = s.value?.[s.value.length - 1];
      const x = v ? n(v.value) : undefined;
      if (x === undefined) continue;
      const c = by.get(s.key) ?? { name: s.name, lat: s.latitude, lon: s.longitude, time: new Date(v!.date).toISOString(), weather: {} };
      (c.weather as Record<string, number>)[SMHI_PARAMS[p]] = x;
      if (p === '1') c.time = new Date(v!.date).toISOString();
      by.set(s.key, c);
    }
  }
  return [...by.values()];
}
async function smhi(): Promise<Candidate[]> {
  return cache.getOrFetch('obs:smhi', async () => {
    const sets = await Promise.all(Object.keys(SMHI_PARAMS).map(async (p) => [p, await getJson<SmhiSet>(
      `https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/${p}/station-set/all/period/latest-hour/data.json`, 'SMHI').catch(() => ({}))] as const));
    return mergeSmhi(Object.fromEntries(sets));
  }, OBS_TTL);
}

// ---------- Denmark: DMI metObs, nearest active station, then its observations of the last 3 hours ----------
type DmiStations = { features: Array<{ properties: { stationId: string; name: string; validTo: string | null; country?: string; status?: string }; geometry: { coordinates: [number, number] } }> };
type DmiObs = { features: Array<{ properties: { parameterId: string; value: number; observed: string } }> };
const DMI_PARAMS: Record<string, keyof CurrentWeather> = { temp_dry: 'temperature', humidity: 'humidity', wind_speed: 'windSpeed', wind_dir: 'windDirection',
  wind_max: 'windGusts', pressure_at_sea: 'pressure', cloud_cover: 'cloudCover', precip_past1h: 'precipitation', temp_dew: 'dewPoint', visibility: 'visibility' };
export function dmiLatest(d: DmiObs): { time?: string; weather: CurrentWeather } {
  const latest: Record<string, { v: number; t: string }> = {};
  for (const f of d.features ?? []) {
    const p = f.properties, k = DMI_PARAMS[p.parameterId];
    if (!k || typeof p.value !== 'number') continue;
    if (!latest[k] || p.observed > latest[k].t) latest[k] = { v: p.value, t: p.observed };
  }
  const w: CurrentWeather = {};
  for (const [k, x] of Object.entries(latest)) (w as Record<string, number>)[k] = x.v;
  return { time: latest.temperature?.t, weather: w };
}
async function dmi(lat: number, lon: number, radiusKm: number): Promise<Observation | null> {
  const st = await cache.getOrFetch('obs:dmi:stations', () => getJson<DmiStations>('https://opendataapi.dmi.dk/v2/metObs/collections/station/items?status=Active&limit=10000', 'DMI'), STATIONS_TTL);
  const now = Date.now();
  const active = st.features.filter((f) => (!f.properties.validTo || Date.parse(f.properties.validTo) > now) && (f.properties.country ?? 'DNK') === 'DNK');
  const byId = new Map(active.map((f) => [f.properties.stationId, f]));
  const near = [...byId.values()].map((f) => ({ f, d: kmBetween(lat, lon, f.geometry.coordinates[1], f.geometry.coordinates[0]) }))
    .filter((x) => x.d <= radiusKm).sort((a, b) => a.d - b.d).slice(0, 3);
  for (const x of near) {
    const id = x.f.properties.stationId;
    const end = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'), start = new Date(now - MAX_AGE_MS).toISOString().replace(/\.\d+Z$/, 'Z');
    const obs = await cache.getOrFetch(`obs:dmi:${id}`, () => getJson<DmiObs>(
      `https://opendataapi.dmi.dk/v2/metObs/collections/observation/items?stationId=${id}&datetime=${start}/${end}&limit=2000`, 'DMI'), OBS_TTL);
    const l = dmiLatest(obs);
    if (l.time && l.weather.temperature !== undefined) {
      return { provider: 'DMI', attribution: 'DMI (Danish Meteorological Institute), CC BY 4.0', station: x.f.properties.name, distanceKm: Math.round(x.d * 10) / 10, observationTime: l.time, weather: clean(l.weather) };
    }
  }
  return null;
}

// ---------- Iceland: IMO automatic stations, 10-minute latest, joined with the station list ----------
type VedurStation = { station: number; name: string; lat: number; lon: number };
type VedurObs = Array<{ station: number; name: string; time: string; t?: number | null; rh?: number | null; f?: number | null; fg?: number | null; d?: number | null; p?: number | null; r?: number | null; td?: number | null }>;
export function joinVedur(stations: VedurStation[], obs: VedurObs): Candidate[] {
  const pos = new Map(stations.map((s) => [s.station, s]));
  return obs.flatMap((o) => {
    const s = pos.get(o.station);
    if (!s) return [];
    return [{ name: o.name, lat: s.lat, lon: s.lon, time: o.time.endsWith('Z') ? o.time : o.time + 'Z',   // vedur.is times are UTC without a zone
      weather: { temperature: n(o.t), humidity: n(o.rh), windSpeed: n(o.f), windGusts: n(o.fg), windDirection: n(o.d), pressure: n(o.p), precipitation: n(o.r), dewPoint: n(o.td) } }];
  });
}
async function vedur(): Promise<Candidate[]> {
  const [st, obs] = await Promise.all([
    cache.getOrFetch('obs:vedur:stations', () => getJson<VedurStation[]>('https://api.vedur.is/weather/stations', 'Icelandic Met Office'), STATIONS_TTL),
    cache.getOrFetch('obs:vedur:aws', () => getJson<VedurObs>('https://api.vedur.is/weather/observations/aws/10min/latest?parameters=basic', 'Icelandic Met Office'), OBS_TTL),
  ]);
  return joinVedur(st, obs);
}

// ---------- Lithuania: LHMT (meteo.lt), nearest station's latest hourly observation ----------
type LtStation = { code: string; name: string; coordinates: { latitude: number; longitude: number } };
type LtObs = { observations?: Array<{ observationTimeUtc: string; airTemperature?: number; relativeHumidity?: number; windSpeed?: number; windGust?: number;
  windDirection?: number; cloudCover?: number; seaLevelPressure?: number; precipitation?: number; conditionCode?: string; feelsLikeTemperature?: number }> };
export function ltLatest(d: LtObs): { time?: string; weather: CurrentWeather } {
  const o = d.observations?.[d.observations.length - 1];
  if (!o) return { weather: {} };
  return { time: o.observationTimeUtc.replace(' ', 'T') + 'Z', weather: { temperature: n(o.airTemperature), feelsLike: n(o.feelsLikeTemperature), humidity: n(o.relativeHumidity),
    windSpeed: n(o.windSpeed), windGusts: n(o.windGust), windDirection: n(o.windDirection), cloudCover: n(o.cloudCover), pressure: n(o.seaLevelPressure),
    precipitation: n(o.precipitation), weatherDescription: o.conditionCode && o.conditionCode !== 'na' ? o.conditionCode.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) : undefined } };
}
async function lhmt(lat: number, lon: number, radiusKm: number): Promise<Observation | null> {
  const st = await cache.getOrFetch('obs:lt:stations', () => getJson<LtStation[]>('https://api.meteo.lt/v1/stations', 'LHMT'), STATIONS_TTL);
  const near = st.map((s) => ({ s, d: kmBetween(lat, lon, s.coordinates.latitude, s.coordinates.longitude) })).filter((x) => x.d <= radiusKm).sort((a, b) => a.d - b.d).slice(0, 2);
  for (const x of near) {
    const l = ltLatest(await cache.getOrFetch(`obs:lt:${x.s.code}`, () => getJson<LtObs>(`https://api.meteo.lt/v1/stations/${x.s.code}/observations/latest`, 'LHMT'), OBS_TTL));
    if (l.time && l.weather.temperature !== undefined && Date.now() - Date.parse(l.time) <= MAX_AGE_MS) {
      return { provider: 'LHMT', attribution: 'Lithuanian Hydrometeorological Service (LHMT, meteo.lt), CC BY-SA 4.0', station: x.s.name, distanceKm: Math.round(x.d * 10) / 10, observationTime: l.time, weather: clean(l.weather) };
    }
  }
  return null;
}

// ---------- Estonia: Keskkonnaagentuur observations XML (all stations, one timestamp) ----------
export function parseEstonia(xml: string): Candidate[] {
  const ts = Number(/<observations timestamp="(\d+)"/.exec(xml)?.[1]);
  const time = Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : new Date(0).toISOString();
  const tag = (s: string, t: string) => { const m = new RegExp(`<${t}>([^<]*)</${t}>`).exec(s); return m ? m[1].trim() : ''; };
  return [...xml.matchAll(/<station>[\s\S]*?<\/station>/g)].map((m) => {
    const s = m[0], vis = n(tag(s, 'visibility'));
    return { name: tag(s, 'name'), lat: Number(tag(s, 'latitude')), lon: Number(tag(s, 'longitude')), time,
      weather: { temperature: n(tag(s, 'airtemperature')), humidity: n(tag(s, 'relativehumidity')), windSpeed: n(tag(s, 'windspeed')), windGusts: n(tag(s, 'windspeedmax')),
        windDirection: n(tag(s, 'winddirection')), pressure: n(tag(s, 'airpressure')), precipitation: n(tag(s, 'precipitations')),
        visibility: vis !== undefined ? vis * 1000 : undefined, weatherDescription: tag(s, 'phenomenon') || undefined } };
  }).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
}
async function estonia(): Promise<Candidate[]> {
  return cache.getOrFetch('obs:ee', async () => parseEstonia(await getText('https://www.ilmateenistus.ee/ilma_andmed/xml/observations.php', 'Keskkonnaagentuur')), OBS_TTL);
}

// ---------- Norway: MET Nordic analysis (nowcast instant values, 1 km grid of observations and radar) ----------
interface Nowcast { properties: { meta: { updated_at?: string }; timeseries: Array<{ time: string; data: { instant: { details: Record<string, number> } } }> } }
export async function metNordicAnalysis(lat: number, lon: number): Promise<Observation | null> {
  const d = await metGet<Nowcast>('nowcast/2.0/complete', lat, lon);
  const s = d.properties.timeseries[0];
  if (!s) return null;
  const x = s.data.instant.details;
  return { provider: 'MET Norway', attribution: MET_ATTRIBUTION, station: 'MET Nordic analysis (observations and radar, 1 km grid)', distanceKm: 0, observationTime: s.time, analysis: true,
    weather: clean({ temperature: n(x.air_temperature), feelsLike: n(x.apparent_air_temperature), humidity: n(x.relative_humidity), windSpeed: n(x.wind_speed),
      windDirection: n(x.wind_from_direction), windGusts: n(x.wind_speed_of_gust) }) };   // precipitation_rate is an intensity (mm/h), not an amount: left out
}

const ATTR = {
  SMHI: 'SMHI (Swedish Meteorological and Hydrological Institute), CC BY 4.0',
  IMO: 'Icelandic Met Office (vedur.is), CC BY 4.0',
  EE: 'Estonian Environment Agency (Keskkonnaagentuur), https://www.ilmateenistus.ee',   // terms: credit the agency and link ilmateenistus.ee
};
let lastCallTime: string | undefined, lastCallOk: boolean | undefined, lastError: string | undefined;
export function getNationalObsStatus() {
  return { name: 'National observations (SMHI, DMI, IMO, LHMT, Estonia, MET Nordic)', configured: true, available: true, lastCallTime, lastCallOk, lastError };
}

/**
 * Measured current weather near a point from the country's national service: nearest station with a fresh temperature within
 * `radiusKm` (Norway: the MET Nordic analysis at the point). ok:false when the country is not covered or no station is close.
 */
export async function fetchNationalObservation(country: NordicCountry | null, lat: number, lon: number, radiusKm = 15): Promise<SourceResult<Observation>> {
  const none = (why: string) => ({ ok: false as const, error: why, source: 'national' });
  try {
    let obs: Observation | null = null;
    if (country === 'FI') {
      const r = await fetchFmiObservation(lat, lon, radiusKm);
      if (r.ok) obs = { provider: 'FMI', attribution: 'Finnish Meteorological Institute (CC BY 4.0)', station: r.data.station, distanceKm: r.data.distanceKm, observationTime: r.data.observationTime, weather: r.data.weather };
      else return none(r.error);
    } else if (country === 'SE') { const x = nearest(await smhi(), lat, lon, radiusKm); obs = x ? toObs(x, 'SMHI', ATTR.SMHI) : null; }
    else if (country === 'DK') obs = await dmi(lat, lon, radiusKm);
    else if (country === 'IS') { const x = nearest(await vedur(), lat, lon, radiusKm); obs = x ? toObs(x, 'IMO', ATTR.IMO) : null; }
    else if (country === 'LT') obs = await lhmt(lat, lon, radiusKm);
    else if (country === 'EE') { const x = nearest(await estonia(), lat, lon, radiusKm); obs = x ? toObs(x, 'Keskkonnaagentuur', ATTR.EE) : null; }
    else if (country === 'NO') obs = radiusKm > 15 ? null : await metNordicAnalysis(lat, lon);   // a grid point, not a station: no "nearest station" reference
    else return none('no national observations for this location');
    lastCallTime = new Date().toISOString(); lastCallOk = true;
    if (obs && obs.weather.weatherCode !== undefined && !obs.weather.weatherDescription) obs.weather.weatherDescription = wmoCodeToDescription(obs.weather.weatherCode);
    return obs ? { ok: true, source: obs.provider, data: obs } : none(`no station with fresh data within ${radiusKm} km`);
  } catch (err) {
    lastCallTime = new Date().toISOString(); lastCallOk = false; lastError = String(err);
    return none(String(err));
  }
}
