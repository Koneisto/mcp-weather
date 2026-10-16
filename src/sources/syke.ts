import { cache } from '../cache.js';
import { getJson } from '../utils/http.js';
import { kmBetween } from '../utils/region.js';

/**
 * Finnish lakes and rivers from the Finnish Environment Institute (Syke) hydrology API (OData, keyless, CC BY 4.0):
 * daily water level (about 800 stations, with the gauge's offset to the N2000 height system), daily surface water
 * temperature (about 35 stations, open-water season) and ice thickness measured on the ice (about 50 stations, winter).
 * Values are daily, so "latest" means yesterday or today. The normal for a date is the mean of the same calendar day
 * over the previous 30 years, which the API answers directly with month() and day() filters.
 */
export const SYKE_ATTRIBUTION = 'Finnish Environment Institute (Syke), CC BY 4.0';
const BASE = 'https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.1/odata';
const LEVEL = 1, ICE = 9, TEMP = 11;          // Suure_Id: water level, ice thickness, surface water temperature
const N2000 = 5;                              // Korkeustaso_Id of N2000
const ICE_THICKNESS = 41, ICE_SNOW = 37, ICE_WEAK = 43;   // Lippu_Id on ice measurements
const DATA_TTL = 60 * 60000, STATIONS_TTL = 24 * 3600000, NORMAL_YEARS = 30;
const LEVEL_KM = 25, TEMP_KM = 50, ICE_KM = 50, SAME_LAKE_KM = 150;

export interface SykeStation { id: number; name: string; lake?: string; partOf?: string; lat: number; lon: number }
export interface LakeNormal { mean: number; min: number; max: number; years: number; fromYear: number; toYear: number }
export interface LakeLevel {
  station: string; lake?: string; partOf?: string; distanceKm?: number; date: string;
  cm: number; n2000M?: number; change7dCm?: number; normal?: LakeNormal; fromNormalCm?: number;
}
export interface LakeTemp { station: string; lake?: string; partOf?: string; distanceKm?: number; date: string; celsius: number; normal?: LakeNormal; fromNormalC?: number }
export interface LakeIce { station: string; lake?: string; partOf?: string; distanceKm?: number; date: string; thicknessCm?: number; snowCm?: number; weak: boolean }

type OData<T> = { value: T[]; 'odata.nextLink'?: string };
type PaikkaRow = { Paikka_Id: number; Nimi: string; JarviNimi: string | null; KoordLat: string | null; KoordLong: string | null };
type ValueRow = { Paikka_Id: number; Aika: string; Arvo: number | string | null; Lippu_Id?: number | null; Lippu_id?: number | null };

/** Syke coordinates are degrees, minutes and seconds as "DDMMSS" ("613001" = 61° 30′ 01″). */
export function dms(s: string | null): number {
  if (!s || !/^\d{6}$/.test(s)) return NaN;
  return Number(s.slice(0, 2)) + Number(s.slice(2, 4)) / 60 + Number(s.slice(4, 6)) / 3600;
}
const num = (v: unknown) => { const x = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN; return Number.isFinite(x) ? x : undefined; };
const r1 = (x: number) => Math.round(x * 10) / 10;

async function odataAll<T>(url: string): Promise<T[]> {
  const out: T[] = [];
  for (let next: string | undefined = url, pages = 0; next && pages < 10; pages++) {   // the API pages at 500 rows
    const d: OData<T> = await getJson<OData<T>>(next, 'Syke');
    out.push(...d.value);
    next = d['odata.nextLink'];
  }
  return out;
}
const q = (entity: string, filter: string, extra = '') => `${BASE}/${entity}?$filter=${encodeURIComponent(filter)}${extra}`;

/**
 * Syke's lake names carry notes: "Kallavesi (N60 81.70)", "Inarijärvi l. Anarjävri" (also called), "Haukivesi (Saimaa N60+75.80)".
 * The name is the part before them; a capitalised name in the brackets is the larger lake the basin belongs to.
 */
