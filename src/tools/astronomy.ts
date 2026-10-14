import { z } from 'zod';
import type { tool } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { getSunData, getMoonData } from '../utils/suncalc.js';
import { formatFixed, degreesToCardinal } from '../utils/units.js';
import { ok, fail, errorMessage, READ_ONLY_EXTERNAL } from '../utils/result.js';
import { locationOut, toLocation } from '../utils/schemas.js';

const schema = {
  location: z.string().describe('City name, coordinates (lat,lon), or Finnish city alias'),
  date: z.string().optional().describe('Date in YYYY-MM-DD format (default: today)'),
  timezone: z.string().optional().describe('IANA timezone (default: Europe/Helsinki)'),
};

const t = z.string().nullable().describe('HH:MM in the requested timezone, null if it does not occur');
const outputSchema = {
  location: locationOut,
  date: z.string(),
  timezone: z.string(),
  sun: z.object({
    sunrise: t, sunset: t, solarNoon: t, solarNoonAltitude: z.number().nullable().describe('degrees'), nadir: t,
    dayLength: z.string().nullable(), dawn: t, dusk: t, nauticalDawn: t, nauticalDusk: t, nightEnd: t, night: t,
    goldenHourStart: t, goldenHourEnd: t,
    polarCondition: z.enum(['midnight-sun', 'polar-night', 'white-nights']).nullable(),
  }),
  moon: z.object({
    phaseName: z.string(), illumination: z.number().describe('%'), moonrise: t, moonset: t,
    alwaysUp: z.boolean(), alwaysDown: z.boolean(),
  }),
};

export const astronomyTool: tool<typeof schema, typeof outputSchema> = {
  name: 'get_astronomy',
  title: 'Sun and moon',
  description: 'Get comprehensive sun and moon data: sunrise/sunset, precise solar noon with altitude, civil/nautical/astronomical twilight, golden hour, day length, moon phase/illumination, moonrise/moonset. Computed locally — no API key needed. Handles Nordic polar conditions (midnight sun, polar night, white nights).',
  schema,
  outputSchema,
  annotations: READ_ONLY_EXTERNAL,   // computed locally, but a place name is geocoded online
  handler: async (args) => {
    try {
      const tz = args.timezone ?? 'Europe/Helsinki';
      try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); } catch {
        return fail(`Error: unknown timezone "${tz}" (use an IANA name such as Europe/Helsinki)`);
      }
      // Default: today in the requested timezone (the UTC date was yesterday's after midnight in Finland)
      const dateStr = args.date?.trim() || new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
      const [year, month, day] = dm ? [+dm[1], +dm[2], +dm[3]] : [NaN, NaN, NaN];
      const check = new Date(Date.UTC(year, month - 1, day));
      if (!dm || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
        // before 10/2026 "2026-13-45" rolled over to February 2027 and "tomorrow" produced NaN results
        return fail(`Error: invalid date "${dateStr}" (use YYYY-MM-DD)`);
      }
      const loc = await resolveLocation(args.location);

      // Local solar noon of the target date at this longitude, independent of the server's timezone
      // (before: noon in the server's timezone, which could fall on the wrong day far east or west)
      const targetDate = new Date(Date.UTC(year, month - 1, day, 12) - (loc.lon / 15) * 3600e3);

      const sun = getSunData(targetDate, loc.lat, loc.lon, tz);
      const moon = getMoonData(targetDate, loc.lat, loc.lon, tz);

      const lines: string[] = [
        `Astronomy for ${loc.name} on ${dateStr}`,
        '',
      ];

      // -- Sun --
      lines.push('-- Sun --');
      if (sun.polarCondition === 'midnight-sun') {
        lines.push('Sun does not set — midnight sun');
        if (sun.solarNoonAltitude !== null) {
          lines.push(`Solar noon: ${sun.solarNoon} (altitude ${formatFixed(sun.solarNoonAltitude, 1)}°)`);
        }
      } else if (sun.polarCondition === 'polar-night') {
        lines.push('Sun does not rise — polar night');
        if (sun.solarNoonAltitude !== null) {
          lines.push(`Highest point: ${formatFixed(sun.solarNoonAltitude, 1)}° below horizon`);
        }
      } else {
        if (sun.sunrise) lines.push(`Sunrise: ${sun.sunrise}`);
        if (sun.sunset) lines.push(`Sunset: ${sun.sunset}`);
        if (sun.dayLength) lines.push(`Day length: ${sun.dayLength}`);
        if (sun.solarNoon && sun.solarNoonAltitude !== null) {
          lines.push(`Solar noon: ${sun.solarNoon} (altitude ${formatFixed(sun.solarNoonAltitude, 1)}°)`);
        }
      }

      // -- Twilight --
      lines.push('');
      lines.push('-- Twilight --');
      if (sun.dawn || sun.dusk) {
        const dawn = sun.dawn ?? 'does not occur';
        const dusk = sun.dusk ?? 'does not occur';
        lines.push(`Civil dawn: ${dawn} | Civil dusk: ${dusk}`);
      }
      if (sun.nauticalDawn || sun.nauticalDusk) {
        const nd = sun.nauticalDawn ?? 'does not occur';
        const nk = sun.nauticalDusk ?? 'does not occur';
        lines.push(`Nautical dawn: ${nd} | Nautical dusk: ${nk}`);
      } else if (sun.polarCondition === 'white-nights' || sun.polarCondition === 'midnight-sun') {
        lines.push('Nautical: does not occur (white nights)');
      }
      if (sun.nightEnd || sun.night) {
        const ne = sun.nightEnd ?? 'does not occur';
        const n = sun.night ?? 'does not occur';
        lines.push(`Astronomical dawn: ${ne} | Astronomical dusk: ${n}`);
      } else if (sun.polarCondition) {
        lines.push('Astronomical: does not occur');
      }

      // -- Golden hour --
      if (sun.goldenHourEnd || sun.goldenHourStart) {
        lines.push('');
        lines.push('-- Golden hour --');
        if (sun.goldenHourEnd) lines.push(`Morning: ends ${sun.goldenHourEnd}`);
        if (sun.goldenHourStart) lines.push(`Evening: starts ${sun.goldenHourStart}`);
      }

      // -- Moon --
      lines.push('');
      lines.push('-- Moon --');
      lines.push(`Phase: ${moon.phaseName} (${moon.illumination} %)`);
      if (moon.alwaysUp) {
        lines.push('Moon does not set');
      } else if (moon.alwaysDown) {
        lines.push('Moon does not rise');
      } else {
        if (moon.moonrise) lines.push(`Moonrise: ${moon.moonrise}`);
        if (moon.moonset) lines.push(`Moonset: ${moon.moonset}`);
      }

      lines.push('');
      lines.push(`Location: ${loc.name}${loc.country ? ', ' + loc.country : ''} (${loc.lat}, ${loc.lon})`);
      lines.push('Source: suncalc (computed)');

      return ok(lines.join('\n'), { location: toLocation(loc), date: dateStr, timezone: tz, sun: { ...sun }, moon: { ...moon } });
    } catch (err) {
      return fail(`Error: ${errorMessage(err)}`);
    }
  },
};
