import { cache } from '../cache.js';
import { getJson, getText } from '../utils/http.js';
import { metGet, MET_ATTRIBUTION } from './met-norway.js';
import type { NordicCountry } from '../utils/region.js';

/**
 * Official weather warnings in the Nordic and Baltic countries.
 * Located to the point: Finland (FMI CAP polygons), Sweden (SMHI impact-based warnings, GeoJSON) and Norway (MET Norway
 * MetAlerts by coordinates). Country level: Denmark, Iceland, Estonia, Latvia and Lithuania from MeteoAlarm, whose areas are
 * EMMA_ID codes without published outlines, so the warnings are listed with their area names.
 */
export type WarningLevel = 'yellow' | 'orange' | 'red' | 'info';
export type Lang = 'en' | 'fi' | 'sv' | 'no';

export interface Warning {
  event: string;
  level: WarningLevel;
  severity?: string;
  headline?: string;
  description?: string;
  instruction?: string;
  area: string;
  onset?: string;
  expires?: string;
}

export interface WarningsResult {
  coverage: 'point' | 'country';
  warnings: Warning[];
  source: string;
  attribution: string;
}

const TTL = 5 * 60000;
const ATTR = {
  FMI: 'Finnish Meteorological Institute, CC BY 4.0',
  SMHI: 'SMHI (Swedish Meteorological and Hydrological Institute), CC BY 4.0',
  METEOALARM: 'Data provided by EUMETNET members (MeteoAlarm), CC BY 4.0',
};
let lastCallTime: string | undefined, lastCallOk: boolean | undefined, lastError: string | undefined;
export function getWarningsStatus() {
  return { name: 'Weather warnings (FMI, SMHI, MET Norway, MeteoAlarm)', configured: true, available: true, lastCallTime, lastCallOk, lastError };
}

// ---------- geometry ----------
/** Point in polygon; ring as [x=lon, y=lat] pairs. */
export function inRing(lat: number, lon: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** GeoJSON Polygon / MultiPolygon (holes respected). */
function inGeoJson(lat: number, lon: number, g: { type: string; coordinates: unknown } | undefined): boolean {
  if (!g) return false;
  const polys = g.type === 'Polygon' ? [g.coordinates as number[][][]] : g.type === 'MultiPolygon' ? g.coordinates as number[][][][] : [];
  return polys.some((p) => p.length > 0 && inRing(lat, lon, p[0]) && !p.slice(1).some((hole) => inRing(lat, lon, hole)));
}

const levelOf = (severity?: string, awareness?: string): WarningLevel => {
  const a = (awareness ?? '').toLowerCase();
  if (a.includes('red')) return 'red';
  if (a.includes('orange')) return 'orange';
  if (a.includes('yellow')) return 'yellow';
  const s = (severity ?? '').toLowerCase();
  return s === 'extreme' ? 'red' : s === 'severe' ? 'orange' : s === 'moderate' ? 'yellow' : 'info';
};
const active = (w: Warning, now: number) => !w.expires || Date.parse(w.expires) > now;
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : undefined;
};
const decode = (s?: string) => s?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

// ---------- Finland: FMI CAP atom (one CAP alert per entry, inline, with polygons "lat,lon lat,lon …") ----------
export function parseFmiCap(atom: string, lat: number, lon: number, lang: Lang = 'en', now = Date.now()): Warning[] {
  const out: Warning[] = [];
  const want = lang === 'fi' ? 'fi' : lang === 'sv' ? 'sv' : 'en';
  for (const m of atom.matchAll(/<alert[\s>][\s\S]*?<\/alert>/g)) {
    const alert = m[0];
    if (tag(alert, 'status') !== 'Actual' || tag(alert, 'msgType') === 'Cancel') continue;
    // each alert carries the same warning in Finnish, Swedish and English: keep the requested language (first as fallback)
    const infos = [...alert.matchAll(/<info>[\s\S]*?<\/info>/g)].map((x) => x[0]);
    const chosen = infos.find((i) => (tag(i, 'language') ?? '').toLowerCase().startsWith(want)) ?? infos[0];
    for (const info of chosen ? [chosen] : []) {
      const areas = [...info.matchAll(/<area>[\s\S]*?<\/area>/g)].map((a) => a[0]);
      const hit = areas.filter((a) => [...a.matchAll(/<polygon>([\s\S]*?)<\/polygon>/g)].some((p) => {
        const ring = p[1].trim().split(/\s+/).map((pair) => pair.split(',').map(Number)).map(([la, lo]) => [lo, la]);
        return ring.length >= 3 && inRing(lat, lon, ring);
      }));
      if (!hit.length) continue;
      const awareness = [...info.matchAll(/<parameter>\s*<valueName>([^<]*)<\/valueName>\s*<value>([^<]*)<\/value>/g)]
        .find((p) => /awareness_level/i.test(p[1]))?.[2];
      const w: Warning = {
        event: decode(tag(info, 'event')) ?? 'Warning', severity: tag(info, 'severity'), level: levelOf(tag(info, 'severity'), awareness),
        headline: decode(tag(info, 'headline')), description: decode(tag(info, 'description')), instruction: decode(tag(info, 'instruction')),
        area: [...new Set(hit.map((a) => decode(tag(a, 'areaDesc'))).filter(Boolean))].join(', '),
        onset: tag(info, 'onset') ?? tag(info, 'effective'), expires: tag(info, 'expires'),
      };
      if (active(w, now)) out.push(w);
    }
  }
  return out;
}

