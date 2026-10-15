import { cache } from '../cache.js';
import { getJson, getText } from '../utils/http.js';
import { kmBetween } from '../utils/region.js';
import { parseFmiTimeValuePair } from './fmi.js';
import { metGet, MET_ATTRIBUTION } from './met-norway.js';

/**
 * Sea conditions near a point: what the national services measure, plus a wave model everywhere.
 *   sea level           FMI mareographs (FI), SMHI (SE), DMI (DK), Kartverket (NO); each against its own national reference
 *   sea level forecast  FMI (FI), Kartverket (NO: tide plus weather effect)
 *   water temperature   FMI mareographs and wave buoys, SMHI, DMI
 *   waves               FMI and SMHI wave buoys
 *   wave model          MET Norway Oceanforecast in Norwegian waters, Open-Meteo Marine elsewhere
 * All keyless. Reference levels differ by country, so every sea level carries its reference.
 */

export interface Reading { provider: string; station: string; distanceKm: number; time: string }
export interface SeaLevel extends Reading { cm: number; reference: string }
export interface WaterTemp extends Reading { celsius: number }
export interface Waves extends Reading { heightM: number; directionDeg?: number; periodS?: number }
export interface LevelPoint { time: string; cm: number }
export interface SeaLevelForecast { provider: string; station: string; reference: string; until: string; high: LevelPoint; low: LevelPoint }
export interface WaveModel { provider: string; time?: string; heightM?: number; directionDeg?: number; periodS?: number; seaTempC?: number; maxHeightM?: number; maxTime?: string }
export interface Marine { seaLevel?: SeaLevel; forecast?: SeaLevelForecast; waterTemp?: WaterTemp; waves?: Waves; model?: WaveModel; attribution: string[] }

/** One measuring station with its latest values (each with its own time). */
export interface MarinePoint {
  provider: string; station: string; lat: number; lon: number; reference?: string; id?: string;
  level?: { cm: number; time: string };
  temp?: { c: number; time: string };
  wave?: { hs: number; dir?: number; per?: number; time: string };
}

export const ATTRIBUTION: Record<string, string> = {
  FMI: 'Finnish Meteorological Institute (CC BY 4.0)',
  SMHI: 'SMHI (Swedish Meteorological and Hydrological Institute), CC BY 4.0',
  DMI: 'DMI (Danish Meteorological Institute), CC BY 4.0',
  Kartverket: 'Kartverket (Norwegian Mapping Authority), CC BY 4.0',
  'MET Norway': MET_ATTRIBUTION,
  'Open-Meteo': 'Open-Meteo Marine (open-meteo.com), CC BY 4.0',
};
const REF = { FMI: 'theoretical mean sea level', SMHI: 'RH 2000', DMI: 'DVR90', Kartverket: 'mean sea level' };

// A tide gauge 60 km away still tells the sea level of the same basin; water temperature varies faster along the coast;
// wave buoys are offshore, so they are used up to 100 km out.
const LEVEL_KM = 60, TEMP_KM = 40, WAVE_KM = 100;
const MAX_AGE_MS = 3 * 3600000, OBS_TTL = 10 * 60000, STATIONS_TTL = 24 * 3600000;
const r1 = (x: number) => Math.round(x * 10) / 10;
const iso = (t: string | number) => new Date(t).toISOString().replace('.000Z', 'Z');
const num = (v: unknown) => { const x = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN; return Number.isFinite(x) ? x : undefined; };

// Rough areas with stations of each provider (coast plus margin); outside them the provider is not asked.
const AREA: Record<string, [number, number, number, number]> = {   // latMin, latMax, lonMin, lonMax
  FMI: [58.8, 66.3, 19, 28.5], SMHI: [55, 66.3, 10.5, 24.5], DMI: [54.3, 58, 7.5, 15.5], Kartverket: [57.5, 80, 4, 31.5],
};
const inArea = (p: string, lat: number, lon: number) => { const a = AREA[p]; return lat >= a[0] && lat <= a[1] && lon >= a[2] && lon <= a[3]; };

// ---------- Finland: FMI mareographs (sea level mm, water temperature) and wave buoys ----------
const WFS = 'https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=getFeature&storedquery_id=';
const FINLAND_BBOX = '19,59,32,71';

