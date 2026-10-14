import { BORDERS } from '../data/nordic-borders.js';

/** Nordic and Baltic countries handled with national sources. */
export type NordicCountry = 'FI' | 'SE' | 'NO' | 'DK' | 'IS' | 'EE' | 'LV' | 'LT';

export const COUNTRY_NAME: Record<NordicCountry, string> = {
  FI: 'Finland', SE: 'Sweden', NO: 'Norway', DK: 'Denmark', IS: 'Iceland', EE: 'Estonia', LV: 'Latvia', LT: 'Lithuania',
};

export const COUNTRY_TZ: Record<NordicCountry, string> = {
  FI: 'Europe/Helsinki', SE: 'Europe/Stockholm', NO: 'Europe/Oslo', DK: 'Europe/Copenhagen', IS: 'Atlantic/Reykjavik',
  EE: 'Europe/Tallinn', LV: 'Europe/Riga', LT: 'Europe/Vilnius',
};

const COAST_KM = 25;   // a point at sea this close to a country's outline belongs to it (outlines are simplified)

function inRing(lat: number, lon: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function kmBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180, x = (lon2 - lon1) * r * Math.cos(((lat1 + lat2) / 2) * r), y = (lat2 - lat1) * r;
  return Math.hypot(x, y) * 6371;
}

/** Distance (km) from a point to a ring's segments (equirectangular, fine at these scales). */
function kmToRing(lat: number, lon: number, ring: number[][]): number {
  const k = Math.cos(lat * Math.PI / 180);
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0] * k, ay = ring[j][1], bx = ring[i][0] * k, by = ring[i][1], px = lon * k, py = lat;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * 111.2);
  }
  return best;
}

/** Nordic or Baltic country of a point (inside its outline, or at sea within 25 km of its coast), otherwise null. */
export function countryOf(lat: number, lon: number): NordicCountry | null {
  if (lat < 53 || lat > 82 || lon < -26 || lon > 35) return null;
  for (const [c, rings] of Object.entries(BORDERS)) if (rings.some((r) => inRing(lat, lon, r))) return c as NordicCountry;
  let best: { c: NordicCountry; km: number } | null = null;
  for (const [c, rings] of Object.entries(BORDERS)) {
    for (const r of rings) {
      const km = kmToRing(lat, lon, r);
      if (km <= COAST_KM && (!best || km < best.km)) best = { c: c as NordicCountry, km };
    }
  }
  return best ? best.c : null;
}

/** Country from a geocoder's country name ("Sweden", "Suomi"…), or null. */
export function countryFromName(name?: string): NordicCountry | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  const map: Record<string, NordicCountry> = {
    finland: 'FI', suomi: 'FI', sweden: 'SE', sverige: 'SE', ruotsi: 'SE', norway: 'NO', norge: 'NO', noreg: 'NO', norja: 'NO',
    denmark: 'DK', danmark: 'DK', tanska: 'DK', iceland: 'IS', ísland: 'IS', islanti: 'IS', estonia: 'EE', eesti: 'EE', viro: 'EE',
    latvia: 'LV', latvija: 'LV', lithuania: 'LT', lietuva: 'LT', liettua: 'LT', fi: 'FI', se: 'SE', no: 'NO', dk: 'DK', is: 'IS', ee: 'EE', lv: 'LV', lt: 'LT',
  };
  return map[n] ?? null;
}

/** Country for a resolved location: geocoder's country name first, then the point. */
export function countryOfLocation(loc: { lat: number; lon: number; country?: string }): NordicCountry | null {
  return countryFromName(loc.country) ?? countryOf(loc.lat, loc.lon);
}

/** Nordic and Baltic area including the seas between (for choosing the MET Nordic forecast model). */
export function inNordicArea(lat: number, lon: number): boolean {
  return countryOf(lat, lon) !== null || (lat >= 53.5 && lat <= 72 && lon >= -25 && lon <= 32);
}

export { kmBetween };
