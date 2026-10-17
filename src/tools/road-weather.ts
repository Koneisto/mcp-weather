import { z } from 'zod';
import type { tool } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { fetchRoadWeather, ROAD_ATTRIBUTION } from '../sources/road-weather.js';
import { countryOfLocation } from '../utils/region.js';
import { degreesToCardinal, formatNum } from '../utils/units.js';
import { ok, fail, errorMessage, READ_ONLY_EXTERNAL } from '../utils/result.js';
import { locationOut, toLocation } from '../utils/schemas.js';

const schema = {
  location: z.string().max(200).describe('Place, road junction area or coordinates (lat,lon) in Finland'),
};

const condition = z.enum(['normal', 'poor', 'very poor', 'unknown']);
const outputSchema = {
  location: locationOut,
  station: z.object({
    id: z.number(), name: z.string(), road: z.number().optional(), distanceKm: z.number(), measuredTime: z.string().describe('ISO 8601, UTC'),
    airTemp: z.number().optional(), roadTemp: z.number().optional().describe('road surface °C'), dewPoint: z.number().optional(),
    freezingPoint: z.number().optional().describe('freezing point of the water on the surface (lower with salt)'), humidity: z.number().optional(),
    windSpeed: z.number().optional(), windGusts: z.number().optional(), windDirection: z.number().optional(),
    precipitationRate: z.number().optional().describe('mm/h'), visibilityKm: z.number().optional(), friction: z.number().optional().describe('0–1, dry asphalt about 0.8'),
    surface: z.string().optional().describe('road surface state, e.g. Dry, Wet, Frost, Snow, Ice'), precipitation: z.string().optional(),
    warning: z.string().optional().describe('station slipperiness warning, OK when none'),
    frostRisk: z.boolean().describe('road surface at or below 0 °C and not warmer than the dew point'),
  }).optional(),
  forecast: z.array(z.object({ step: z.string().describe('0h = now, then 2h, 4h, 6h, 12h'), time: z.string(), condition, roads: z.array(z.number()), reasons: z.array(z.string()) }))
    .describe('worst road condition per step over the road sections within 10 km'),
  sections: z.number().describe('road sections in the forecast'),
  attribution: z.string(),
};

export const roadWeatherTool: tool<typeof schema, typeof outputSchema> = {
  name: 'get_road_weather',
  title: 'Road weather and driving conditions (Finland)',
  description: 'Driving conditions on Finnish roads near a location: the nearest Fintraffic road weather station (road surface temperature and state, ' +
    'friction, slipperiness warning, precipitation, visibility, wind) and Fintraffic\'s road condition forecast for the next 12 hours.',
  schema,
  outputSchema,
  annotations: READ_ONLY_EXTERNAL,
  handler: async (args) => {
    try {
      const loc = await resolveLocation(args.location);
      if (countryOfLocation(loc) !== 'FI') {
        return fail(`Road weather covers Finland (Fintraffic road weather stations); ${loc.name} is outside it. Use get_current_weather or get_weather_warnings instead.`);
      }
      const { station: s, forecast, sections } = await fetchRoadWeather(loc.lat, loc.lon);
      if (!s && !sections) return fail(`No road weather station or forecast road section near ${loc.name} (within 30 km).`);

      const lines = [`Road weather near ${loc.name}`];
      if (s) {
        const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(s.measuredTime));
        lines.push(`Station: ${s.name}${s.road ? ` (road ${s.road})` : ''}, ${formatNum(s.distanceKm)} km away, measured ${hm}`);
        const surf = [s.roadTemp !== undefined ? `${formatNum(s.roadTemp)} °C` : null, s.surface?.toLowerCase()].filter(Boolean).join(', ');
        const temps = [surf && `Road surface: ${surf}`, s.airTemp !== undefined && `air ${formatNum(s.airTemp)} °C`, s.dewPoint !== undefined && `dew point ${formatNum(s.dewPoint)} °C`];
        lines.push(temps.filter(Boolean).join(' · '));
        const wx = [s.precipitation && `Precipitation: ${s.precipitation.toLowerCase()}${s.precipitationRate ? ` (${formatNum(s.precipitationRate)} mm/h)` : ''}`,
          s.visibilityKm !== undefined && `visibility ${formatNum(s.visibilityKm)} km`,
          s.windSpeed !== undefined && `wind ${formatNum(s.windSpeed)} m/s${s.windGusts !== undefined ? ` (gusts ${formatNum(s.windGusts)})` : ''}${s.windDirection !== undefined ? ` from ${degreesToCardinal(s.windDirection)}` : ''}`];
        if (wx.some(Boolean)) lines.push(wx.filter(Boolean).join(' · '));
        const grip = [s.friction !== undefined && `Friction: ${formatNum(s.friction)} (dry asphalt about ${formatNum(0.8)})`,
          s.warning && `slipperiness warning: ${s.warning === 'OK' ? 'none' : s.warning.toLowerCase()}`];
        if (grip.some(Boolean)) lines.push(grip.filter(Boolean).join(' · '));
        if (s.frostRisk) lines.push('Frost risk: the road surface is below freezing and not warmer than the dew point.');
      } else lines.push('No road weather station with fresh data within 30 km.');

      if (forecast.length) {
        lines.push(`Road condition forecast (${sections} road sections within 10 km): ` +
          forecast.map((f) => `${f.step === '0h' ? 'now' : f.step.replace('h', ' h')} ${f.condition}`).join(', '));
        for (const f of forecast.filter((x) => x.condition === 'poor' || x.condition === 'very poor')) {
          lines.push(`  ${f.step === '0h' ? 'Now' : `In ${f.step.replace('h', ' h')}`}: ${f.condition} on road${f.roads.length > 1 ? 's' : ''} ${f.roads.join(', ')}` +
            `${f.reasons.length ? ` (${f.reasons.join(', ')})` : ''}`);
        }
      }
      lines.push('', `Source: ${ROAD_ATTRIBUTION}`);
      return ok(lines.join('\n'), { location: toLocation(loc), station: s ?? undefined, forecast, sections, attribution: ROAD_ATTRIBUTION });
    } catch (err) {
      return fail(`Error fetching road weather: ${errorMessage(err)}`);
    }
  },
};
