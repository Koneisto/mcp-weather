/** Format number with Finnish decimal comma: 2.3 → "2,3" */
export function formatNum(value: number): string {
  return String(value).replace('.', ',');
}

/** Format number with fixed decimals and Finnish comma: (1.5, 1) → "1,5" */
export function formatFixed(value: number, decimals: number): string {
  return value.toFixed(decimals).replace('.', ',');
}

/** Convert 12h time string to 24h: "08:06 AM" → "08:06", "01:30 PM" → "13:30" */
export function to24h(time: string): string {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return time;
  let hours = parseInt(match[1], 10);
  const minutes = match[2];
  const period = match[3].toUpperCase();
  if (period === 'AM' && hours === 12) hours = 0;
  else if (period === 'PM' && hours !== 12) hours += 12;
  return `${String(hours).padStart(2, '0')}:${minutes}`;
}

/** ISO timestamp → 24h local time in Finland: "2026-10-14T17:10:00Z" → "20:10" */
export function formatLocalTime(iso: string, timeZone = 'Europe/Helsinki'): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
}

/** Readable error text: an aborted fetch is a timeout ("AbortError: This operation was aborted" before 10/2026). */
export function errorText(err: unknown, timeoutMs: number): string {
  return err instanceof Error && err.name === 'AbortError' ? `no response within ${Math.round(timeoutMs / 1000)} s` : String(err);
}

export function knotsToMs(knots: number): number {
  return Math.round(knots * 0.5144 * 10) / 10;
}

export function kmhToMs(kmh: number): number {
  return Math.round((kmh / 3.6) * 10) / 10;
}

export function mphToMs(mph: number): number {
  return Math.round(mph * 0.4470 * 10) / 10;
}

export function inHgToHpa(inHg: number): number {
  return Math.round(inHg * 33.8639 * 10) / 10;
}

export function fToC(f: number): number {
  return Math.round(((f - 32) * 5) / 9 * 10) / 10;
}

export function milesToKm(miles: number): number {
  return Math.round(miles * 1.60934 * 10) / 10;
}

export function degreesToCardinal(deg: number): string {
  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const index = Math.round(deg / 22.5) % 16;
  return directions[index];
}

// WMO Weather interpretation codes (WW)
const wmoDescriptions: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snowfall',
  73: 'Moderate snowfall',
  75: 'Heavy snowfall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

export function wmoCodeToDescription(code: number): string {
  return wmoDescriptions[code] ?? `Unknown (code ${code})`;
}

/**
 * European Air Quality Index category (the scale Open-Meteo's european_aqi uses: 0-20 good ... >100 extremely poor).
 * Before 10/2026 the US EPA scale (0-50 good) was applied, so e.g. 45 (moderate) was shown as "Good".
 */
export function aqiToCategory(aqi: number): string {
  if (aqi <= 20) return 'Good';
  if (aqi <= 40) return 'Fair';
  if (aqi <= 60) return 'Moderate';
  if (aqi <= 80) return 'Poor';
  if (aqi <= 100) return 'Very poor';
  return 'Extremely poor';
}

// Concentration band limits (µg/m³) per pollutant; band i maps linearly to index 20*i .. 20*(i+1) (Open-Meteo/EEA).
const AQI_BANDS: Record<'pm25' | 'pm10' | 'no2' | 'o3' | 'so2', number[]> = {
  pm25: [0, 10, 20, 25, 50, 75, 800],
  pm10: [0, 20, 40, 50, 100, 150, 1200],
  no2: [0, 40, 90, 120, 230, 340, 1000],
  o3: [0, 50, 100, 130, 240, 380, 800],
  so2: [0, 100, 200, 350, 500, 750, 1250],
};

/** European AQI from concentrations: maximum of the per-pollutant sub-indices (undefined if none given). */
export function europeanAqi(c: Partial<Record<keyof typeof AQI_BANDS, number>>): number | undefined {
  let max: number | undefined;
  for (const [k, bands] of Object.entries(AQI_BANDS) as Array<[keyof typeof AQI_BANDS, number[]]>) {
    const v = c[k];
    if (v === undefined || !Number.isFinite(v)) continue;
    let i = bands.findIndex((hi, j) => j > 0 && v <= hi) - 1;
    if (i < 0) i = bands.length - 2;
    const sub = 20 * i + (20 * (Math.min(v, bands[i + 1]) - bands[i])) / (bands[i + 1] - bands[i]);
    max = Math.max(max ?? 0, sub);
  }
  return max === undefined ? undefined : Math.round(max);
}
