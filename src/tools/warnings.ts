import { z } from 'zod';
import type { tool } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { fetchWarnings, type Lang } from '../sources/warnings.js';
import { countryOfLocation, COUNTRY_NAME, COUNTRY_TZ } from '../utils/region.js';
import { ok, fail, errorMessage, READ_ONLY_EXTERNAL } from '../utils/result.js';
import { locationOut, toLocation } from '../utils/schemas.js';

const schema = {
  location: z.string().describe('City name, coordinates (lat,lon) or ICAO code in Finland, Sweden, Norway, Denmark, Iceland, Estonia, Latvia or Lithuania'),
  language: z.enum(['en', 'fi', 'sv', 'no']).default('en').describe('Warning text language where the source has it (fi and sv: Finland; sv: Sweden; no: Norway)'),
};

const warningOut = z.object({
  event: z.string(), level: z.enum(['yellow', 'orange', 'red', 'info']), severity: z.string().optional(),
  headline: z.string().optional(), description: z.string().optional(), instruction: z.string().optional(),
  area: z.string(), onset: z.string().optional().describe('ISO 8601'), expires: z.string().optional().describe('ISO 8601'),
});
const outputSchema = {
  location: locationOut,
  country: z.string(),
  coverage: z.enum(['point', 'country']).describe('point = warnings whose area contains the location; country = all warnings of the country (area outlines not published)'),
  warnings: z.array(warningOut),
  source: z.string(),
  attribution: z.string(),
};

const LEVEL = { red: 'Red', orange: 'Orange', yellow: 'Yellow', info: 'Notice' } as const;

export const warningsTool: tool<typeof schema, typeof outputSchema> = {
  name: 'get_weather_warnings',
  title: 'Weather warnings (Nordic and Baltic)',
  description: 'Get active official weather warnings for a location in Finland, Sweden, Norway, Denmark, Iceland, Estonia, Latvia or Lithuania (wind, storm, rain, snow, ice, thunder, waves, flood, forest fire, heat, cold). Finland (FMI), Sweden (SMHI) and Norway (MET Norway) are matched to the location; Denmark, Iceland and the Baltic countries list the country\'s warnings with their area names (MeteoAlarm).',
  schema,
  outputSchema,
  annotations: READ_ONLY_EXTERNAL,
  handler: async (args) => {
    try {
      const loc = await resolveLocation(args.location);
      const country = countryOfLocation(loc);
      if (!country) return fail(`Error: weather warnings are available for Finland, Sweden, Norway, Denmark, Iceland, Estonia, Latvia and Lithuania; ${loc.name} is not in these countries`);
      const r = await fetchWarnings(country, loc.lat, loc.lon, (args.language ?? 'en') as Lang);
      const tz = COUNTRY_TZ[country];
      const when = (iso?: string) => iso ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '';
      const where = `${loc.name} (${COUNTRY_NAME[country]})`;
      const lines: string[] = [];
      if (!r.warnings.length) lines.push(r.coverage === 'point' ? `No active weather warnings for ${where}.` : `No active weather warnings in ${COUNTRY_NAME[country]}.`);
      else {
        lines.push(r.coverage === 'point' ? `${r.warnings.length} active weather warning${r.warnings.length === 1 ? '' : 's'} for ${where}:`
          : `${r.warnings.length} active weather warning${r.warnings.length === 1 ? '' : 's'} in ${COUNTRY_NAME[country]} (the source does not publish area outlines, so check whether the area names include ${loc.name}):`);
        for (const w of r.warnings) {
          lines.push('', `${LEVEL[w.level]}: ${w.event}${w.area ? ' — ' + w.area : ''}`);
          if (w.onset || w.expires) lines.push(`  ${when(w.onset)}${w.expires ? ' – ' + when(w.expires) : ''}`);
          const short = (s: string) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > 400 ? t.slice(0, 400).replace(/\s+\S*$/, '') + ' …' : t; };   // full text in structuredContent
          if (w.description) lines.push(`  ${short(w.description)}`);
          if (w.instruction) lines.push(`  ${short(w.instruction)}`);
        }
      }
      lines.push('', `Source: ${r.source} · ${r.attribution}`);
      return ok(lines.join('\n'), { location: toLocation(loc), country: COUNTRY_NAME[country], coverage: r.coverage, warnings: r.warnings, source: r.source, attribution: r.attribution });
    } catch (err) {
      return fail(`Error fetching weather warnings: ${errorMessage(err)}`);
    }
  },
};
