import { z } from 'zod';
import type { tool } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { fetchMarine, type Reading } from '../sources/marine.js';
import { countryOfLocation, COUNTRY_TZ } from '../utils/region.js';
import { degreesToCardinal, formatNum } from '../utils/units.js';
import { ok, fail, errorMessage, READ_ONLY_EXTERNAL } from '../utils/result.js';
import { locationOut, toLocation } from '../utils/schemas.js';

const schema = {
  location: z.string().describe('Coastal place, harbour, coordinates (lat,lon) at sea or ICAO code; measured data in Finland, Sweden, Denmark and Norway'),
};

const reading = {
  provider: z.string(), station: z.string(), distanceKm: z.number(), time: z.string().describe('ISO 8601, UTC'),
};
const level = z.object({ time: z.string(), cm: z.number() });
const outputSchema = {
  location: locationOut,
  seaLevel: z.object({ ...reading, cm: z.number(), reference: z.string().describe('national reference level of the gauge') }).optional(),
  seaLevelForecast: z.object({ provider: z.string(), station: z.string(), reference: z.string(), until: z.string(), high: level, low: level }).optional(),
  waterTemperature: z.object({ ...reading, celsius: z.number() }).optional(),
  waves: z.object({ ...reading, heightM: z.number().describe('significant wave height'), directionDeg: z.number().optional().describe('waves coming from'),
    periodS: z.number().optional() }).optional().describe('measured by a wave buoy'),
  model: z.object({ provider: z.string(), time: z.string().optional(), heightM: z.number().optional(), directionDeg: z.number().optional(),
    periodS: z.number().optional(), seaTempC: z.number().optional(), maxHeightM: z.number().optional().describe('highest significant wave height in the next 24 h'),
    maxTime: z.string().optional() }).optional().describe('wave model at the point'),
  attribution: z.array(z.string()),
};

const signed = (cm: number) => `${cm > 0 ? '+' : ''}${cm} cm`;
const dir = (deg?: number) => (deg === undefined ? '' : ` from ${degreesToCardinal(deg)} (${Math.round(deg)}°)`);

export const marineTool: tool<typeof schema, typeof outputSchema> = {
  name: 'get_marine_conditions',
  title: 'Sea level, water temperature and waves',
  description: 'Conditions at sea near a coastal location: measured sea level against the national reference and its forecast (Finland, Norway), ' +
    'water temperature and wave buoy measurements from FMI, SMHI, DMI and Kartverket, plus a wave model (height, direction, period, ' +
    'highest in the next 24 h) anywhere at sea. For boating, swimming, harbours and flooding on the coast.',
  schema,
  outputSchema,
  annotations: READ_ONLY_EXTERNAL,
  handler: async (args) => {
    try {
      const loc = await resolveLocation(args.location);
      const country = countryOfLocation(loc);
      const m = await fetchMarine(loc.lat, loc.lon, country === 'NO');
      if (!m.seaLevel && !m.waterTemp && !m.waves && !m.model) {
        return fail(`No sea data for ${loc.name}: it is not at the coast or at sea (no tide gauge, buoy or sea model point nearby).`);
      }
      const tz = COUNTRY_TZ[country ?? 'FI'];
      const fmt = (t: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, ...opts }).format(new Date(t));
      const today = fmt(new Date().toISOString(), { weekday: 'short' });
      // "19:00" today, "Fri 06:00" on other days
      const when = (t: string) => {
        const d = fmt(t, { weekday: 'short' });
        return `${d === today ? '' : `${d} `}${fmt(t, { hour: '2-digit', minute: '2-digit' })}`;
      };
      const at = (r: Reading) => `at ${r.station} (${r.provider}${r.distanceKm >= 1 ? `, ${formatNum(r.distanceKm)} km away` : ''}, ${when(r.time)})`;

      const lines = [`Marine conditions near ${loc.name}`];
      if (m.seaLevel) lines.push(`Sea level: ${signed(m.seaLevel.cm)} against ${m.seaLevel.reference} ${at(m.seaLevel)}`);
      if (m.forecast) {
        const f = m.forecast;
        lines.push(`Sea level forecast until ${when(f.until)}: highest ${signed(f.high.cm)} around ${when(f.high.time)}, lowest ${signed(f.low.cm)} around ${when(f.low.time)}`);
      }
      if (m.waterTemp) lines.push(`Water temperature: ${formatNum(m.waterTemp.celsius)} °C ${at(m.waterTemp)}`);
      if (m.waves) {
        const w = m.waves;
        lines.push(`Waves: ${formatNum(w.heightM)} m${dir(w.directionDeg)}${w.periodS !== undefined ? `, period ${formatNum(w.periodS)} s` : ''} ${at(w)}`);
      }
      if (m.model) {
        const x = m.model, parts: string[] = [];
        if (x.heightM !== undefined) parts.push(`waves ${formatNum(x.heightM)} m${dir(x.directionDeg)}${x.periodS !== undefined ? `, period ${formatNum(x.periodS)} s` : ''}`);
        if (x.maxHeightM !== undefined && x.maxTime) parts.push(`highest in the next 24 h ${formatNum(x.maxHeightM)} m around ${when(x.maxTime)}`);
        if (x.seaTempC !== undefined) parts.push(`sea surface ${formatNum(x.seaTempC)} °C`);
        if (parts.length) lines.push(`Wave model (${x.provider === 'MET Norway' ? 'MET Norway Oceanforecast' : 'Open-Meteo Marine'}): ${parts.join(' · ')}`);
      }
      if (!m.seaLevel && !m.waves && !m.waterTemp) lines.push('No tide gauge or wave buoy nearby; the values are from the model.');
      lines.push('', `Sources: ${m.attribution.join('; ')}`);
      return ok(lines.join('\n'), {
        location: toLocation(loc), seaLevel: m.seaLevel, seaLevelForecast: m.forecast, waterTemperature: m.waterTemp, waves: m.waves, model: m.model,
        attribution: m.attribution,
      });
    } catch (err) {
      return fail(`Error fetching marine conditions: ${errorMessage(err)}`);
    }
  },
};
