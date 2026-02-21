import { z } from 'zod';
import type { tool } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { aggregateCurrentWeather } from '../utils/aggregator.js';
import { degreesToCardinal } from '../utils/units.js';

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

      if (w.temperature !== undefined) lines.push(`Temperature: ${w.temperature}°C`);
      if (w.feelsLike !== undefined) lines.push(`Feels like: ${w.feelsLike}°C`);
      if (w.weatherDescription) lines.push(`Conditions: ${w.weatherDescription}`);
      if (w.humidity !== undefined) lines.push(`Humidity: ${w.humidity}%`);
      if (w.pressure !== undefined) lines.push(`Pressure: ${w.pressure} hPa`);
      if (w.windSpeed !== undefined) {
        const dir = w.windDirection !== undefined ? ` ${degreesToCardinal(w.windDirection)} (${w.windDirection}°)` : '';
        lines.push(`Wind: ${w.windSpeed} m/s${dir}`);
      }
      if (w.windGusts !== undefined) lines.push(`Wind gusts: ${w.windGusts} m/s`);
      if (w.cloudCover !== undefined) lines.push(`Cloud cover: ${w.cloudCover}%`);
      if (w.visibility !== undefined) lines.push(`Visibility: ${(w.visibility / 1000).toFixed(1)} km`);
      if (w.uvIndex !== undefined) lines.push(`UV index: ${w.uvIndex}`);
      if (w.precipitation !== undefined) lines.push(`Precipitation: ${w.precipitation} mm`);
      if (w.dewPoint !== undefined) lines.push(`Dew point: ${w.dewPoint}°C`);

      lines.push('');
      lines.push(`Location: ${loc.name}${loc.country ? ', ' + loc.country : ''} (${loc.lat}, ${loc.lon})`);
      lines.push(`Sources: ${sources.join(', ')}`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${String(err)}` }] };
    }
  },
};
