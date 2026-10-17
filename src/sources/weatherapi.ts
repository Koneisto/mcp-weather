import { safeError } from '../utils/errors.js';
import { httpGet } from '../utils/http.js';
import type { CurrentWeather, SourceResult } from '../types.js';
import { config } from '../config.js';
import { cache } from '../cache.js';
import { kmhToMs } from '../utils/units.js';

interface WeatherApiCurrentResponse {
  current: {
    temp_c: number;
    feelslike_c: number;
    humidity: number;
    pressure_mb: number;
    wind_kph: number;
    wind_degree: number;
    gust_kph: number;
    cloud: number;
    vis_km: number;
    uv: number;
    precip_mm: number;
    dewpoint_c: number;
    condition: { text: string };
  };
}


const SOURCE = 'WeatherAPI';
let lastCallTime: string | undefined;
let lastCallOk: boolean | undefined;
let lastError: string | undefined;

export function getWeatherApiStatus() {
  return {
    name: SOURCE,
    configured: config.hasWeatherApi,
    available: config.hasWeatherApi,
    lastCallTime,
    lastCallOk,
    lastError,
  };
}

export async function fetchWeatherApiCurrent(lat: number, lon: number): Promise<SourceResult<CurrentWeather>> {
  if (!config.hasWeatherApi) {
    return { ok: false, error: 'API key not configured', source: SOURCE };
  }

  try {
    const data = await cache.getOrFetch<WeatherApiCurrentResponse>(
      `weatherapi:current:${lat},${lon}`,
      async () => {
        const params = new URLSearchParams({
          key: config.weatherApiKey,
          q: `${lat},${lon}`,
        });
        const res = await httpGet(`https://api.weatherapi.com/v1/current.json?${params}`);
        if (!res.ok) throw new Error(`WeatherAPI returned ${res.status}`);
        return await res.json() as WeatherApiCurrentResponse;
      },
    );

    lastCallTime = new Date().toISOString();
    lastCallOk = true;

    const c = data.current;
    return {
      ok: true,
      source: SOURCE,
      data: {
        temperature: c.temp_c,
        feelsLike: c.feelslike_c,
        humidity: c.humidity,
        pressure: c.pressure_mb,
        windSpeed: kmhToMs(c.wind_kph),
        windDirection: c.wind_degree,
        windGusts: kmhToMs(c.gust_kph),
        cloudCover: c.cloud,
        visibility: c.vis_km * 1000,
        uvIndex: c.uv,
        precipitation: c.precip_mm,
        dewPoint: c.dewpoint_c,
        weatherDescription: c.condition.text,
      },
    };
  } catch (err) {
    lastCallTime = new Date().toISOString();
    lastCallOk = false;
    lastError = safeError(err);
    return { ok: false, error: safeError(err), source: SOURCE };
  }
}