/** FMI mareograph and wave-buoy responses (timevaluepair) → stations. WATLEV is mm against the theoretical mean sea level. */
export function fmiMarinePoints(mareographXml: string, waveXml: string): MarinePoint[] {
  const pts = new Map<string, MarinePoint>();
  const get = (s: { fmisid: string; name: string; lat: number; lon: number }) => {
    let p = pts.get(s.fmisid);
    if (!p) { p = { provider: 'FMI', station: s.name, lat: s.lat, lon: s.lon, reference: REF.FMI, id: s.fmisid }; pts.set(s.fmisid, p); }
    return p;
  };
  for (const s of parseFmiTimeValuePair(mareographXml)) {
    const p = get(s), lv = s.values.WATLEV, tw = s.values.TW_PT1H_AVG;
    if (lv) p.level = { cm: Math.round(lv.value / 10), time: lv.time };
    if (tw) p.temp = { c: tw.value, time: tw.time };
  }
  for (const s of parseFmiTimeValuePair(waveXml)) {
    const v = s.values, p = get(s);
    if (v.WaveHs) p.wave = { hs: v.WaveHs.value, dir: v.ModalWDi?.value, per: v.WTP?.value, time: v.WaveHs.time };
    if (v.TWATER && !p.temp) p.temp = { c: v.TWATER.value, time: v.TWATER.time };
  }
  return [...pts.values()];
}

async function fmiPoints(): Promise<MarinePoint[]> {
  return cache.getOrFetch('marine:fmi', async () => {
    const start = iso(Date.now() - MAX_AGE_MS);
    const q = (query: string, params: string) => getText(`${WFS}${query}&bbox=${FINLAND_BBOX}&starttime=${start}&parameters=${params}`, 'FMI open data');
    const [m, w] = await Promise.all([
      q('fmi::observations::mareograph::timevaluepair', 'WATLEV,TW_PT1H_AVG'),
      q('fmi::observations::wave::timevaluepair', 'WaveHs,ModalWDi,WTP,TWATER'),
    ]);
    return fmiMarinePoints(m, w);
  }, OBS_TTL);
}

/** FMI sea level forecast (simple feature, SeaLevel in cm against the theoretical mean sea level). */
export function parseFmiSeaLevel(xml: string): LevelPoint[] {
  const out: LevelPoint[] = [];
  const re = /<BsWfs:Time>([^<]+)<\/BsWfs:Time>\s*<BsWfs:ParameterName>SeaLevel<\/BsWfs:ParameterName>\s*<BsWfs:ParameterValue>([^<]+)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) { const v = num(m[2]); if (v !== undefined) out.push({ time: m[1], cm: Math.round(v) }); }
  return out;
}

// ---------- Sweden: SMHI oceanographic observations, last day of all stations per parameter ----------
// 6 sea level (cm, RH 2000), 5 water temperature, 1 significant wave height, 8 wave direction at peak, 9 peak period
type OcobsSet = { station?: Array<{ key: string; name: string; latitude: number; longitude: number; value?: Array<{ date: number; value: number | string; quality?: string }> | null }> };
export function smhiMarinePoints(sets: Record<string, OcobsSet>): MarinePoint[] {
  const pts = new Map<string, MarinePoint>();
  for (const [param, set] of Object.entries(sets)) {
    for (const s of set.station ?? []) {
      const v = [...(s.value ?? [])].reverse().find((x) => x.quality !== 'Y' && num(x.value) !== undefined);   // Y = suspect
      if (!v) continue;
      const x = num(v.value)!, time = iso(v.date);
      const p = pts.get(s.key) ?? { provider: 'SMHI', station: s.name, lat: s.latitude, lon: s.longitude, reference: REF.SMHI };
      if (param === '6') p.level = { cm: Math.round(x), time };
      else if (param === '5') p.temp = { c: x, time };
      else if (param === '1') p.wave = { ...p.wave, hs: x, time };
      else if (param === '8' || param === '9') p.wave = { ...(p.wave ?? { hs: NaN, time }), [param === '8' ? 'dir' : 'per']: x };
      pts.set(s.key, p);
    }
  }
  for (const p of pts.values()) if (p.wave && !Number.isFinite(p.wave.hs)) delete p.wave;   // direction or period without a height
  return [...pts.values()];
}

async function smhiPoints(): Promise<MarinePoint[]> {
  return cache.getOrFetch('marine:smhi', async () => {
    const params = ['6', '5', '1', '8', '9'];
    const sets = await Promise.all(params.map((p) => getJson<OcobsSet>(
      `https://opendata-download-ocobs.smhi.se/api/version/latest/parameter/${p}/station-set/all/period/latest-day/data.json`, 'SMHI').catch(() => ({}))));
    return smhiMarinePoints(Object.fromEntries(params.map((p, i) => [p, sets[i]])));
  }, OBS_TTL);
}

