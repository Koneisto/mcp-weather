import type { CurrentWeather, AstronomyData, SourceResult } from '../types.js';
import { config } from '../config.js';
import { cache } from '../cache.js';
import { kmhToMs, to24h } from '../utils/units.js';

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

interface WeatherApiAstronomyResponse {
  astronomy: {
    astro: {
      sunrise: string;
      sunset: string;
      moonrise: string;
      moonset: string;
      moon_phase: string;
      moon_illumination: string;
    };
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
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
        try {
          const res = await fetch(`https://api.weatherapi.com/v1/current.json?${params}`, { signal: controller.signal });
          if (!res.ok) throw new Error(`WeatherAPI returned ${res.status}`);
          return await res.json() as WeatherApiCurrentResponse;
        } finally {
          clearTimeout(timeout);
        }
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
    lastError = String(err);
    return { ok: false, error: String(err), source: SOURCE };
  }
}

export async function fetchWeatherApiAstronomy(lat: number, lon: number, date: string): Promise<SourceResult<AstronomyData>> {
  if (!config.hasWeatherApi) {
    return { ok: false, error: 'API key not configured', source: SOURCE };
  }

  try {
    const data = await cache.getOrFetch<WeatherApiAstronomyResponse>(
      `weatherapi:astro:${lat},${lon}:${date}`,
      async () => {
        const params = new URLSearchParams({
          key: config.weatherApiKey,
          q: `${lat},${lon}`,
          dt: date,
        });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
        try {
          const res = await fetch(`https://api.weatherapi.com/v1/astronomy.json?${params}`, { signal: controller.signal });
          if (!res.ok) throw new Error(`WeatherAPI astronomy returned ${res.status}`);
          return await res.json() as WeatherApiAstronomyResponse;
        } finally {
          clearTimeout(timeout);
        }
      },
    );

    lastCallTime = new Date().toISOString();
    lastCallOk = true;

    const a = data.astronomy.astro;
    return {
      ok: true,
      source: SOURCE,
      data: {
        sunrise: a.sunrise,
        sunset: a.sunset,
        moonrise: to24h(a.moonrise),
        moonset: to24h(a.moonset),
        moonPhase: a.moon_phase,
        moonIllumination: parseInt(a.moon_illumination, 10),
      },
    };
  } catch (err) {
    lastCallTime = new Date().toISOString();
    lastCallOk = false;
    lastError = String(err);
    return { ok: false, error: String(err), source: SOURCE };
  }
}
