import { safeError } from '../utils/errors.js';
import { cache } from '../cache.js';
import { getJson } from '../utils/http.js';
import { kmBetween } from '../utils/region.js';

/**
 * Finnish road weather from Fintraffic's Digitraffic (keyless, CC BY 4.0): about 500 road weather stations measuring
 * road surface temperature, surface state and friction, and Fintraffic's road condition forecast per road section
 * (now, 2, 4, 6 and 12 h). Digitraffic asks for a Digitraffic-User header and answers 406 without gzip.
 * Sweden (Trafikverket) and Norway (Statens vegvesen) need registered keys, so road weather covers Finland only.
 */
export const ROAD_ATTRIBUTION = 'Fintraffic / digitraffic.fi, CC BY 4.0';
const BASE = 'https://tie.digitraffic.fi/api/weather/v1';
const HEADERS = { 'Digitraffic-User': 'Koneisto/mcp-weather' };
const STATION_KM = 30, SECTION_KM = 10, MAX_AGE_MS = 3600000, DATA_TTL = 5 * 60000, STATIONS_TTL = 24 * 3600000;

export interface RoadStation {
  id: number; name: string; road?: number; distanceKm: number; measuredTime: string;
  airTemp?: number; roadTemp?: number; dewPoint?: number; freezingPoint?: number; humidity?: number;
  windSpeed?: number; windGusts?: number; windDirection?: number; precipitationRate?: number; visibilityKm?: number; friction?: number;
  surface?: string; precipitation?: string; warning?: string;
  /** derived: road surface at or below 0 °C and not warmer than the dew point */
  frostRisk: boolean;
}
export type RoadCondition = 'normal' | 'poor' | 'very poor' | 'unknown';
export interface RoadForecastStep { step: string; time: string; condition: RoadCondition; roads: number[]; reasons: string[] }

type StationsGeo = { features: Array<{ id: number; geometry: { coordinates: number[] }; properties: { name: string; collectionStatus?: string } }> };
type StationData = { id: number; dataUpdatedTime?: string; sensorValues: Array<{ name: string; value: number; measuredTime?: string; sensorValueDescriptionEn?: string }> };
type Forecasts = { forecastSections: Array<{ id: string; forecasts: Array<{ time: string; forecastName: string; overallRoadCondition?: string; forecastConditionReason?: Record<string, string> }> }> };

/** "vt1_Espoo_Nupuri" → name "Espoo Nupuri", road 1 (vt/kt/st/mt = main, trunk, regional and connecting roads). */
export function stationName(raw: string): { name: string; road?: number } {
  const m = /^(?:vt|kt|st|mt|yt)(\d+)_(.+)$/i.exec(raw);
  return m ? { name: m[2].replace(/_/g, ' '), road: Number(m[1]) } : { name: raw.replace(/_/g, ' ') };
}

// Road surface state codes (KELI_1, KELI_2 and the optical sensor); 0 = the sensor has a fault
const SURFACE = ['', 'Dry', 'Moist', 'Wet', 'Wet and salty', 'Frost', 'Snow', 'Ice', 'Probably moist and salty', 'Slushy'];
/** Surface state from the first working sensor: the two road sensors, then the optical one. */
function surfaceState(v: (k: string) => number | undefined): string | undefined {
  for (const k of ['KELI_1', 'KELI_2', 'OPTISEN_ANTURIN_KELI1']) { const x = v(k); if (x !== undefined && SURFACE[x]) return SURFACE[x]; }
  return undefined;
}

/** Digitraffic sensor values → road station reading. */
export function parseRoadStation(d: StationData, meta: { name: string; distanceKm: number }): RoadStation | null {
  const by = new Map(d.sensorValues.map((s) => [s.name, s]));
  const v = (k: string) => { const x = by.get(k)?.value; return typeof x === 'number' && Number.isFinite(x) ? x : undefined; };
  const desc = (k: string) => by.get(k)?.sensorValueDescriptionEn;
  const time = by.get('ILMA')?.measuredTime ?? by.get('TIE_1')?.measuredTime ?? d.dataUpdatedTime;
  if (!time || (v('ILMA') === undefined && v('TIE_1') === undefined)) return null;
  const roadTemp = v('TIE_1') ?? v('TIE_2'), dewPoint = v('KASTEPISTE');
  const { name, road } = stationName(meta.name);
  return {
    id: d.id, name, road, distanceKm: meta.distanceKm, measuredTime: time,
    airTemp: v('ILMA'), roadTemp, dewPoint, freezingPoint: v('JÄÄTYMISPISTE_1'), humidity: v('ILMAN_KOSTEUS'),
    windSpeed: v('KESKITUULI'), windGusts: v('MAKSIMITUULI'), windDirection: v('TUULENSUUNTA'),
    precipitationRate: v('SADE_INTENSITEETTI'), visibilityKm: v('NÄKYVYYS_KM'), friction: v('KITKA1'),
    surface: surfaceState(v), precipitation: desc('SADE') ?? desc('SATEEN_OLOMUOTO_PWDXX'), warning: desc('VAROITUS_1'),
    frostRisk: roadTemp !== undefined && dewPoint !== undefined && roadTemp <= 0 && roadTemp <= dewPoint,
  };
}

