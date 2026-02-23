import { z } from 'zod';
import type { tool } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { fetchOpenMeteoForecast } from '../sources/open-meteo.js';
import { fetchWeatherApiAstronomy } from '../sources/weatherapi.js';
import { formatNum } from '../utils/units.js';

const schema = {
  location: z.string().describe('City name, coordinates (lat,lon), or Finnish city alias'),
  date: z.string().optional().describe('Date in YYYY-MM-DD format (default: today)'),
};

export const astronomyTool: tool<typeof schema> = {
  name: 'get_astronomy',
  description: 'Get sunrise, sunset, day length, and optionally moon data for a location. Moon phase and moonrise/moonset available when WeatherAPI key is configured.',
  schema,
  handler: async (args) => {
    try {
      const loc = await resolveLocation(args.location);
      const date = args.date ?? new Date().toISOString().split('T')[0];

      const lines: string[] = [
        `Astronomy for ${loc.name} on ${date}`,
        '',
      ];

      // Sunrise/sunset from Open-Meteo forecast (always available)
      const forecastResult = await fetchOpenMeteoForecast(loc.lat, loc.lon, 1);
      if (forecastResult.ok && forecastResult.data.length > 0) {
        const day = forecastResult.data[0];
        if (day.sunrise && day.sunset) {
          const rise = day.sunrise.includes('T') ? day.sunrise.split('T')[1] : day.sunrise;
          const set = day.sunset.includes('T') ? day.sunset.split('T')[1] : day.sunset;

          // Calculate day length
          const riseDate = new Date(day.sunrise);
          const setDate = new Date(day.sunset);
          const diffMs = setDate.getTime() - riseDate.getTime();
          const hours = Math.floor(diffMs / 3600000);
          const minutes = Math.floor((diffMs % 3600000) / 60000);

          lines.push(`Sunrise: ${rise}`);
          lines.push(`Sunset: ${set}`);
          lines.push(`Day length: ${hours}h ${minutes}m`);

          // Solar noon approximation
          const noonMs = riseDate.getTime() + diffMs / 2;
          const noonDate = new Date(noonMs);
          lines.push(`Solar noon: ~${noonDate.toTimeString().slice(0, 5)}`);
        }
      }

      // Moon data from WeatherAPI (optional)
      const astroResult = await fetchWeatherApiAstronomy(loc.lat, loc.lon, date);
      if (astroResult.ok) {
        const a = astroResult.data;
        lines.push('');
        if (a.moonPhase) lines.push(`Moon phase: ${a.moonPhase}`);
        if (a.moonIllumination !== undefined) lines.push(`Moon illumination: ${formatNum(a.moonIllumination)} %`);
        if (a.moonrise) lines.push(`Moonrise: ${a.moonrise}`);
        if (a.moonset) lines.push(`Moonset: ${a.moonset}`);
      }

      lines.push('');
      lines.push(`Location: (${loc.lat}, ${loc.lon})`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${String(err)}` }] };
    }
  },
};
