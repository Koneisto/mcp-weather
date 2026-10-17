import { config } from '../config.js';

/** Provider failures must never echo configured credentials into MCP output or source status. */
export function safeError(err: unknown): string {
  let text = String(err);
  for (const key of [config.openWeatherMapKey, config.weatherApiKey, config.tomorrowIoKey]) {
    if (key) for (const value of new Set([key, encodeURIComponent(key)])) text = text.split(value).join('[redacted]');
  }
  return text.replace(/([?&](?:key|apikey|appid|token)=)[^\s&"']+/gi, '$1[redacted]');
}
