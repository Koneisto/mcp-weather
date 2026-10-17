import { z } from 'zod';
import type { tool } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { fetchLakeByName, fetchLakeNear, withHistory, SYKE_ATTRIBUTION, type LakeNormal } from '../sources/syke.js';
import { countryOfLocation } from '../utils/region.js';
import { formatNum } from '../utils/units.js';
import { ok, fail, errorMessage, READ_ONLY_EXTERNAL } from '../utils/result.js';
import { locationOut } from '../utils/schemas.js';

const schema = {
  location: z.string().describe('Lake name as Syke names it (e.g. Saimaa, Päijänne, Kallavesi, Pielinen, Inarijärvi), or a place or coordinates (lat,lon) in Finland'),
  days: z.number().int().min(0).max(60).default(0).describe('Also return the daily water level and temperature of the last N days (0-60, default 0), e.g. for a chart'),
};

const normal = z.object({ mean: z.number(), min: z.number(), max: z.number(), years: z.number(), fromYear: z.number(), toYear: z.number() })
  .describe('same calendar day in the previous 30 years');
const fresh = {
  ageDays: z.number().describe('days since the value (daily values: 0 = today)'),
  status: z.enum(['current', 'missing', 'off_season']).describe('current: at most 3 days old; missing: older although the station normally ' +
    'measures on this day of the year (data has stopped coming); off_season: the station does not normally measure now (water temperature in winter)'),
};
const where = { station: z.string(), lake: z.string().optional(), partOf: z.string().optional().describe('larger lake the basin belongs to'), distanceKm: z.number().optional(), date: z.string().describe('YYYY-MM-DD, daily value') };
const outputSchema = {
  location: locationOut.optional(),
  lake: z.string().optional().describe('lake matched by name'),
  waterLevels: z.array(z.object({ ...where, ...fresh, stationId: z.number().describe('Syke station id'), cm: z.number().describe('on the gauge'),
    n2000M: z.number().optional().describe('height in the N2000 system, metres'),
    change7dCm: z.number().optional(), normal: normal.optional(), fromNormalCm: z.number().optional(),
    history: z.array(z.object({ date: z.string(), cm: z.number(), n2000M: z.number().optional() })).optional().describe('daily values, oldest first (days > 0)') })),
  waterTemperatures: z.array(z.object({ ...where, ...fresh, stationId: z.number(), celsius: z.number(), normal: normal.optional(), fromNormalC: z.number().optional(),
    history: z.array(z.object({ date: z.string(), celsius: z.number() })).optional() })),
  ice: z.array(z.object({ ...where, ageDays: fresh.ageDays, thicknessCm: z.number().optional(), snowCm: z.number().optional(), weak: z.boolean() })),
  iceStationOutOfSeason: z.object({ station: z.string(), distanceKm: z.number().optional(), lastDate: z.string() }).optional()
    .describe('nearest ice station, measured in winter; no current measurement (older than 25 days, weak ice 12 days)'),
  attribution: z.string(),
};

// "14 Oct", with the year when it is not this year
const fiDate = (d: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC',
  ...(d.slice(0, 4) !== new Date(Date.now()).toISOString().slice(0, 4) ? { year: 'numeric' as const } : {}) }).format(new Date(d + 'T00:00:00Z'));