const CONDITION: Record<string, RoadCondition> = {
  NORMAL_CONDITION: 'normal', POOR_CONDITION: 'poor', EXTREMELY_POOR_CONDITION: 'very poor', CONDITION_COULD_NOT_BE_RESOLVED: 'unknown',
};
const RANK: Record<RoadCondition, number> = { unknown: 0, normal: 1, poor: 2, 'very poor': 3 };
// reasons that only restate a normal state are left out
const NORMAL_REASON = /^(NORMAL|NO_|DRY)/;

/** Worst forecast condition per step (0h, 2h, 4h, 6h, 12h) over the road sections, with the roads and reasons behind it. */
export function summarizeForecast(f: Forecasts): RoadForecastStep[] {
  const steps = new Map<string, RoadForecastStep>();
  for (const sec of f.forecastSections ?? []) {
    const road = Number(sec.id.split('_')[0]);
    for (const x of sec.forecasts) {
      const c = CONDITION[x.overallRoadCondition ?? ''] ?? 'unknown';
      let s = steps.get(x.forecastName);
      if (!s || RANK[c] > RANK[s.condition]) { s = { step: x.forecastName, time: x.time, condition: c, roads: [], reasons: [] }; steps.set(x.forecastName, s); }
      if (c !== s.condition || c === 'normal' || c === 'unknown') continue;
      if (!s.roads.includes(road)) s.roads.push(road);
      for (const r of Object.values(x.forecastConditionReason ?? {})) {
        const word = r.toLowerCase().replace(/_/g, ' ');
        if (!NORMAL_REASON.test(r) && !s.reasons.includes(word)) s.reasons.push(word);
      }
    }
  }
  const order = (s: string) => parseInt(s, 10);
  return [...steps.values()].sort((a, b) => order(a.step) - order(b.step)).map((s) => ({ ...s, roads: s.roads.sort((a, b) => a - b) }));
}

let lastCallTime: string | undefined, lastCallOk: boolean | undefined, lastError: string | undefined;
export function getRoadWeatherStatus() {
  return { name: 'Road weather (Fintraffic Digitraffic)', configured: true, available: true, lastCallTime, lastCallOk, lastError };
}

/** Nearest road weather station with fresh data within 30 km, and the road condition forecast for sections within 10 km. */
export async function fetchRoadWeather(lat: number, lon: number): Promise<{ station: RoadStation | null; forecast: RoadForecastStep[]; sections: number }> {
  try {
    const all = await cache.getOrFetch('road:stations', () => getJson<StationsGeo>(`${BASE}/stations`, 'Digitraffic', HEADERS), STATIONS_TTL);
    const near = all.features.filter((f) => f.properties.collectionStatus === 'GATHERING')
      .map((f) => ({ f, d: kmBetween(lat, lon, f.geometry.coordinates[1], f.geometry.coordinates[0]) }))
      .filter((x) => x.d <= STATION_KM).sort((a, b) => a.d - b.d).slice(0, 3);
    const dLat = SECTION_KM / 111, dLon = SECTION_KM / (111 * Math.cos(lat * Math.PI / 180));
    const box = `xMin=${(lon - dLon).toFixed(3)}&yMin=${(lat - dLat).toFixed(3)}&xMax=${(lon + dLon).toFixed(3)}&yMax=${(lat + dLat).toFixed(3)}`;
    const [datas, fc] = await Promise.all([
      Promise.all(near.map((x) => cache.getOrFetch(`road:data:${x.f.id}`, () => getJson<StationData>(`${BASE}/stations/${x.f.id}/data`, 'Digitraffic', HEADERS), DATA_TTL).catch(() => null))),
      cache.getOrFetch(`road:fc:${box}`, () => getJson<Forecasts>(`${BASE}/forecast-sections/forecasts?${box}`, 'Digitraffic', HEADERS), DATA_TTL)
        .catch(() => ({ forecastSections: [] }) as Forecasts),
    ]);
    // nearest station whose data is fresh (stations under repair keep their last values)
    let station: RoadStation | null = null;
    for (let i = 0; i < near.length && !station; i++) {
      const d = datas[i];
      const r = d ? parseRoadStation(d, { name: near[i].f.properties.name, distanceKm: Math.round(near[i].d * 10) / 10 }) : null;
      if (r && Date.now() - Date.parse(r.measuredTime) <= MAX_AGE_MS) station = r;
    }
    lastCallTime = new Date().toISOString(); lastCallOk = true;
    return { station, forecast: summarizeForecast(fc), sections: fc.forecastSections?.length ?? 0 };
  } catch (err) {
    lastCallTime = new Date().toISOString(); lastCallOk = false; lastError = safeError(err instanceof Error ? err.message : err);
    throw err;
  }
}
