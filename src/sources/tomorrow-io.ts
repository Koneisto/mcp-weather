import { safeError } from '../utils/errors.js';
import { httpGet } from '../utils/http.js';
import type { CurrentWeather, SourceResult } from '../types.js';
import { config } from '../config.js';
import { cache } from '../cache.js';

interface TomorrowResponse {
  data: {
    values: {
      temperature: number;
      temperatureApparent: number;
      humidity: number;
      pressureSurfaceLevel: number;
      pressureSeaLevel?: number;
      windSpeed: number;
      windDirection: number;
      windGust: number;
      cloudCover: number;
      visibility: number;
      uvIndex: number;
      precipitationIntensity: number;
      dewPoint: number;
      weatherCode: number;
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

/** Realtime call (the free tier returns no air quality fields: pollutants were never filled in from here). */
async function fetchRealtime(lat: number, lon: number): Promise<TomorrowResponse> {
  return cache.getOrFetch<TomorrowResponse>(
    `tomorrow:realtime:${lat},${lon}`,
    async () => {
      const params = new URLSearchParams({
        location: `${lat},${lon}`,
        apikey: config.tomorrowIoKey,
        units: 'metric',
      });
      const res = await httpGet(`https://api.tomorrow.io/v4/weather/realtime?${params}`);
      if (!res.ok) throw new Error(`Tomorrow.io returned ${res.status}`);
      return await res.json() as TomorrowResponse;
    },
    TOMORROW_CACHE_TTL_MS,
  );
}

export async function fetchTomorrowCurrent(lat: number, lon: number): Promise<SourceResult<CurrentWeather>> {
  if (!config.hasTomorrowIo) {
    return { ok: false, error: 'API key not configured', source: SOURCE };
  }

  try {
    const data = await fetchRealtime(lat, lon);

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
        pressure: v.pressureSeaLevel ?? v.pressureSurfaceLevel,   // sea level like the other sources
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
    lastError = safeError(err);
    return { ok: false, error: safeError(err), source: SOURCE };
  }
}