export function lakeName(raw: string | null): { lake?: string; partOf?: string } {
  if (!raw?.trim()) return {};
  const lake = raw.replace(/\s*\(.*$/, '').split(/\s+l\.\s+/)[0].trim();
  const partOf = /\(([A-ZÅÄÖ][a-zåäö-]+)/.exec(raw)?.[1];
  return { lake: lake || undefined, partOf };
}
export function toStations(rows: PaikkaRow[]): SykeStation[] {
  return rows.map((r) => ({ id: r.Paikka_Id, name: r.Nimi.trim(), ...lakeName(r.JarviNimi), lat: dms(r.KoordLat), lon: dms(r.KoordLong) }))
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
}
function stations(suure: number): Promise<SykeStation[]> {
  return cache.getOrFetch(`syke:stations:${suure}`, async () => toStations(await odataAll<PaikkaRow>(
    q('Paikka', `Suure_Id eq ${suure} and Tila_Id eq 1`, '&$select=Paikka_Id,Nimi,JarviNimi,KoordLat,KoordLong'))), STATIONS_TTL);
}

/**
 * Stations of a lake by name: the station name starts with it ("Saimaa, Lauritsala") or Syke files the station under it,
 * then the basins that belong to it ("Haukivesi (Saimaa …)"). A station filed under the lake but named after another
 * lake far from the lake's own stations is a filing error in the data ("Pyhävesi, Mäntyharju" under Kallavesi) and is left out.
 */
export function byLakeName(list: SykeStation[], query: string): SykeStation[] {
  const low = (x?: string) => x?.trim().toLocaleLowerCase('fi');
  const n = low(query);
  const prefix = (s: SykeStation) => low(s.name.split(',')[0]);
  const named = list.filter((s) => prefix(s) === n);
  const filed = list.filter((s) => prefix(s) !== n && low(s.lake) === n
    && (!named.length || named.some((a) => kmBetween(a.lat, a.lon, s.lat, s.lon) <= 50)));
  const basins = list.filter((s) => prefix(s) !== n && low(s.lake) !== n && low(s.partOf) === n);
  const byName = (a: SykeStation, b: SykeStation) => a.name.localeCompare(b.name, 'fi');
  return [...[...named, ...filed].sort(byName), ...basins.sort(byName)];
}
function nearest(list: SykeStation[], lat: number, lon: number, km: number): Array<SykeStation & { distanceKm: number }> {
  return list.map((s) => ({ ...s, distanceKm: Math.round(kmBetween(lat, lon, s.lat, s.lon) * 10) / 10 }))
    .filter((s) => s.distanceKm <= km).sort((a, b) => a.distanceKm - b.distanceKm);
}

/** Mean, lowest and highest of the same calendar day in earlier years. */
export function normalOf(rows: ValueRow[], fromYear: number, toYear: number): LakeNormal | undefined {
  const v = rows.filter((r) => { const y = Number(r.Aika.slice(0, 4)); return y >= fromYear && y <= toYear; })
    .map((r) => num(r.Arvo)).filter((x): x is number => x !== undefined);
  if (v.length < 5) return undefined;   // too few years for a normal
  return { mean: r1(v.reduce((a, b) => a + b, 0) / v.length), min: Math.min(...v), max: Math.max(...v), years: v.length, fromYear, toYear };
}

async function sameDayNormal(entity: string, id: number, date: string): Promise<LakeNormal | undefined> {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)), d = Number(date.slice(8, 10));
  const rows = await cache.getOrFetch(`syke:normal:${entity}:${id}:${m}-${d}`, () => odataAll<ValueRow>(
    q(entity, `Paikka_Id eq ${id} and month(Aika) eq ${m} and day(Aika) eq ${d} and year(Aika) ge ${y - NORMAL_YEARS}`, '&$select=Aika,Arvo')), STATIONS_TTL);
  return normalOf(rows, y - NORMAL_YEARS, y - 1);
}
const latest = (entity: string, id: number, top: number) => cache.getOrFetch(`syke:latest:${entity}:${id}:${top}`,
  () => getJson<OData<ValueRow>>(q(entity, `Paikka_Id eq ${id}`, `&$orderby=Aika desc&$top=${top}`), 'Syke').then((d) => d.value), DATA_TTL);

const LEVEL_MAX_AGE = 14 * 86400000, TEMP_MAX_AGE = 400 * 86400000;   // temperature: the last open-water season counts

