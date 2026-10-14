import type { ResolvedLocation } from '../types.js';
import { config } from '../config.js';
import { lookupFinnishLocation } from './finnish-locations.js';
import { finnishAirports } from './finnish-airports.js';
import { cache } from '../cache.js';

const STATION_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;   // airport positions do not change

export async function resolveLocation(input: string): Promise<ResolvedLocation> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Location is required');

  // 1. Finnish/Nordic alias map
  const alias = lookupFinnishLocation(trimmed);
  if (alias) {
    return {
      lat: alias.lat,
      lon: alias.lon,
      name: alias.displayName,
      icao: alias.icao,
    };
  }

  // 2. Coordinate format: "60.17,24.94" or "60.17 24.94"
  const coordMatch = trimmed.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]);
    const lon = parseFloat(coordMatch[2]);
    return { lat, lon, name: `${lat.toFixed(2)},${lon.toFixed(2)}` };
  }

  // 3. ICAO code: Finnish airports from the local table, others from aviationweather.gov station info.
  // Before 10/2026 an ICAO code resolved to 0,0 (Gulf of Guinea) for every tool except get_metar.
  // A 4-letter word that is not an ICAO code (e.g. "Roma") falls through to geocoding.
  if (/^[A-Za-z]{4}$/.test(trimmed)) {
    const icao = trimmed.toUpperCase();
    const fi = finnishAirports[icao];
    if (fi) return { lat: fi.lat, lon: fi.lon, name: `${fi.name} (${icao})`, country: 'Finland', icao };
    const st = await lookupIcaoStation(icao).catch(() => null);
    if (st) return st;
  }

  // 4. Fallback: Open-Meteo geocoding
  return geocode(trimmed);
}

/** Airport position from aviationweather.gov (HTTP 204 = unknown station → null). */
async function lookupIcaoStation(icao: string): Promise<ResolvedLocation | null> {
  return cache.getOrFetch<ResolvedLocation | null>(`station:${icao}`, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
    try {
      const res = await fetch(`https://aviationweather.gov/api/data/stationinfo?ids=${icao}&format=json`, { signal: controller.signal });
      if (!res.ok) throw new Error(`Station info returned ${res.status}`);
      const body = await res.text();
      const list = body.trim() ? JSON.parse(body) as Array<{ icaoId: string; site: string; lat: number; lon: number; country?: string }> : [];
      const s = list.find((x) => x.icaoId === icao);
      const country = (s?.country && regionName?.of(s.country.toUpperCase())) || s?.country;   // "SE" → "Sweden"
      return s ? { lat: s.lat, lon: s.lon, name: `${s.site} (${icao})`, country, icao } : null;
    } finally {
      clearTimeout(timeout);
    }
  }, STATION_CACHE_TTL_MS);
}

// Open-Meteo matches names only in the requested language: "Roma" in English found Roma, Romania (pop. 3 000),
// and Finnish exonyms ("Lontoo", "Rooma") were not found at all. Search several languages in parallel and pick the
// best exact name match: capital > admin centre > other place, then population.
const GEOCODE_LANGUAGES = ['en', 'fi', 'sv', 'de', 'fr', 'it', 'es'];
const GEOCODE_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const FEATURE_RANK: Record<string, number> = { PPLC: 4, PPLA: 3, PPLA2: 2 };

interface GeoResult { id: number; latitude: number; longitude: number; name: string; country?: string; country_code?: string; feature_code?: string; population?: number }

const norm = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const regionName = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();

export function pickGeocodeResult(query: string, results: GeoResult[]): GeoResult | undefined {
  const q = norm(query);
  const exact = results.filter((r) => norm(r.name) === q);
  const pool = exact.length ? exact : results;
  const score = (r: GeoResult) => (FEATURE_RANK[r.feature_code ?? ''] ?? (r.feature_code?.startsWith('PPL') ? 1 : 0)) * 1e9 + (r.population ?? 0);
  return [...pool].sort((a, b) => score(b) - score(a))[0];
}

async function geocode(query: string): Promise<ResolvedLocation> {
  const r = await cache.getOrFetch<GeoResult | null>(`geocode:${norm(query)}`, async () => {
    const lists = await Promise.all(GEOCODE_LANGUAGES.map(async (lang) => {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=10&language=${lang}&format=json`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`Geocoding API returned ${res.status}`);
        const data = await res.json() as { results?: GeoResult[] };
        return data.results ?? [];
      } finally {
        clearTimeout(timeout);
      }
    }).map((p) => p.catch(() => null)));
    if (lists.every((l) => l === null)) throw new Error('Geocoding API unavailable');
    // English first, so an equally ranked place keeps its English name
    const seen = new Set<number>(), all: GeoResult[] = [];
    for (const l of lists) for (const x of l ?? []) if (!seen.has(x.id)) { seen.add(x.id); all.push(x); }
    return pickGeocodeResult(query, all) ?? null;
  }, GEOCODE_CACHE_TTL_MS);
  if (!r) throw new Error(`Location "${query}" not found`);
  const country = (r.country_code && regionName?.of(r.country_code.toUpperCase())) || r.country;
  return { lat: r.latitude, lon: r.longitude, name: r.name, country };
}