async function fmi(lat: number, lon: number, lang: Lang): Promise<WarningsResult> {
  const feed = lang === 'fi' ? 'fi-FI' : lang === 'sv' ? 'sv-FI' : 'en-GB';
  const atom = await cache.getOrFetch(`warn:fmi:${feed}`, () => getText(`https://alerts.fmi.fi/cap/feed/atom_${feed}.xml`, 'FMI warnings'), TTL);
  return { coverage: 'point', warnings: parseFmiCap(atom, lat, lon, lang), source: 'FMI', attribution: ATTR.FMI };
}

// ---------- Sweden: SMHI impact-based warnings (warning areas with GeoJSON geometry) ----------
interface SmhiText { sv?: string; en?: string; code?: string }
interface SmhiWarning {
  event?: SmhiText;
  warningAreas?: Array<{ areaName?: SmhiText; warningLevel?: SmhiText; approximateStart?: string; approximateEnd?: string;
    eventDescription?: SmhiText; descriptions?: Array<{ title?: SmhiText; text?: SmhiText }>;
    area?: { type?: string; geometry?: { type: string; coordinates: unknown }; features?: Array<{ geometry?: { type: string; coordinates: unknown } }> } }>;
}
export function parseSmhi(list: SmhiWarning[], lat: number, lon: number, lang: Lang, now = Date.now()): Warning[] {
  const t = (x?: SmhiText) => (lang === 'sv' ? x?.sv : x?.en) ?? x?.sv ?? x?.en;
  const out: Warning[] = [];
  for (const w of list ?? []) {
    for (const a of w.warningAreas ?? []) {
      const geoms = a.area?.features ? a.area.features.map((f) => f.geometry) : [a.area?.geometry];
      if (!geoms.some((g) => inGeoJson(lat, lon, g))) continue;
      const code = (a.warningLevel?.code ?? '').toUpperCase();
      const item: Warning = {
        event: t(w.event) ?? 'Warning', level: code === 'RED' ? 'red' : code === 'ORANGE' ? 'orange' : code === 'YELLOW' ? 'yellow' : 'info',
        severity: t(a.warningLevel), headline: t(a.eventDescription),
        description: (a.descriptions ?? []).map((d) => t(d.text)).filter(Boolean).join(' ') || undefined,
        area: t(a.areaName) ?? '', onset: a.approximateStart, expires: a.approximateEnd,
      };
      if (active(item, now)) out.push(item);
    }
  }
  return out;
}

async function smhi(lat: number, lon: number, lang: Lang): Promise<WarningsResult> {
  const list = await cache.getOrFetch('warn:smhi', () => getJson<SmhiWarning[]>('https://opendata-download-warnings.smhi.se/ibww/api/version/1/warning.json', 'SMHI warnings'), TTL);
  return { coverage: 'point', warnings: parseSmhi(list, lat, lon, lang), source: 'SMHI', attribution: ATTR.SMHI };
}

// ---------- Norway: MET Norway MetAlerts by coordinates ----------
interface MetAlerts { features?: Array<{ properties: Record<string, string>; when?: { interval?: string[] } }> }
export function parseMetAlerts(d: MetAlerts, now = Date.now()): Warning[] {
  return (d.features ?? []).map((f) => {
    const p = f.properties;
    return {
      event: p.eventAwarenessName || p.event, level: levelOf(p.severity, p.awareness_level), severity: p.severity,
      headline: p.title, description: p.description, instruction: p.instruction, area: p.area ?? '',
      onset: f.when?.interval?.[0], expires: f.when?.interval?.[1],
    } as Warning;
  }).filter((w) => active(w, now));
}

