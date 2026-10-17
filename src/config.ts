export interface Config {
  openWeatherMapKey: string;
  weatherApiKey: string;
  tomorrowIoKey: string;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  httpTimeoutMs: number;
  httpMaxResponseBytes: number;
  httpMaxConcurrent: number;
  httpMaxQueued: number;
  maxHttpRequests: number;
  cacheMaxInflight: number;
  hasOpenWeatherMap: boolean;
  hasWeatherApi: boolean;
  hasTomorrowIo: boolean;
}

function env(key: string, fallback: string = ''): string {
  return process.env[key]?.trim() ?? fallback;
}

function integer(key: string, fallback: number, min: number, max: number): number {
  const raw = env(key, String(fallback));
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(): Config {
  const openWeatherMapKey = env('OPENWEATHERMAP_API_KEY');
  const weatherApiKey = env('WEATHERAPI_KEY');
  const tomorrowIoKey = env('TOMORROW_IO_API_KEY');
  const cacheTtlMinutes = integer('CACHE_TTL_MINUTES', 60, 1, 10080);
  const cacheMaxEntries = integer('CACHE_MAX_ENTRIES', 200, 1, 10000);
  const httpTimeoutMs = integer('HTTP_TIMEOUT_MS', 10000, 10, 120000);

  return {
    openWeatherMapKey,
    weatherApiKey,
    tomorrowIoKey,
    cacheTtlMs: cacheTtlMinutes * 60 * 1000,
    cacheMaxEntries,
    httpTimeoutMs,
    httpMaxResponseBytes: integer('HTTP_MAX_RESPONSE_BYTES', 8 * 1024 * 1024, 1024, 32 * 1024 * 1024),
    httpMaxConcurrent: integer('HTTP_MAX_CONCURRENT', 8, 1, 64),
    httpMaxQueued: integer('HTTP_MAX_QUEUED', 64, 0, 256),
    maxHttpRequests: integer('MAX_HTTP_REQUESTS', 8, 1, 64),
    cacheMaxInflight: integer('CACHE_MAX_INFLIGHT', 64, 1, 512),
    hasOpenWeatherMap: openWeatherMapKey.length > 0,
    hasWeatherApi: weatherApiKey.length > 0,
    hasTomorrowIo: tomorrowIoKey.length > 0,
  };
}

export const config = loadConfig();
