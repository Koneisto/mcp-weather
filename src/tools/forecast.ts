import { z } from 'zod';
import type { tool } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { fetchOpenMeteoForecast } from '../sources/open-meteo.js';
import { degreesToCardinal } from '../utils/units.js';

const schema = {
  location: z.string().describe('City name, coordinates (lat,lon), or Finnish city alias'),
  days: z.number().min(1).max(7).default(3).describe('Number of forecast days (1-7, default 3)'),
};

export const forecastTool: tool<typeof schema> = {
  name: 'get_weather_forecast',
  description: 'Get daily weather forecast for up to 7 days. Returns high/low temperatures, precipitation, wind, and conditions for each day.',
  schema,
  handler: async (args) => {
    try {
      const loc = await resolveLocation(args.location);
      const days = args.days ?? 3;
      const result = await fetchOpenMeteoForecast(loc.lat, loc.lon, days);

      if (!result.ok) {
        return { content: [{ type: 'text', text: `Error fetching forecast: ${result.error}` }] };
      }

      const lines: string[] = [
        `${days}-day forecast for ${loc.name}${loc.country ? ', ' + loc.country : ''}`,
        '',
      ];

      for (const day of result.data) {
        lines.push(`--- ${day.date} ---`);
        if (day.weatherDescription) lines.push(`Conditions: ${day.weatherDescription}`);
        if (day.tempMax !== undefined && day.tempMin !== undefined) {
          lines.push(`Temperature: ${day.tempMin}°C to ${day.tempMax}°C`);
        }
        if (day.precipitationSum !== undefined) {
          const prob = day.precipitationProbability !== undefined ? ` (${day.precipitationProbability}% chance)` : '';
          lines.push(`Precipitation: ${day.precipitationSum} mm${prob}`);
        }
        if (day.windSpeedMax !== undefined) {
          const dir = day.windDirection !== undefined ? ` from ${degreesToCardinal(day.windDirection)}` : '';
          lines.push(`Max wind: ${day.windSpeedMax} m/s${dir}`);
        }
        if (day.uvIndexMax !== undefined) lines.push(`UV index max: ${day.uvIndexMax}`);
        if (day.sunrise && day.sunset) {
          const rise = day.sunrise.includes('T') ? day.sunrise.split('T')[1] : day.sunrise;
          const set = day.sunset.includes('T') ? day.sunset.split('T')[1] : day.sunset;
          lines.push(`Sunrise: ${rise} | Sunset: ${set}`);
        }
        lines.push('');
      }

      lines.push(`Location: (${loc.lat}, ${loc.lon})`);
      lines.push(`Source: Open-Meteo`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${String(err)}` }] };
    }
  },
};
