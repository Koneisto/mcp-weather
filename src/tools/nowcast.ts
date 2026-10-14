import { z } from 'zod';
import type { tool } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { metGet, MET_ATTRIBUTION } from '../sources/met-norway.js';
import { countryOfLocation, COUNTRY_TZ } from '../utils/region.js';
import { formatNum } from '../utils/units.js';
import { ok, fail, errorMessage, READ_ONLY_EXTERNAL } from '../utils/result.js';
import { locationOut, toLocation } from '../utils/schemas.js';

const schema = {
  location: z.string().describe('City name, coordinates (lat,lon) or ICAO code in the Nordic radar area (Norway, Sweden, Finland, Denmark, Baltic countries)'),
};

const outputSchema = {
  location: locationOut,
  radarCoverage: z.string().describe('ok, temporarily unavailable or no coverage'),
  updatedAt: z.string().optional(),
  raining: z.boolean().describe('precipitation now'),
  startsAt: z.string().optional().describe('ISO 8601, first 5-minute step with precipitation (if not raining now)'),
  endsAt: z.string().optional().describe('ISO 8601, first dry step after the precipitation'),
  maxRate: z.number().describe('mm/h'),
  totalMm: z.number().describe('mm over the nowcast period'),
  steps: z.array(z.object({ time: z.string(), rate: z.number().describe('mm/h') })),
  source: z.string(),
  attribution: z.string(),
};

interface Nowcast {
  properties: { meta: { updated_at?: string; radar_coverage?: string }; timeseries: Array<{ time: string; data: { instant: { details: { precipitation_rate?: number } } } }> };
}
const WET = 0.1;   // mm/h

export const nowcastTool: tool<typeof schema, typeof outputSchema> = {
  name: 'get_precipitation_nowcast',
  title: 'Precipitation nowcast (next 2 hours, radar)',
  description: 'Will it rain or snow in the next 2 hours? Radar-based precipitation nowcast in 5-minute steps from MET Norway for the Nordic radar area: whether it is raining now, when precipitation starts or stops, the heaviest rate and the total.',
  schema,
  outputSchema,
  annotations: READ_ONLY_EXTERNAL,
  handler: async (args) => {
    try {
      const loc = await resolveLocation(args.location);
      const d = await metGet<Nowcast>('nowcast/2.0/complete', loc.lat, loc.lon);
      const coverage = d.properties.meta.radar_coverage ?? 'unknown';
      const tz = COUNTRY_TZ[countryOfLocation(loc) ?? 'NO'];
      const hm = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
      const steps = d.properties.timeseries.map((s) => ({ time: s.time, rate: s.data.instant.details.precipitation_rate ?? 0 }));
      if (coverage !== 'ok' || !steps.length) {
        return fail(`Precipitation nowcast is not available for ${loc.name}: radar coverage ${coverage}. Use get_weather_forecast for the hourly outlook.`);
      }
      const raining = steps[0].rate >= WET;
      const first = steps.findIndex((s) => s.rate >= WET);
      const startsAt = !raining && first >= 0 ? steps[first].time : undefined;
      const from = raining ? 0 : first;
      const dry = from >= 0 ? steps.findIndex((s, i) => i > from && s.rate < WET) : -1;
      const endsAt = from >= 0 && dry >= 0 ? steps[dry].time : undefined;
      const maxRate = Math.max(...steps.map((s) => s.rate));
      const stepH = steps.length > 1 ? (Date.parse(steps[1].time) - Date.parse(steps[0].time)) / 3600000 : 5 / 60;
      const totalMm = Math.round(steps.reduce((a, s) => a + s.rate * stepH, 0) * 10) / 10;
      const until = hm(steps[steps.length - 1].time);
      const lines = [`Precipitation nowcast for ${loc.name} until ${until}`];
      if (first < 0) lines.push('No precipitation expected in the next 2 hours.');
      else {
        lines.push(raining ? `Precipitation now (${formatNum(steps[0].rate)} mm/h)${endsAt ? `, ending around ${hm(endsAt)}` : ', continuing beyond the nowcast'}.`
          : `Precipitation starting around ${hm(startsAt!)}${endsAt ? ` and ending around ${hm(endsAt)}` : ''}.`);
        lines.push(`Heaviest: ${formatNum(maxRate)} mm/h · total about ${formatNum(totalMm)} mm`);
      }
      lines.push('', `Radar data updated ${d.properties.meta.updated_at ? hm(d.properties.meta.updated_at) : 'unknown'} · Source: ${MET_ATTRIBUTION}`);
      return ok(lines.join('\n'), {
        location: toLocation(loc), radarCoverage: coverage, updatedAt: d.properties.meta.updated_at, raining, startsAt, endsAt,
        maxRate, totalMm, steps, source: 'MET Norway Nowcast 2.0', attribution: MET_ATTRIBUTION,
      });
    } catch (err) {
      if (/returned (422|400)\b/.test(errorMessage(err))) {   // MET Norway answers 422 for points outside the nowcast (radar) area
        return fail(`Precipitation nowcast covers the Nordic radar area (Norway, Sweden, Finland, Denmark and nearby); ${args.location} is outside it. Use get_weather_forecast instead.`);
      }
      return fail(`Error fetching precipitation nowcast: ${errorMessage(err)}`);
    }
  },
};
