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

export function aqiToCategory(aqi: number): string {
  if (aqi <= 50) return 'Good';
  if (aqi <= 100) return 'Moderate';
  if (aqi <= 150) return 'Unhealthy for Sensitive Groups';
  if (aqi <= 200) return 'Unhealthy';
  if (aqi <= 300) return 'Very Unhealthy';
  return 'Hazardous';
}
