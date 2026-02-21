import type { CurrentWeather, DailyForecast, AirQualityData, SourceResult } from '../types.js';
import { config } from '../config.js';
import { cache } from '../cache.js';
import { wmoCodeToDescription, aqiToCategory } from '../utils/units.js';

interface OpenMeteoCurrentResponse {
  current: {
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    surface_pressure: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    wind_gusts_10m: number;
    cloud_cover: number;
    weather_code: number;
    precipitation: number;
    dew_point_2m?: number;
    uv_index?: number;
  };
  daily?: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    weather_code: number[];
    precipitation_sum: number[];
    precipitation_probability_max?: number[];
    wind_speed_10m_max: number[];
    wind_direction_10m_dominant: number[];
    uv_index_max: number[];
    sunrise: string[];
    sunset: string[];
  };
}

interface OpenMeteoAQResponse {
  current: {
    european_aqi: number;
    pm2_5: number;
    pm10: number;
    nitrogen_dioxide: number;
    ozone: number;
    sulphur_dioxide: number;
    carbon_monoxide: number;
  };
}

const SOURCE = 'Open-Meteo';
let lastCallTime: string | undefined;
let lastCallOk: boolean | undefined;
let lastError: string | undefined;

export function getOpenMeteoStatus() {
  return { name: SOURCE, configured: true, available: true, lastCallTime, lastCallOk, lastError };
}

export async function fetchOpenMeteoCurrent(lat: number, lon: number): Promise<SourceResult<CurrentWeather>> {
  try {
    const data = await cache.getOrFetch<OpenMeteoCurrentResponse>(
      `openmeteo:current:${lat},${lon}`,
      async () => {
        const params = new URLSearchParams({
          latitude: String(lat),
          longitude: String(lon),
          current: 'temperature_2m,apparent_temperature,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,weather_code,precipitation,dew_point_2m',
          wind_speed_unit: 'ms',
          timezone: 'auto',
        });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
        try {
          const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: controller.signal });
          if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
          return await res.json() as OpenMeteoCurrentResponse;
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
        temperature: c.temperature_2m,
        feelsLike: c.apparent_temperature,
        humidity: c.relative_humidity_2m,
        pressure: c.surface_pressure,
        windSpeed: c.wind_speed_10m,
        windDirection: c.wind_direction_10m,
        windGusts: c.wind_gusts_10m,
        cloudCover: c.cloud_cover,
        weatherCode: c.weather_code,
        weatherDescription: wmoCodeToDescription(c.weather_code),
        precipitation: c.precipitation,
        dewPoint: c.dew_point_2m,
      },
    };
  } catch (err) {
    lastCallTime = new Date().toISOString();
    lastCallOk = false;
    lastError = String(err);
    return { ok: false, error: String(err), source: SOURCE };
  }
}

export async function fetchOpenMeteoForecast(lat: number, lon: number, days: number): Promise<SourceResult<DailyForecast[]>> {
  try {
    const data = await cache.getOrFetch<OpenMeteoCurrentResponse>(
      `openmeteo:forecast:${lat},${lon}:${days}`,
      async () => {
        const params = new URLSearchParams({
          latitude: String(lat),
          longitude: String(lon),
          daily: 'temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant,uv_index_max,sunrise,sunset',
          wind_speed_unit: 'ms',
          timezone: 'auto',
          forecast_days: String(days),
        });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
        try {
          const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: controller.signal });
          if (!res.ok) throw new Error(`Open-Meteo forecast returned ${res.status}`);
          return await res.json() as OpenMeteoCurrentResponse;
        } finally {
          clearTimeout(timeout);
        }
      },
    );

    if (!data.daily) {
      return { ok: false, error: 'No daily forecast data', source: SOURCE };
    }

    const forecasts: DailyForecast[] = data.daily.time.map((date, i) => ({
      date,
      tempMax: data.daily!.temperature_2m_max[i],
      tempMin: data.daily!.temperature_2m_min[i],
      weatherCode: data.daily!.weather_code[i],
      weatherDescription: wmoCodeToDescription(data.daily!.weather_code[i]),
      precipitationSum: data.daily!.precipitation_sum[i],
      precipitationProbability: data.daily!.precipitation_probability_max?.[i],
      windSpeedMax: data.daily!.wind_speed_10m_max[i],
      windDirection: data.daily!.wind_direction_10m_dominant[i],
      uvIndexMax: data.daily!.uv_index_max[i],
      sunrise: data.daily!.sunrise[i],
      sunset: data.daily!.sunset[i],
    }));

    return { ok: true, source: SOURCE, data: forecasts };
  } catch (err) {
    return { ok: false, error: String(err), source: SOURCE };
  }
}

export async function fetchOpenMeteoAirQuality(lat: number, lon: number): Promise<SourceResult<AirQualityData>> {
  try {
    const data = await cache.getOrFetch<OpenMeteoAQResponse>(
      `openmeteo:aqi:${lat},${lon}`,
      async () => {
        const params = new URLSearchParams({
          latitude: String(lat),
          longitude: String(lon),
          current: 'european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide,carbon_monoxide',
        });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs);
        try {
          const res = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`, { signal: controller.signal });
          if (!res.ok) throw new Error(`Open-Meteo AQ returned ${res.status}`);
          return await res.json() as OpenMeteoAQResponse;
        } finally {
          clearTimeout(timeout);
        }
      },
    );

    const c = data.current;
    return {
      ok: true,
      source: SOURCE,
      data: {
        aqi: c.european_aqi,
        aqiCategory: aqiToCategory(c.european_aqi),
        pm25: c.pm2_5,
        pm10: c.pm10,
        no2: c.nitrogen_dioxide,
        o3: c.ozone,
        so2: c.sulphur_dioxide,
        co: c.carbon_monoxide,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err), source: SOURCE };
  }
}
