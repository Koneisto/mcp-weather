import { config } from './config.js';

/**
 * Optional API keys: which sources they unlock, where to get a free key and how to set it.
 * The server works without any of them; this is used to tell the user once what is missing and how to add it
 * (server instructions, a one-time note on the first answer, and get_weather_source_status).
 */
export interface KeyInfo {
  source: string;
  env: string;
  signup: string;
  configured: boolean;
}

export const KEYS: KeyInfo[] = [
  { source: 'OpenWeatherMap', env: 'OPENWEATHERMAP_API_KEY', signup: 'https://home.openweathermap.org/users/sign_up', configured: config.hasOpenWeatherMap },
  { source: 'WeatherAPI', env: 'WEATHERAPI_KEY', signup: 'https://www.weatherapi.com/signup.aspx', configured: config.hasWeatherApi },
  { source: 'Tomorrow.io', env: 'TOMORROW_IO_API_KEY', signup: 'https://app.tomorrow.io/signup', configured: config.hasTomorrowIo },
];

export const HOW_TO_SET =
  'Docker: add KEY=value to the .env file next to docker-compose.yml and run `docker compose up -d`. ' +
  'Local (stdio): add the key to the "env" block of this server in the MCP client configuration and restart the client.';

export function missingKeys(): KeyInfo[] {
  return KEYS.filter((k) => !k.configured);
}

/** Text lines for get_weather_source_status: one block per missing key, then how to set keys. */
export function keyHelpLines(): string[] {
  const m = missingKeys();
  if (!m.length) return [];
  return [
    'Optional API keys (free tiers; the keyless sources keep working without them)',
    ...m.map((k) => `  ${k.env}: ${k.source}, free key at ${k.signup}`),
    `  How to set: ${HOW_TO_SET}`,
    '',
  ];
}

/** One-time note appended to the first successful answer of a process, or null when nothing is missing or notes are off. */
export function keyNote(): string | null {
  if (/^(0|false|no|off)$/i.test(process.env.MCP_WEATHER_KEY_NOTE ?? '')) return null;
  const m = missingKeys();
  if (!m.length) return null;
  return `Note: ${m.length} optional source${m.length === 1 ? ' is' : 's are'} off because no API key is set ` +
    `(${m.map((k) => k.source).join(', ')}). This answer uses the keyless sources. ` +
    'get_weather_source_status shows where to get free keys and how to set them.';
}

/** Server instructions for the client and model (sent in the initialize result). */
export function serverInstructions(profile: 'full' | 'compact' = 'full'): string {
  if (profile === 'compact') return 'Nordic/Baltic weather. Credit sources; preserve measurement times, freshness, units and safety cautions. fields selects top-level data; provenance and safety remain. Results are single JSON text objects. Missing measurement time means freshness unknown. Use full MCP endpoint for structured automation results.';
  const m = missingKeys();
  return 'Nordic and European weather: measured observations from the national weather services (FI, SE, DK, IS, EE, LT; ' +
    'MET Nordic analysis in NO), MET Norway\'s high-resolution MET Nordic forecast in the Nordic and Baltic countries, and official ' +
    'warnings. Tools: get_current_weather (now), get_weather_forecast (coming days; FMI\'s meteorologist forecast in Finland), get_precipitation_nowcast (rain or snow in the ' +
    'next 2 hours, radar), get_weather_warnings (official warnings in FI, SE, NO, DK, IS, EE, LV, LT), get_marine_conditions ' +
    '(sea level, water temperature, waves), get_lake_conditions (Finnish lakes: water level, temperature, ice), get_road_weather (driving conditions in Finland), get_air_quality (incl. pollen), ' +
    'get_aurora_forecast (northern lights), get_metar (airports by ICAO code), get_astronomy (sun and moon), ' +
    'get_weather_source_status (sources, cache and API keys). Locations can be place names in several languages, ' +
    'coordinates "lat,lon" or ICAO codes. Credit the data source named in each answer.' +
    (m.length
      ? ` Optional sources without an API key: ${m.map((k) => k.source).join(', ')}. If the user asks about more sources or ` +
        'missing data, get_weather_source_status explains where to get free keys and how to set them.'
      : '');
}