async function level(s: SykeStation & { distanceKm?: number }): Promise<LakeLevel | null> {
  const rows = await latest('Vedenkorkeus', s.id, 8);
  const last = rows[0], cm = num(last?.Arvo);
  if (!last || cm === undefined || Date.now() - Date.parse(last.Aika + 'Z') > LEVEL_MAX_AGE) return null;   // station no longer reporting
  const date = last.Aika.slice(0, 10);
  const weekAgo = rows.find((r) => Date.parse(r.Aika) <= Date.parse(last.Aika) - 6.5 * 86400000);
  const [offsets, normal] = await Promise.all([
    cache.getOrFetch(`syke:offset:${s.id}`, () => getJson<OData<{ Korkeustaso_Id: number; Tasokorjaus: number }>>(
      q('VedenkTasoTieto', `Paikka_Id eq ${s.id}`), 'Syke').then((d) => d.value), STATIONS_TTL).catch(() => []),
    sameDayNormal('Vedenkorkeus', s.id, date).catch(() => undefined),
  ]);
  const off = offsets.find((o) => o.Korkeustaso_Id === N2000)?.Tasokorjaus;
  const w = num(weekAgo?.Arvo);
  return {
    station: s.name, lake: s.lake, partOf: s.partOf, distanceKm: s.distanceKm, date, cm,
    n2000M: off !== undefined ? Math.round(off + cm) / 100 : undefined,
    change7dCm: w !== undefined ? cm - w : undefined,
    normal, fromNormalCm: normal ? Math.round(cm - normal.mean) : undefined,
  };
}

async function temperature(s: SykeStation & { distanceKm?: number }): Promise<LakeTemp | null> {
  const [last] = await latest('LampoPintavesi', s.id, 1);
  const c = num(last?.Arvo);
  if (!last || c === undefined || Date.now() - Date.parse(last.Aika + 'Z') > TEMP_MAX_AGE) return null;
  const date = last.Aika.slice(0, 10);
  const normal = await sameDayNormal('LampoPintavesi', s.id, date).catch(() => undefined);
  return { station: s.name, lake: s.lake, partOf: s.partOf, distanceKm: s.distanceKm, date, celsius: c, normal, fromNormalC: normal ? r1(c - normal.mean) : undefined };
}

/** Latest ice measurement of a station: total thickness, snow on the ice, or "weak ice" (seen but too weak to measure). */
export function iceOf(rows: ValueRow[]): Omit<LakeIce, 'station' | 'lake' | 'partOf' | 'distanceKm'> | null {
  if (!rows.length) return null;
  const date = rows.map((r) => r.Aika).sort().pop()!;
  const day = rows.filter((r) => r.Aika === date);
  const flag = (id: number) => day.find((r) => (r.Lippu_Id ?? r.Lippu_id) === id);
  return { date: date.slice(0, 10), thicknessCm: num(flag(ICE_THICKNESS)?.Arvo), snowCm: num(flag(ICE_SNOW)?.Arvo), weak: !!flag(ICE_WEAK) };
}
async function ice(s: SykeStation & { distanceKm?: number }): Promise<(LakeIce & { current: boolean }) | null> {
  const x = iceOf(await latest('Jaanpaksuus', s.id, 6));
  if (!x) return null;
  // ice measurements stop when the ice goes; an old one says nothing about now, only that the station measures in winter
  return { station: s.name, lake: s.lake, partOf: s.partOf, distanceKm: s.distanceKm, ...x, current: Date.now() - Date.parse(x.date + 'T00:00:00Z') <= 45 * 86400000 };
}

let lastCallTime: string | undefined, lastCallOk: boolean | undefined, lastError: string | undefined;
export function getSykeStatus() {
  return { name: 'Syke (lakes and rivers)', configured: true, available: true, lastCallTime, lastCallOk, lastError };
}

export interface LakeConditions {
  matchedLake?: string; levels: LakeLevel[]; temperatures: LakeTemp[]; ice: LakeIce[];
  /** nearest ice station when it has no measurement from the last 45 days (open-water season) */
  iceIdle?: { station: string; distanceKm?: number; lastDate: string };
}