const signed = (x: number, unit: string) => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${formatNum(Math.abs(x))} ${unit}`;
const rangeText = (v: number[], unit: string, days: number) =>
  `Last ${days} days: lowest ${formatNum(Math.min(...v))} ${unit}, highest ${formatNum(Math.max(...v))} ${unit} (${v.length} daily values)`;
const normalText = (n: LakeNormal, unit: string, date: string) =>
  `normal for ${fiDate(date)}, ${formatNum(unit === 'cm' ? Math.round(n.mean) : n.mean)} ${unit} (${n.fromYear}–${n.toYear}, range ${formatNum(n.min)}–${formatNum(n.max)} ${unit})`;

export const lakeTool: tool<typeof schema, typeof outputSchema> = {
  name: 'get_lake_conditions',
  title: 'Lake water level, water temperature and ice (Finland)',
  description: 'Finnish lakes and rivers from the Finnish Environment Institute (Syke): daily water level with its height above sea level (N2000), ' +
    'the change in a week and how it compares with the same day in the previous 30 years; surface water temperature against its normal; ' +
    'and ice thickness in winter. Ask by lake name (Saimaa, Päijänne, Kallavesi…) or by a place in Finland.',
  schema,
  outputSchema,
  annotations: READ_ONLY_EXTERNAL,
  handler: async (args) => {
    try {
      // a lake name is looked up among Syke's stations first; anything else is a place
      let data = await fetchLakeByName(args.location);
      let loc;
      if (!data) {
        loc = await resolveLocation(args.location);
        if (countryOfLocation(loc) !== 'FI') {
          return fail(`Lake data covers Finland (Syke stations); ${loc.name} is outside it. For the sea use get_marine_conditions.`);
        }
        data = await fetchLakeNear(loc.lat, loc.lon);
      }
      data = await withHistory(data, args.days ?? 0);
      const { levels, temperatures, ice } = data;
      if (!levels.length && !temperatures.length && !ice.length) {
        return fail(`No Syke lake or river station near ${loc?.name ?? args.location} (water level within 25 km, temperature within 50 km). Try the lake's name.`);
      }

      const lines = [`Lake conditions ${data.matchedLake ? `for ${data.matchedLake}` : `near ${loc!.name}`}`];
      const at = (x: { station: string; partOf?: string; distanceKm?: number; date: string }) =>
        `${x.station}${x.partOf && !x.station.startsWith(x.partOf) ? ` (part of ${x.partOf})` : ''}` +
        `${x.distanceKm !== undefined ? `, ${formatNum(x.distanceKm)} km away` : ''}, ${fiDate(x.date)}`;
      for (const l of levels) {
        if (l.status === 'missing') lines.push(`Water level: no new value from Syke for ${l.ageDays} days (the gauge reports daily); the latest is shown.`);
        lines.push(`Water level at ${at(l)}: ${l.n2000M !== undefined ? `${formatNum(l.n2000M)} m above sea level (N2000), ` : ''}${l.cm} cm on the gauge` +
          `${l.change7dCm !== undefined ? ` · ${signed(l.change7dCm, 'cm')} in a week` : ''}`);
        if (l.normal && l.fromNormalCm !== undefined) {
          lines.push(`  ${l.fromNormalCm === 0 ? 'At' : `${formatNum(Math.abs(l.fromNormalCm))} cm ${l.fromNormalCm > 0 ? 'above' : 'below'}`} the ${normalText(l.normal, 'cm', l.date)}`);
        }
        if (l.history?.length) lines.push(`  ${rangeText(l.history.map((h) => h.cm), 'cm', args.days ?? 0)}`);
      }
      for (const t of temperatures) {
        // 18.10.2026: off season (winter) vs. missing (the station normally measures today but the data has stopped)
        const old = t.status !== 'current';
        lines.push(`Surface water temperature at ${at(t)}: ${formatNum(t.celsius)} °C` + (t.status === 'off_season'
          ? ' (last measurement of the open-water season; not measured at this time of year)'
          : t.status === 'missing' ? ` (no new value from Syke for ${t.ageDays} days although it is normally measured at this time of year)` : ''));
        if (t.normal && t.fromNormalC !== undefined && !old) {
          lines.push(`  ${t.fromNormalC === 0 ? 'At' : `${formatNum(Math.abs(t.fromNormalC))} °C ${t.fromNormalC > 0 ? 'warmer than' : 'colder than'}`} the ${normalText(t.normal, '°C', t.date)}`);
        }
        if (t.history?.length) lines.push(`  ${rangeText(t.history.map((h) => h.celsius), '°C', args.days ?? 0)}`);
      }
      for (const i of ice) {
        lines.push(`Ice at ${at(i)}: ${i.weak && i.thicknessCm === undefined ? 'weak ice, too thin to measure' : i.thicknessCm !== undefined ? `${i.thicknessCm} cm thick` : 'measured'}` +
          `${i.snowCm ? `, ${i.snowCm} cm of snow on it` : ''}`);
      }
      if (data.iceIdle) {
        const i = data.iceIdle;
        lines.push(`Ice is measured in winter at ${i.station}${i.distanceKm !== undefined ? ` (${formatNum(i.distanceKm)} km away)` : ''}; latest measurement ${fiDate(i.lastDate)}`);
      }
      if (!temperatures.length) lines.push('No water temperature station on this lake or within 50 km.');
      lines.push('', 'Daily values; the gauge reading is relative to the gauge\'s own zero, the N2000 height is above sea level.', `Source: ${SYKE_ATTRIBUTION}`);
      return ok(lines.join('\n'), {
        location: loc ? { name: loc.name, country: loc.country, lat: loc.lat, lon: loc.lon } : undefined, lake: data.matchedLake,
        waterLevels: levels, waterTemperatures: temperatures, ice, iceStationOutOfSeason: data.iceIdle, attribution: SYKE_ATTRIBUTION,
      });
    } catch (err) {
      return fail(`Error fetching lake conditions: ${errorMessage(err)}`);
    }
  },
};
