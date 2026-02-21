import type { CurrentWeather, AirQualityData, SourceResult } from '../types.js';
import { config } from '../config.js';
import { cache } from '../cache.js';

interface TomorrowResponse {
  data: {
    values: {
      temperature: number;
      temperatureApparent: number;
      humidity: number;
      pressureSurfaceLevel: number;
      windSpeed: number;
      windDirection: number;
      windGust: number;
      cloudCover: number;
      visibility: number;
      uvIndex: number;
      precipitationIntensity: number;
      dewPoint: number;
      weatherCode: number;
      particulateMatter25?: number;
      particulateMatter10?: number;
      epaIndex?: number;
    };
  };
}

const SOURCE = 'Tomorrow.io';
const TOMORROW_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (limited free calls)
let lastCallTime: string | undefined;
let lastCallOk: boolean | undefined;
let lastError: string | undefined;

export function getTomorrowStatus() {
  return {
    name: SOURCE,
    configured: config.hasTomorrowIo,
    available: config.hasTomorrowIo,
    lastCallTime,
    lastCallOk,
    lastError,
  };
}

const tomorrowWeatherCodes: Record<number, string> = {
  1000: 'Clear',
  1100: 'Mostly Clear',
  1101: 'Partly Cloudy',
  1102: 'Mostly Cloudy',
  1001: 'Cloudy',
  2000: 'Fog',
  2100: 'Light Fog',
  4000: 'Drizzle',
  4001: 'Rain',
  4200: 'Light Rain',
  4201: 'Heavy Rain',
  5000: 'Snow',
  5001: 'Flurries',
  5100: 'Light Snow',
  5101: 'Heavy Snow',
  6000: 'Freezing Drizzle',
  6001: 'Freezing Rain',
  6200: 'Light Freezing Rain',
  6201: 'Heavy Freezing Rain',
  7000: 'Ice Pellets',
  7101: 'Heavy Ice Pellets',
  7102: 'Light Ice Pellets',
  8000: 'Thunderstorm',
};

export async function fetchTomorrowCurrent(lat: number, lon: number): Promise<SourceResult<CurrentWeather>> {
  if (!config.hasTomorrowIo) {
    return { ok: false, error: 'API key not configured', source: SOURCE };
  }

  try {
    const data = await cache.getOrFetch<TomorrowResponse>(
      `tomorrow:current:${lat},${lon}`,
      async () => {
        const params = new URLSearchParams({
          location: `${lat},${lon}`,
          apikey: config.tomorrowIoKey,
          units: 'metric',
        });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
        try {
          const res = await fetch(`https://api.tomorrow.io/v4/weather/realtime?${params}`, { signal: controller.signal });
          if (!res.ok) throw new Error(`Tomorrow.io returned ${res.status}`);
          return await res.json() as TomorrowResponse;
        } finally {
          clearTimeout(timeout);
        }
      },
      TOMORROW_CACHE_TTL_MS,
    );

    lastCallTime = new Date().toISOString();
    lastCallOk = true;

    const v = data.data.values;
    return {
      ok: true,
      source: SOURCE,
      data: {
        temperature: v.temperature,
        feelsLike: v.temperatureApparent,
        humidity: v.humidity,
        pressure: v.pressureSurfaceLevel,
        windSpeed: v.windSpeed,
        windDirection: v.windDirection,
        windGusts: v.windGust,
        cloudCover: v.cloudCover,
        visibility: v.visibility * 1000,
        uvIndex: v.uvIndex,
        precipitation: v.precipitationIntensity,
        dewPoint: v.dewPoint,
        weatherDescription: tomorrowWeatherCodes[v.weatherCode] ?? `Code ${v.weatherCode}`,
      },
    };
  } catch (err) {
    lastCallTime = new Date().toISOString();
    lastCallOk = false;
    lastError = String(err);
    return { ok: false, error: String(err), source: SOURCE };
  }
}

export async function fetchTomorrowAirQuality(lat: number, lon: number): Promise<SourceResult<AirQualityData>> {
  if (!config.hasTomorrowIo) {
    return { ok: false, error: 'API key not configured', source: SOURCE };
  }

  try {
    const data = await cache.getOrFetch<TomorrowResponse>(
      `tomorrow:aqi:${lat},${lon}`,
      async () => {
        const params = new URLSearchParams({
          location: `${lat},${lon}`,
          apikey: config.tomorrowIoKey,
          units: 'metric',
        });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
        try {
          const res = await fetch(`https://api.tomorrow.io/v4/weather/realtime?${params}`, { signal: controller.signal });
          if (!res.ok) throw new Error(`Tomorrow.io AQ returned ${res.status}`);
          return await res.json() as TomorrowResponse;
        } finally {
          clearTimeout(timeout);
        }
      },
      TOMORROW_CACHE_TTL_MS,
    );

    lastCallTime = new Date().toISOString();
    lastCallOk = true;

    const v = data.data.values;
    return {
      ok: true,
      source: SOURCE,
      data: {
        pm25: v.particulateMatter25,
        pm10: v.particulateMatter10,
        aqi: v.epaIndex,
      },
    };
  } catch (err) {
    lastCallTime = new Date().toISOString();
    lastCallOk = false;
    lastError = String(err);
    return { ok: false, error: String(err), source: SOURCE };
  }
}