/** Lake stations by lake name ("Saimaa"), or when none match, the nearest stations to the point. */
export async function fetchLakeByName(name: string): Promise<LakeConditions | null> {
  const [lv, tw, ic] = await Promise.all([stations(LEVEL), stations(TEMP), stations(ICE)]);
  const L = byLakeName(lv, name), T = byLakeName(tw, name), I = byLakeName(ic, name);
  if (!L.length && !T.length) return null;
  const main = [...L, ...T].find((s) => s.lake && s.name.split(',')[0].trim().toLocaleLowerCase('fi') === s.lake.toLocaleLowerCase('fi'));
  return { matchedLake: main?.lake ?? name.trim(), ...await collect(L, T, I, { levels: 5, temps: 3, ice: 2 }) };
}
export async function fetchLakeNear(lat: number, lon: number): Promise<LakeConditions> {
  const [lv, tw, ic] = await Promise.all([stations(LEVEL), stations(TEMP), stations(ICE)]);
  // three candidates each: the nearest may have stopped reporting
  const first = await collect(nearest(lv, lat, lon, LEVEL_KM).slice(0, 3), [], [], { levels: 1, temps: 0, ice: 0 });
  // Water temperature: the lake of the water level station used (or a basin of it) describes the water at the point
  // better than a nearer different lake (at Ristiina: Saimaa at Lauritsala 70 km, not Kyyvesi 54 km). Ice is local, so
  // the nearest stations come first. The lake is taken from the station that answered, not the nearest one, which may
  // have stopped reporting.
  const used = first.levels[0], home = used?.partOf ?? used?.lake;
  const onHome = (list: SykeStation[]) => nearest(list.filter((s) => !!home && (s.lake === home || s.partOf === home)), lat, lon, SAME_LAKE_KM);
  const merge = <S extends { id: number }>(a: S[], b: S[]) => [...a, ...b.filter((s) => !a.some((x) => x.id === s.id))];
  const T = merge(onHome(tw), nearest(tw, lat, lon, TEMP_KM)).slice(0, 3);
  const I = merge(nearest(ic, lat, lon, ICE_KM).slice(0, 3), onHome(ic)).slice(0, 4);   // nearest first, then the same lake farther away
  return { ...await collect([], T, I, { levels: 0, temps: 1, ice: 1 }), levels: first.levels };
}
async function collect(L: SykeStation[], T: SykeStation[], I: SykeStation[], max: { levels: number; temps: number; ice: number }): Promise<LakeConditions> {
  try {
    // one station failing leaves the others in the answer
    let asked = 0, failed = 0;
    const each = <X>(list: SykeStation[], f: (s: SykeStation) => Promise<X | null>) =>
      Promise.all(list.map((s) => { asked++; return f(s).catch((e) => { failed++; lastError = String(e instanceof Error ? e.message : e); return null; }); }));
    const [levels, temperatures, ices] = await Promise.all([each(L.slice(0, 8), level), each(T.slice(0, 5), temperature), each(I.slice(0, 4), ice)]);
    if (asked && failed === asked) throw new Error(`Syke did not answer (${lastError})`);   // not "no station nearby"
    lastCallTime = new Date().toISOString(); lastCallOk = true;
    const ok = <X>(a: Array<X | null>, n: number) => a.filter((x): x is X => x !== null).slice(0, n);
    const iceAll = ok(ices, ices.length), current = iceAll.filter((x) => x.current).slice(0, max.ice).map(({ current: _, ...x }) => x);
    // a station counts as measuring in winter only if it measured last winter (Yövesi, Kissalahti last measured in 4/2024)
    const lastWinter = iceAll.find((x) => !x.current && Date.now() - Date.parse(x.date + 'T00:00:00Z') <= 300 * 86400000);
    const idle = !current.length && lastWinter ? { station: lastWinter.station, distanceKm: lastWinter.distanceKm, lastDate: lastWinter.date } : undefined;
    return { levels: ok(levels, max.levels), temperatures: ok(temperatures, max.temps), ice: current, iceIdle: idle };
  } catch (err) {
    lastCallTime = new Date().toISOString(); lastCallOk = false; lastError = String(err instanceof Error ? err.message : err);
    throw err;
  }
}