// ---------- Denmark: DMI oceanObs (sealev_dvr cm against DVR90, tw water temperature) ----------
type DmiFeatures = { features?: Array<{ geometry?: { coordinates: number[] }; properties: Record<string, unknown> }> };
export function dmiMarinePoints(stations: DmiFeatures, obs: DmiFeatures): MarinePoint[] {
  const names = new Map<string, string>();
  for (const f of stations.features ?? []) names.set(String(f.properties.stationId), String(f.properties.name));
  const pts = new Map<string, MarinePoint>();
  // newest first, so the first value per station and parameter is the latest
  const sorted = [...(obs.features ?? [])].sort((a, b) => String(b.properties.observed).localeCompare(String(a.properties.observed)));
  for (const f of sorted) {
    const id = String(f.properties.stationId), v = num(f.properties.value), c = f.geometry?.coordinates;
    if (v === undefined || !c) continue;
    const p = pts.get(id) ?? { provider: 'DMI', station: names.get(id) ?? `DMI station ${id}`, lat: c[1], lon: c[0], reference: REF.DMI };
    const time = iso(String(f.properties.observed));
    if (f.properties.parameterId === 'sealev_dvr' && !p.level) p.level = { cm: Math.round(v), time };
    if (f.properties.parameterId === 'tw' && !p.temp) p.temp = { c: v, time };
    pts.set(id, p);
  }
  return [...pts.values()];
}

async function dmiPoints(lat: number, lon: number): Promise<MarinePoint[]> {
  const bbox = [lon - 1.2, lat - 0.6, lon + 1.2, lat + 0.6].map((x) => x.toFixed(2)).join(',');
  return cache.getOrFetch(`marine:dmi:${bbox}`, async () => {
    const base = 'https://opendataapi.dmi.dk/v2/oceanObs/collections';
    const window = `${iso(Date.now() - MAX_AGE_MS)}/${iso(Date.now())}`;
    const [st, lv, tw] = await Promise.all([
      cache.getOrFetch('marine:dmi:stations', () => getJson<DmiFeatures>(`${base}/station/items?status=Active&limit=1000`, 'DMI'), STATIONS_TTL),
      getJson<DmiFeatures>(`${base}/observation/items?parameterId=sealev_dvr&bbox=${bbox}&datetime=${window}&limit=2000`, 'DMI'),
      getJson<DmiFeatures>(`${base}/observation/items?parameterId=tw&bbox=${bbox}&datetime=${window}&limit=2000`, 'DMI'),
    ]);
    return dmiMarinePoints(st, { features: [...(lv.features ?? []), ...(tw.features ?? [])] });
  }, OBS_TTL);
}

// ---------- Norway: Kartverket permanent tide gauges (observed level and forecast, cm against mean sea level) ----------
export function parseKartverketStations(xml: string): Array<{ name: string; code: string; lat: number; lon: number }> {
  return [...xml.matchAll(/<location name="([^"]+)" code="([^"]+)" latitude="([-\d.]+)" longitude="([-\d.]+)"/g)]
    .map((m) => ({ name: m[1], code: m[2], lat: parseFloat(m[3]), lon: parseFloat(m[4]) }));
}
/** Kartverket locationdata: observation series and forecast series (tide plus weather effect). */
export function parseKartverket(xml: string): { observation: LevelPoint[]; forecast: LevelPoint[] } {
  const series = (type: string) => {
    const block = new RegExp(`<data type="${type}"[^>]*>([\\s\\S]*?)</data>`).exec(xml)?.[1] ?? '';
    return [...block.matchAll(/<waterlevel value="([-\d.]+)" time="([^"]+)"/g)].map((m) => ({ time: iso(m[2]), cm: Math.round(parseFloat(m[1])) }));
  };
  return { observation: series('observation'), forecast: series('forecast') };
}

