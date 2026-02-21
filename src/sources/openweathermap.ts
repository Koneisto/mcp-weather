import type { CurrentWeather, SourceResult } from '../types.js';
import { config } from '../config.js';
import { cache } from '../cache.js';

interface OWMResponse {
  main: {
    temp: number;
    feels_like: number;
    humidity: number;
    pressure: number;
  };
  wind: {
    speed: number;
    deg: number;
    gust?: number;
  };
  clouds: { all: number };
  visibility: number;
  weather: Array<{ description: string }>;
}

const SOURCE = 'OpenWeatherMap';
let lastCallTime: string | undefined;
let lastCallOk: boolean | undefined;
let lastError: string | undefined;

export function getOWMStatus() {
  return {
    name: SOURCE,
    configured: config.hasOpenWeatherMap,
    available: config.hasOpenWeatherMap,
    lastCallTime,
    lastCallOk,
    lastError,
  };
}

export async function fetchOWMCurrent(lat: number, lon: number): Promise<SourceResult<CurrentWeather>> {
  if (!config.hasOpenWeatherMap) {
    return { ok: false, error: 'API key not configured', source: SOURCE };
  }

  try {
    const data = await cache.getOrFetch<OWMResponse>(
      `owm:current:${lat},${lon}`,
      async () => {
        const params = new URLSearchParams({
          lat: String(lat),
          lon: String(lon),
          appid: config.openWeatherMapKey,
          units: 'metric',
        });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
        try {
          const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?${params}`, { signal: controller.signal });
          if (!res.ok) throw new Error(`OWM returned ${res.status}`);
          return await res.json() as OWMResponse;
        } finally {
          clearTimeout(timeout);
        }
      },
    );

    lastCallTime = new Date().toISOString();
    lastCallOk = true;

    return {
      ok: true,
      source: SOURCE,
      data: {
        temperature: data.main.temp,
        feelsLike: data.main.feels_like,
        humidity: data.main.humidity,
        pressure: data.main.pressure,
        windSpeed: data.wind.speed,
        windDirection: data.wind.deg,
        windGusts: data.wind.gust,
        cloudCover: data.clouds.all,
        visibility: data.visibility,
        weatherDescription: data.weather[0]?.description,
      },
    };
  } catch (err) {
    lastCallTime = new Date().toISOString();
    lastCallOk = false;
    lastError = String(err);
    return { ok: false, error: String(err), source: SOURCE };
  }
}
