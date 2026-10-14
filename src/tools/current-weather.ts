import { z } from 'zod';
import type { tool } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { aggregateCurrentWeather } from '../utils/aggregator.js';
import { degreesToCardinal, formatNum, formatFixed, formatLocalTime } from '../utils/units.js';
import { ok, fail, errorMessage, READ_ONLY_EXTERNAL } from '../utils/result.js';
import { locationOut, stationOut, toLocation } from '../utils/schemas.js';

const schema = {
  location: z.string().describe('City name, coordinates (lat,lon), ICAO code or Finnish city alias (e.g. "Helsinki", "hki", "60.17,24.94", "EFHK")'),
};

const outputSchema = {
  location: locationOut,
  temperature: z.number().optional(),
  feelsLike: z.number().optional(),
  conditions: z.string().optional(),
  humidity: z.number().optional(),
  pressure: z.number().optional().describe('hPa, sea level'),
  windSpeed: z.number().optional(),
  windDirection: z.number().optional(),
  windGusts: z.number().optional(),
  cloudCover: z.number().optional(),
  visibility: z.number().optional().describe('metres'),
  uvIndex: z.number().optional(),
  precipitation: z.number().optional().describe('mm'),
  dewPoint: z.number().optional(),
  measuredAt: stationOut.optional().describe('FMI station whose measurement is used (Finland, within 15 km)'),
  nearestStation: stationOut.extend({ temperature: z.number().optional() }).optional()
    .describe('Nearest FMI station within 50 km, for reference only (not used in the values)'),
  sources: z.array(z.string()),
};

export const currentWeatherTool: tool<typeof schema, typeof outputSchema> = {
  name: 'get_current_weather',
  title: 'Current weather',
  description: 'Get current weather conditions for a location. Returns temperature, feels-like, humidity, wind, pressure, cloud cover, UV index, and precipitation aggregated from multiple sources. In Finland the nearest FMI weather station\'s measurement (within 15 km) comes first. Optimized for Nordic/Finnish locations with instant alias resolution.',
  schema,
  outputSchema,
  annotations: READ_ONLY_EXTERNAL,
  handler: async (args) => {
    try {
      const loc = await resolveLocation(args.location);
      const { weather: w, sources, summary, observation, nearbyObservation: near } = await aggregateCurrentWeather(loc);

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
      if (observation) {
        lines.push(`Measured at: ${observation.station} (${formatNum(observation.distanceKm)} km away) at ${formatLocalTime(observation.observationTime)}`);
      }
      if (near) {
        const t = near.weather.temperature !== undefined ? `${formatNum(near.weather.temperature)} °C` : 'no temperature';
        lines.push(`Nearest weather station: ${near.station}, ${formatNum(near.distanceKm)} km away: ${t} at ${formatLocalTime(near.observationTime)} (for reference; too far to replace the values above)`);
      }
      lines.push(`Sources: ${sources.join(', ')}`);
      if (observation || near) lines.push('Observation data: Finnish Meteorological Institute (CC BY 4.0)');

      if (!sources.length) return fail(`Error: no weather source answered for ${loc.name}`);
      const st = (o: typeof observation) => o && { station: o.station, distanceKm: o.distanceKm, observationTime: o.observationTime };
      return ok(lines.join('\n'), {
        location: toLocation(loc),
        temperature: w.temperature, feelsLike: w.feelsLike, conditions: w.weatherDescription, humidity: w.humidity,
        pressure: w.pressure, windSpeed: w.windSpeed, windDirection: w.windDirection, windGusts: w.windGusts,
        cloudCover: w.cloudCover, visibility: w.visibility, uvIndex: w.uvIndex, precipitation: w.precipitation, dewPoint: w.dewPoint,
        measuredAt: st(observation),
        nearestStation: near && { ...st(near)!, temperature: near.weather.temperature },
        sources,
      });
    } catch (err) {
      return fail(`Error: ${errorMessage(err)}`);
    }
  },
};