async function kartverket(lat: number, lon: number): Promise<{ point: MarinePoint; forecast: LevelPoint[] } | null> {
  const base = 'https://vannstand.kartverket.no/tideapi.php';
  const stations = await cache.getOrFetch('marine:kv:stations',
    async () => parseKartverketStations(await getText(`${base}?tide_request=stationlist&type=perm&lang=en`, 'Kartverket')), STATIONS_TTL);
  const near = stations.map((s) => ({ s, d: kmBetween(lat, lon, s.lat, s.lon) })).sort((a, b) => a.d - b.d)[0];
  if (!near || near.d > LEVEL_KM) return null;
  const s = near.s;
  const data = await cache.getOrFetch(`marine:kv:${s.code}`, async () => {
    const t = (ms: number) => new Date(ms).toISOString().slice(0, 16);
    return parseKartverket(await getText(`${base}?tide_request=locationdata&lat=${s.lat}&lon=${s.lon}&fromtime=${t(Date.now() - MAX_AGE_MS)}` +
      `&totime=${t(Date.now() + 36 * 3600000)}&datatype=all&refcode=msl&lang=en&interval=60&dst=0`, 'Kartverket'));
  }, OBS_TTL);
  const last = data.observation[data.observation.length - 1];
  return { point: { provider: 'Kartverket', station: s.name, lat: s.lat, lon: s.lon, reference: REF.Kartverket, level: last }, forecast: data.forecast };
}

// ---------- wave model ----------
interface OceanForecast { properties: { timeseries: Array<{ time: string; data: { instant: { details: Record<string, number | undefined> } } }> } }
interface OpenMeteoMarine {
  current?: { time: string; wave_height?: number | null; wave_direction?: number | null; wave_period?: number | null; sea_surface_temperature?: number | null };
  hourly?: { time: string[]; wave_height: Array<number | null> };
}
/** Highest value in the next 24 h of an hourly series. */
function max24(series: Array<{ time: string; h?: number | null }>): { maxHeightM?: number; maxTime?: string } {
  const now = Date.now() - 3600000;
  const next = series.filter((x) => x.h != null && Date.parse(x.time) >= now && Date.parse(x.time) <= now + 25 * 3600000);
  const top = next.sort((a, b) => b.h! - a.h!)[0];
  return top ? { maxHeightM: r1(top.h!), maxTime: top.time } : {};
}
export function openMeteoMarineModel(d: OpenMeteoMarine): WaveModel | null {
  const c = d.current;
  if (!c || c.wave_height == null && c.sea_surface_temperature == null) return null;   // land point: the model has no sea here
  // the current value (15-minute) joins the hourly series, so the 24 h maximum is never below the value now
  const hourly = [{ time: iso(c.time + 'Z'), h: c.wave_height }, ...(d.hourly?.time ?? []).map((t, i) => ({ time: iso(t + 'Z'), h: d.hourly!.wave_height[i] }))];
  const opt = (x: number | null | undefined, f: (v: number) => number) => (x == null ? undefined : f(x));
  return {
    provider: 'Open-Meteo', time: iso(c.time + 'Z'), heightM: opt(c.wave_height, r1), directionDeg: opt(c.wave_direction, Math.round),
    periodS: opt(c.wave_period, r1), seaTempC: opt(c.sea_surface_temperature, r1), ...max24(hourly),
  };
}
export function oceanForecastModel(d: OceanForecast): WaveModel | null {
  const ts = d.properties?.timeseries ?? [];
  const now = Date.now();
  const cur = ts.filter((x) => Date.parse(x.time) <= now).pop() ?? ts[0];
  if (!cur) return null;
  const det = cur.data.instant.details;
  return {
    provider: 'MET Norway', time: cur.time, heightM: det.sea_surface_wave_height === undefined ? undefined : r1(det.sea_surface_wave_height),
    directionDeg: det.sea_surface_wave_from_direction === undefined ? undefined : Math.round(det.sea_surface_wave_from_direction),
    seaTempC: det.sea_water_temperature === undefined ? undefined : r1(det.sea_water_temperature), ...max24(ts.map((x) => ({ time: x.time, h: x.data.instant.details.sea_surface_wave_height }))),
  };
}

async function waveModel(lat: number, lon: number, norway: boolean): Promise<WaveModel | null> {
  if (norway) {
    const m = await metGet<OceanForecast>('oceanforecast/2.0/complete', lat, lon).then(oceanForecastModel).catch(() => null);
    if (m) return m;
  }
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    '&current=wave_height,wave_direction,wave_period,sea_surface_temperature&hourly=wave_height&forecast_days=2&timezone=GMT';
  return cache.getOrFetch(`marine:om:${lat.toFixed(3)},${lon.toFixed(3)}`, async () => openMeteoMarineModel(await getJson<OpenMeteoMarine>(url, 'Open-Meteo Marine')), OBS_TTL);
}

