import { z } from 'zod';
import type { tool } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { aggregateCurrentWeather } from '../utils/aggregator.js';
import { degreesToCardinal, formatNum, formatFixed } from '../utils/units.js';

const schema = {
  location: z.string().describe('City name, coordinates (lat,lon), or Finnish city alias (e.g. "Helsinki", "hki", "60.17,24.94")'),
};

export const currentWeatherTool: tool<typeof schema> = {
  name: 'get_current_weather',
  description: 'Get current weather conditions for a location. Aggregates multiple free weather sources for accuracy. Optimized for Nordic/Finnish locations with instant alias resolution.',
  schema,
  handler: async (args) => {
    try {
      const loc = await resolveLocation(args.location);
      const { weather: w, sources, summary } = await aggregateCurrentWeather(loc);

      const lines: string[] = [summary, ''];

      if (w.temperature !== undefined) lines.push(`Temperature: ${formatNum(w.temperature)} °C`);
      if (w.feelsLike !== undefined) lines.push(`Feels like: ${formatNum(w.feelsLike)} °C`);
      if (w.weatherDescription) lines.push(`Conditions: ${w.weatherDescription}`);
      if (w.humidity !== undefined) lines.push(`Humidity: ${formatNum(w.humidity)} %`);
      if (w.pressure !== undefined) lines.push(`Pressure: ${formatNum(w.pressure)} hPa`);
      if (w.windSpeed !== undefined) {
        const dir = w.windDirection !== undefined ? ` ${degreesToCardinal(w.windDirection)} (${formatNum(w.windDirection)}°)` : '';
        lines.push(`Wind: ${formatNum(w.windSpeed)} m/s${dir}`);
      }
      if (w.windGusts !== undefined) lines.push(`Wind gusts: ${formatNum(w.windGusts)} m/s`);
      if (w.cloudCover !== undefined) lines.push(`Cloud cover: ${formatNum(w.cloudCover)} %`);
      if (w.visibility !== undefined) lines.push(`Visibility: ${formatFixed(w.visibility / 1000, 1)} km`);
      if (w.uvIndex !== undefined) lines.push(`UV index: ${formatNum(w.uvIndex)}`);
      if (w.precipitation !== undefined) lines.push(`Precipitation: ${formatNum(w.precipitation)} mm`);
      if (w.dewPoint !== undefined) lines.push(`Dew point: ${formatNum(w.dewPoint)} °C`);

      lines.push('');
      lines.push(`Location: ${loc.name}${loc.country ? ', ' + loc.country : ''} (${loc.lat}, ${loc.lon})`);
      lines.push(`Sources: ${sources.join(', ')}`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${String(err)}` }] };
    }
  },
};
