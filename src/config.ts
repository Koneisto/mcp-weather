export interface Config {
  openWeatherMapKey: string;
  weatherApiKey: string;
  tomorrowIoKey: string;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  httpTimeoutMs: number;
  hasOpenWeatherMap: boolean;
  hasWeatherApi: boolean;
  hasTomorrowIo: boolean;
}

function env(key: string, fallback: string = ''): string {
  return process.env[key]?.trim() ?? fallback;
}

export function loadConfig(): Config {
  const openWeatherMapKey = env('OPENWEATHERMAP_API_KEY');
  const weatherApiKey = env('WEATHERAPI_KEY');
  const tomorrowIoKey = env('TOMORROW_IO_API_KEY');
  const cacheTtlMinutes = parseInt(env('CACHE_TTL_MINUTES', '60'), 10);
  const cacheMaxEntries = parseInt(env('CACHE_MAX_ENTRIES', '200'), 10);
  const httpTimeoutMs = parseInt(env('HTTP_TIMEOUT_MS', '10000'), 10);

  return {
    openWeatherMapKey,
    weatherApiKey,
    tomorrowIoKey,
    cacheTtlMs: cacheTtlMinutes * 60 * 1000,
    cacheMaxEntries,
    httpTimeoutMs,
    hasOpenWeatherMap: openWeatherMapKey.length > 0,
    hasWeatherApi: weatherApiKey.length > 0,
    hasTomorrowIo: tomorrowIoKey.length > 0,
  };
}

export const config = loadConfig();
