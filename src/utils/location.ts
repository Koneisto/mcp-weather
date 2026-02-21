import type { ResolvedLocation } from '../types.js';
import { config } from '../config.js';
import { lookupFinnishLocation } from './finnish-locations.js';

export async function resolveLocation(input: string): Promise<ResolvedLocation> {
  const trimmed = input.trim();

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

  // 3. ICAO code (4-char uppercase)
  if (/^[A-Z]{4}$/.test(trimmed)) {
    return { lat: 0, lon: 0, name: trimmed, icao: trimmed };
  }

  // 4. Fallback: Open-Meteo geocoding
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(trimmed)}&count=1&language=en&format=json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Geocoding API returned ${res.status}`);
    }
    const data = await res.json() as { results?: Array<{ latitude: number; longitude: number; name: string; country?: string }> };
    if (!data.results || data.results.length === 0) {
      throw new Error(`Location "${trimmed}" not found`);
    }
    const r = data.results[0];
    return {
      lat: r.latitude,
      lon: r.longitude,
      name: r.name,
      country: r.country,
    };
  } finally {
    clearTimeout(timeout);
  }
}