async function metNorway(lat: number, lon: number, lang: Lang): Promise<WarningsResult> {
  const d = await metGet<MetAlerts>('metalerts/2.0/current.json', lat, lon, { lang: lang === 'no' ? 'no' : 'en' });
  return { coverage: 'point', warnings: parseMetAlerts(d), source: 'MET Norway', attribution: MET_ATTRIBUTION };
}

// ---------- Denmark, Iceland, Estonia, Latvia, Lithuania: MeteoAlarm country feed ----------
const FEED: Partial<Record<NordicCountry, string>> = { DK: 'denmark', IS: 'iceland', EE: 'estonia', LV: 'latvia', LT: 'lithuania', FI: 'finland', SE: 'sweden', NO: 'norway' };
interface MaInfo { language?: string; event?: string; severity?: string; headline?: string; description?: string; instruction?: string;
  onset?: string; effective?: string; expires?: string; area?: Array<{ areaDesc?: string }>; parameter?: Array<{ valueName?: string; value?: string }> }
interface MeteoAlarm { warnings?: Array<{ alert?: { status?: string; msgType?: string; info?: MaInfo[] } }> }
export function parseMeteoAlarm(d: MeteoAlarm, now = Date.now()): Warning[] {
  const seen = new Set<string>(), out: Warning[] = [];
  for (const x of d.warnings ?? []) {
    const a = x.alert;
    if (!a || a.status !== 'Actual' || a.msgType === 'Cancel') continue;
    const info = (a.info ?? []).find((i) => (i.language ?? '').toLowerCase().startsWith('en')) ?? a.info?.[0];
    if (!info) continue;
    // awareness level 1 / green / Minor = "no particular awareness" (e.g. DMI publishes these for all areas): not a warning
    const aw = info.parameter?.find((p) => /awareness_level/i.test(p.valueName ?? ''))?.value ?? '';
    if (/^\s*1\b|green/i.test(aw) || (!aw && info.severity === 'Minor')) continue;
    const w: Warning = {
      event: info.event ?? 'Warning', severity: info.severity,
      level: levelOf(info.severity, info.parameter?.find((p) => /awareness_level/i.test(p.valueName ?? ''))?.value),
      headline: info.headline, description: info.description, instruction: info.instruction,
      area: (info.area ?? []).map((r) => r.areaDesc).filter(Boolean).join(', '), onset: info.onset ?? info.effective, expires: info.expires,
    };
    const key = `${w.event}|${w.area}|${w.onset}|${w.level}`;
    if (active(w, now) && !seen.has(key)) { seen.add(key); out.push(w); }
  }
  return out;
}

async function meteoAlarm(country: NordicCountry): Promise<WarningsResult> {
  const d = await cache.getOrFetch(`warn:ma:${country}`, () => getJson<MeteoAlarm>(`https://feeds.meteoalarm.org/api/v1/warnings/feeds-${FEED[country]}`, 'MeteoAlarm'), TTL);
  return { coverage: 'country', warnings: parseMeteoAlarm(d), source: 'MeteoAlarm', attribution: ATTR.METEOALARM };
}

const ORDER: Record<WarningLevel, number> = { red: 0, orange: 1, yellow: 2, info: 3 };

/** Active warnings for a point in a Nordic or Baltic country, most severe first. */
export async function fetchWarnings(country: NordicCountry, lat: number, lon: number, lang: Lang): Promise<WarningsResult> {
  try {
    const r = country === 'FI' ? await fmi(lat, lon, lang) : country === 'SE' ? await smhi(lat, lon, lang)
      : country === 'NO' ? await metNorway(lat, lon, lang) : await meteoAlarm(country);
    r.warnings.sort((a, b) => ORDER[a.level] - ORDER[b.level] || (Date.parse(a.onset ?? '') || 0) - (Date.parse(b.onset ?? '') || 0));
    lastCallTime = new Date().toISOString(); lastCallOk = true;
    return r;
  } catch (err) {
    lastCallTime = new Date().toISOString(); lastCallOk = false; lastError = String(err);
    throw err;
  }
}
