import { z } from 'zod';
import type { tool } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { fetchOpenMeteoForecast } from '../sources/open-meteo.js';
import { fetchFmiDailyForecast, FMI_FORECAST_ATTRIBUTION } from '../sources/fmi-forecast.js';
import { countryOfLocation } from '../utils/region.js';
import type { DailyForecast } from '../types.js';
import { degreesToCardinal, formatNum } from '../utils/units.js';
import { ok, fail, errorMessage, READ_ONLY_EXTERNAL } from '../utils/result.js';
import { locationOut, toLocation } from '../utils/schemas.js';

const schema = {
  location: z.string().max(200).describe('City name, coordinates (lat,lon), or Finnish city alias'),
  days: z.number().min(1).max(7).default(3).describe('Number of forecast days (1-7, default 3)'),
};

const outputSchema = {
  location: locationOut,
  days: z.array(z.object({
    date: z.string().describe('YYYY-MM-DD, local'),
    conditions: z.string().optional(),
    tempMin: z.number().optional(),
    tempMax: z.number().optional(),
    precipitationSum: z.number().optional().describe('mm'),
    precipitationProbability: z.number().optional().describe('%'),
    windSpeedMax: z.number().optional().describe('m/s'),
    windDirection: z.number().optional(),
    uvIndexMax: z.number().optional(),
    sunrise: z.string().optional().describe('HH:MM local'),
    sunset: z.string().optional().describe('HH:MM local'),
    source: z.string().optional().describe('forecast behind the day\'s weather values'),
  })),
  source: z.string(),
};

export const forecastTool: tool<typeof schema, typeof outputSchema> = {
  name: 'get_weather_forecast',
  title: 'Weather forecast',
  description: 'Get daily weather forecast for up to 7 days. Returns high/low temperatures, precipitation probability, max wind speed, UV index, and sunrise/sunset for each day. In Finland the days come from FMI\'s meteorologist-edited forecast (the one on ilmatieteenlaitos.fi), elsewhere in the Nordic and Baltic countries from MET Norway\'s high-resolution MET Nordic model.',
  schema,
  outputSchema,
  annotations: READ_ONLY_EXTERNAL,
  handler: async (args) => {
    try {
      const loc = await resolveLocation(args.location);
      const days = args.days ?? 3;
      const finland = countryOfLocation(loc) === 'FI';
      const [result, fmi] = await Promise.all([
        fetchOpenMeteoForecast(loc.lat, loc.lon, days),
        finland ? fetchFmiDailyForecast(loc.lat, loc.lon) : Promise.resolve([] as DailyForecast[]),
      ]);

      if (!result.ok) {
        return fail(`Error fetching forecast: ${result.error}`);
      }
      // In Finland FMI's forecast gives the weather values of each full day it covers; the model keeps UV, sunrise and
      // sunset, and the days FMI does not cover in full (usually today).
      const fmiByDate = new Map(fmi.map((d) => [d.date, d]));
      const merged = result.data.map((d) => {
        const f = fmiByDate.get(d.date);
        return f ? { ...d, ...f, weatherCode: undefined, uvIndexMax: d.uvIndexMax, sunrise: d.sunrise, sunset: d.sunset, source: 'FMI' } : { ...d, source: result.source };
      });
      const fmiDays = merged.filter((d) => d.source === 'FMI').map((d) => d.date);
      const source = fmiDays.length
        ? `${FMI_FORECAST_ATTRIBUTION} for ${fmiDays.length === 1 ? fmiDays[0] : `${fmiDays[0]}–${fmiDays[fmiDays.length - 1]}`}; ` +
          `${fmiDays.length < merged.length ? 'other days, ' : ''}UV and sunrise/sunset: ${result.source}`
        : result.source;

      const lines: string[] = [
        `${days}-day forecast for ${loc.name}${loc.country ? ', ' + loc.country : ''}`,
        '',
      ];

      for (const day of merged) {
        lines.push(`--- ${day.date} ---`);
        if (day.weatherDescription) lines.push(`Conditions: ${day.weatherDescription}`);
        if (day.tempMax !== undefined && day.tempMin !== undefined) {
          lines.push(`Temperature: ${formatNum(day.tempMin)} °C to ${formatNum(day.tempMax)} °C`);
        }
        if (day.precipitationSum !== undefined) {
          const prob = day.precipitationProbability !== undefined ? ` (${formatNum(day.precipitationProbability)} % chance)` : '';
          lines.push(`Precipitation: ${formatNum(day.precipitationSum)} mm${prob}`);
        }
        if (day.windSpeedMax !== undefined) {
          const dir = day.windDirection !== undefined ? ` from ${degreesToCardinal(day.windDirection)}` : '';
          lines.push(`Max wind: ${formatNum(day.windSpeedMax)} m/s${dir}`);
        }
        if (day.uvIndexMax !== undefined) lines.push(`UV index max: ${formatNum(day.uvIndexMax)}`);
        if (day.sunrise && day.sunset) {
          const rise = day.sunrise.includes('T') ? day.sunrise.split('T')[1] : day.sunrise;
          const set = day.sunset.includes('T') ? day.sunset.split('T')[1] : day.sunset;
          lines.push(`Sunrise: ${rise} | Sunset: ${set}`);
        }
        lines.push('');
      }

      lines.push(`Location: (${loc.lat}, ${loc.lon})`);
      lines.push(`Source: ${source}`);

      const time = (x?: string) => (x && x.includes('T') ? x.split('T')[1] : x);
      return ok(lines.join('\n'), {
        location: toLocation(loc),
        days: merged.map((d) => ({
          date: d.date, conditions: d.weatherDescription, tempMin: d.tempMin, tempMax: d.tempMax,
          precipitationSum: d.precipitationSum, precipitationProbability: d.precipitationProbability,
          windSpeedMax: d.windSpeedMax, windDirection: d.windDirection, uvIndexMax: d.uvIndexMax,
          sunrise: time(d.sunrise), sunset: time(d.sunset), source: d.source,
        })),
        source,
      });
    } catch (err) {
      return fail(`Error: ${errorMessage(err)}`);
    }
  },
};
