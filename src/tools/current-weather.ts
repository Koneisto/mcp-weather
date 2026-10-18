import { z } from 'zod';
import type { tool } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { aggregateCurrentWeather } from '../utils/aggregator.js';
import { degreesToCardinal, formatNum, formatFixed, formatLocalTime } from '../utils/units.js';
import { ok, fail, errorMessage, READ_ONLY_EXTERNAL } from '../utils/result.js';
import { locationOut, stationOut, toLocation } from '../utils/schemas.js';

const selectableFields = ['temperature', 'feelsLike', 'conditions', 'humidity', 'pressure', 'windSpeed', 'windDirection', 'windGusts', 'cloudCover', 'visibility', 'uvIndex', 'precipitation', 'dewPoint', 'snowDepth', 'location', 'measuredAt', 'nearestStation', 'attribution', 'sources'] as const;

const schema = {
  fields: z.array(z.enum(selectableFields)).min(1).max(selectableFields.length).optional().describe('Requested output fields; skips fallback providers once these weather fields are filled.'),
  location: z.string().max(200).describe('City name, coordinates (lat,lon), ICAO code or Finnish city alias (e.g. "Helsinki", "hki", "60.17,24.94", "EFHK")'),
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
  snowDepth: z.number().optional().describe('cm, measured at the FMI station'),
  measuredAt: stationOut.extend({ provider: z.string().optional() }).optional()
    .describe('national weather service station whose measurement is used (within 15 km); in Norway the MET Nordic analysis at the point'),
  nearestStation: stationOut.extend({ temperature: z.number().optional(), provider: z.string().optional() }).optional()
    .describe('Nearest national station within 50 km, for reference only (not used in the values)'),
  attribution: z.array(z.string()).optional(),
  sources: z.array(z.string()),
};

export const currentWeatherTool: tool<typeof schema, typeof outputSchema> = {
  name: 'get_current_weather',
  title: 'Current weather',
  description: 'Get current weather conditions for a location. Returns temperature, feels-like, humidity, wind, pressure, cloud cover, UV index, and precipitation aggregated from multiple sources. Measured values come first: the nearest station (within 15 km) of the national weather service in Finland (FMI), Sweden (SMHI), Denmark (DMI), Iceland (IMO), Lithuania (LHMT) and Estonia, and MET Norway\'s MET Nordic analysis in Norway, Sweden, Finland and Denmark.',
  schema,
  outputSchema,
  annotations: READ_ONLY_EXTERNAL,
  handler: async (args) => {
    try {
      const loc = await resolveLocation(args.location);
      const { weather: w, sources, summary, observation, nearbyObservation: near, analysis } = await aggregateCurrentWeather(loc, args.fields);

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
      if (w.snowDepth) lines.push(`Snow depth: ${formatNum(w.snowDepth)} cm`);   // 0 = no snow, not shown

      lines.push('');
      lines.push(`Location: ${loc.name}${loc.country ? ', ' + loc.country : ''} (${loc.lat}, ${loc.lon})`);
      if (observation && !observation.analysis) {
        lines.push(`Measured at: ${observation.station} (${observation.provider}, ${formatNum(observation.distanceKm)} km away) at ${formatLocalTime(observation.observationTime)}`);
      } else if (observation) {
        lines.push(`Analysis: ${observation.station}, valid ${formatLocalTime(observation.observationTime)}`);
      }
      if (near) {
        const t = near.weather.temperature !== undefined ? `${formatNum(near.weather.temperature)} °C` : 'no temperature';
        lines.push(`Nearest weather station: ${near.station} (${near.provider}), ${formatNum(near.distanceKm)} km away: ${t} at ${formatLocalTime(near.observationTime)} (for reference; too far to replace the values above)`);
      }
      lines.push(`Sources: ${sources.join(', ')}`);
      const attribution = [...new Set([observation, near, analysis].filter((o) => !!o).map((o) => o!.attribution))];
      if (attribution.length) lines.push(`Observation data: ${attribution.join('; ')}`);

      if (!sources.length) return fail(`Error: no weather source answered for ${loc.name}`);
      const st = (o: typeof observation) => o && { station: o.station, distanceKm: o.distanceKm, observationTime: o.observationTime, provider: o.provider };
      return ok(lines.join('\n'), {
        location: toLocation(loc),
        temperature: w.temperature, feelsLike: w.feelsLike, conditions: w.weatherDescription, humidity: w.humidity,
        pressure: w.pressure, windSpeed: w.windSpeed, windDirection: w.windDirection, windGusts: w.windGusts,
        cloudCover: w.cloudCover, visibility: w.visibility, uvIndex: w.uvIndex, precipitation: w.precipitation, dewPoint: w.dewPoint, snowDepth: w.snowDepth,
        measuredAt: st(observation),
        nearestStation: near && { ...st(near)!, temperature: near.weather.temperature },
        attribution: attribution.length ? attribution : undefined,
        sources,
      });
    } catch (err) {
      return fail(`Error: ${errorMessage(err)}`);
    }
  },
};