// ---------- combine ----------
type Pick = { p: MarinePoint; d: number };
/** Nearest station within `km` whose value `key` is fresh. */
export function nearestWith(points: MarinePoint[], lat: number, lon: number, key: 'level' | 'temp' | 'wave', km: number, now = Date.now()): Pick | undefined {
  return points.filter((p) => p[key] && now - Date.parse(p[key]!.time) <= MAX_AGE_MS)
    .map((p) => ({ p, d: kmBetween(lat, lon, p.lat, p.lon) })).filter((x) => x.d <= km).sort((a, b) => a.d - b.d)[0];
}
const reading = (x: Pick, time: string): Reading => ({ provider: x.p.provider, station: x.p.station, distanceKm: r1(x.d), time });

/** High and low of a forecast series from now on. */
export function forecastRange(series: LevelPoint[], now = Date.now()): { high: LevelPoint; low: LevelPoint; until: string } | null {
  const next = series.filter((x) => Date.parse(x.time) >= now - 1800000);
  if (next.length < 2) return null;
  const high = next.reduce((a, b) => (b.cm > a.cm ? b : a)), low = next.reduce((a, b) => (b.cm < a.cm ? b : a));
  return { high, low, until: next[next.length - 1].time };
}

let lastCallTime: string | undefined, lastCallOk: boolean | undefined, lastError: string | undefined;
export function getMarineStatus() {
  return { name: 'Marine (FMI, SMHI, DMI, Kartverket, Oceanforecast, Open-Meteo Marine)', configured: true, available: true, lastCallTime, lastCallOk, lastError };
}

/** Sea level, its forecast, water temperature and waves near a point, and the wave model. Providers that fail are skipped. */
export async function fetchMarine(lat: number, lon: number, norway: boolean): Promise<Marine> {
  const errors: string[] = [];
  const soft = <T>(p: Promise<T>, fallback: T) => p.catch((e) => { errors.push(String(e instanceof Error ? e.message : e)); return fallback; });
  const [fi, se, dk, no, model] = await Promise.all([
    inArea('FMI', lat, lon) ? soft(fmiPoints(), []) : [],
    inArea('SMHI', lat, lon) ? soft(smhiPoints(), []) : [],
    inArea('DMI', lat, lon) ? soft(dmiPoints(lat, lon), []) : [],
    inArea('Kartverket', lat, lon) ? soft(kartverket(lat, lon), null) : null,
    soft(waveModel(lat, lon, norway), null),
  ]);
  lastCallTime = new Date().toISOString(); lastCallOk = errors.length === 0; lastError = errors[0] ?? lastError;
  const points = [...fi, ...se, ...dk, ...(no ? [no.point] : [])];

  const out: Marine = { attribution: [] };
  const lv = nearestWith(points, lat, lon, 'level', LEVEL_KM);
  if (lv) out.seaLevel = { ...reading(lv, lv.p.level!.time), cm: lv.p.level!.cm, reference: lv.p.reference! };
  const tw = nearestWith(points, lat, lon, 'temp', TEMP_KM);
  if (tw) out.waterTemp = { ...reading(tw, tw.p.temp!.time), celsius: r1(tw.p.temp!.c) };
  const wv = nearestWith(points, lat, lon, 'wave', WAVE_KM);
  if (wv) {
    const w = wv.p.wave!;
    out.waves = { ...reading(wv, w.time), heightM: r1(w.hs), directionDeg: w.dir !== undefined ? Math.round(w.dir) : undefined, periodS: w.per !== undefined ? r1(w.per) : undefined };
  }

  // forecast for the gauge that gave the sea level (FMI and Kartverket publish one)
  if (lv?.p.provider === 'FMI' && lv.p.id) {
    const fc = await soft(cache.getOrFetch(`marine:fmi-fc:${lv.p.id}`, async () => parseFmiSeaLevel(await getText(
      `${WFS}fmi::forecast::sealevel::point::simple&fmisid=${lv.p.id}&parameters=SeaLevel&endtime=${iso(Date.now() + 36 * 3600000)}`, 'FMI open data')), OBS_TTL), []);
    const r = forecastRange(fc);
    if (r) out.forecast = { provider: 'FMI', station: lv.p.station, reference: REF.FMI, ...r };
  } else if (lv?.p.provider === 'Kartverket' && no) {
    const r = forecastRange(no.forecast);
    if (r) out.forecast = { provider: 'Kartverket', station: lv.p.station, reference: REF.Kartverket, ...r };
  }
  if (model) out.model = model;
  out.attribution = [...new Set([out.seaLevel, out.forecast, out.waterTemp, out.waves, out.model].filter((x) => !!x).map((x) => ATTRIBUTION[x!.provider]))];
  return out;
}
