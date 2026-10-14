import type { CurrentWeather, SourceResult } from '../types.js';
import { config } from '../config.js';
import { cache } from '../cache.js';
import { kmhToMs } from '../utils/units.js';

interface WttrResponse {
  current_condition: Array<{
    temp_C: string;
    FeelsLikeC: string;
    humidity: string;
    pressure: string;
    windspeedKmph: string;
    winddirDegree: string;
    windGustKmph?: string;
    cloudcover: string;
    visibility: string;
    uvIndex: string;
    precipMM: string;
    weatherDesc: Array<{ value: string }>;
    DewPointC?: string;
  }>;
}

const SOURCE = 'wttr.in';
let lastCallTime: string | undefined;
let lastCallOk: boolean | undefined;
let lastError: string | undefined;

export function getWttrStatus() {
  return { name: SOURCE, configured: true, available: true, lastCallTime, lastCallOk, lastError };
}

export async function fetchWttrCurrent(location: string): Promise<SourceResult<CurrentWeather>> {
  try {
    const data = await cache.getOrFetch<WttrResponse>(
      `wttr:current:${location}`,
      async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
        try {
          const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, {
            signal: controller.signal,
            headers: { 'User-Agent': 'mcp-weather-server/1.0' },
          });
          if (!res.ok) throw new Error(`wttr.in returned ${res.status}`);
          return await res.json() as WttrResponse;
        } finally {
          clearTimeout(timeout);
        }
      },
    );

    lastCallTime = new Date().toISOString();
    lastCallOk = true;

    const c = data.current_condition[0];
    return {
      ok: true,
      source: SOURCE,
      data: {
        temperature: parseFloat(c.temp_C),
        feelsLike: parseFloat(c.FeelsLikeC),
        humidity: parseFloat(c.humidity),
        pressure: parseFloat(c.pressure),
        windSpeed: kmhToMs(parseFloat(c.windspeedKmph)),
        windDirection: parseFloat(c.winddirDegree),
        windGusts: c.windGustKmph ? kmhToMs(parseFloat(c.windGustKmph)) : undefined,
        cloudCover: parseFloat(c.cloudcover),
        visibility: parseFloat(c.visibility) * 1000, // km to m
        uvIndex: parseFloat(c.uvIndex),
        precipitation: parseFloat(c.precipMM),
        weatherDescription: c.weatherDesc[0]?.value,
        dewPoint: c.DewPointC ? parseFloat(c.DewPointC) : undefined,
      },
    };
  } catch (err) {
    lastCallTime = new Date().toISOString();
    lastCallOk = false;
    lastError = String(err);
    return { ok: false, error: String(err), source: SOURCE };
  }
}
