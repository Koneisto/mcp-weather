import { z } from 'zod';
import SunCalc from 'suncalc';
import type { tool } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { fetchKp, fetchRIndex, kpNeeded, SPACE_ATTRIBUTION, type KpSlot, type RStation } from '../sources/space-weather.js';
import { fetchOpenMeteoHourlyCloud, forecastModel } from '../sources/open-meteo.js';
import { kmBetween } from '../utils/region.js';
import { formatNum } from '../utils/units.js';
import { ok, fail, errorMessage, READ_ONLY_EXTERNAL } from '../utils/result.js';
import { locationOut, toLocation } from '../utils/schemas.js';

const schema = {
  location: z.string().max(200).describe('City name, coordinates (lat,lon) or ICAO code; best in the Nordic countries'),
  hours: z.number().min(6).max(48).default(24).describe('How many hours ahead (6-48, default 24)'),
};

type Chance = 'none' | 'low' | 'moderate' | 'high';
const hourOut = z.object({
  time: z.string().describe('local time, YYYY-MM-DDTHH:MM'), kp: z.number(), cloudCover: z.number().optional().describe('%'),
  chance: z.enum(['none', 'low', 'moderate', 'high']),
});
const outputSchema = {
  location: locationOut,
  kpNeeded: z.number().describe('Kp at which auroras typically become visible at this latitude'),
  kpNow: z.number().optional(),
  activityNow: z.object({ station: z.string(), distanceKm: z.number(), rIndex: z.number(), level: z.string(), time: z.string() }).optional()
    .describe('FMI R-index at the nearest Finnish magnetometer within 300 km'),
  darkHours: z.number().describe('hours with the sun more than 12° below the horizon in the period'),
  best: hourOut.optional(),
  chance: z.enum(['none', 'low', 'moderate', 'high']).describe('best chance in the period'),
  hours: z.array(hourOut).describe('dark hours only'),
  attribution: z.string(),
};

const RANK: Record<Chance, number> = { none: 0, low: 1, moderate: 2, high: 3 };
/** Activity from Kp against the latitude's threshold, then lowered by clouds (over 85 % blocks, over 50 % one step down). */
export function auroraChance(kp: number, need: number, cloud?: number | null): Chance {
  let c: Chance = kp >= need + 1 ? 'high' : kp >= need ? 'moderate' : kp >= need - 1 ? 'low' : 'none';
  if (cloud != null && cloud > 85) return 'none';
  if (cloud != null && cloud > 50 && c !== 'none') c = c === 'high' ? 'moderate' : c === 'moderate' ? 'low' : 'none';
  return c;
}
const kpAt = (slots: KpSlot[], t: number) => {
  const s = slots.filter((x) => Date.parse(x.time) <= t).pop();
  return s ? s.kp : undefined;
};

export const auroraTool: tool<typeof schema, typeof outputSchema> = {
  name: 'get_aurora_forecast',
  title: 'Aurora (northern lights) forecast',
  description: 'Chance to see the northern lights at a location in the coming hours: geomagnetic activity (NOAA Kp forecast and, in Finland, the FMI R-index measured right now), the Kp needed at that latitude, darkness and cloud cover hour by hour.',
  schema,
  outputSchema,
  annotations: READ_ONLY_EXTERNAL,
  handler: async (args) => {
    try {
      const loc = await resolveLocation(args.location);
      const hours = args.hours ?? 24;
      const [kp, rIdx, cloud] = await Promise.all([
        fetchKp(),
        fetchRIndex().catch(() => [] as RStation[]),
        fetchOpenMeteoHourlyCloud(loc.lat, loc.lon, hours + 2).catch(() => null),   // +2: the cloud series starts at the current hour
      ]);
      const need = kpNeeded(loc.lat);
      const now = Date.now();
      const kpNow = kpAt(kp.filter((x) => x.kind !== 'predicted'), now) ?? kpAt(kp, now);
      const near = rIdx.map((s) => ({ s, km: kmBetween(loc.lat, loc.lon, s.lat, s.lon) })).sort((a, b) => a.km - b.km)[0];
      const activityNow = near && near.km <= 300
        ? { station: near.s.name, distanceKm: Math.round(near.km), rIndex: near.s.r, level: near.s.text, time: near.s.time.replace(' ', 'T').replace('+00:00', 'Z') }
        : undefined;

      const out: Array<z.infer<typeof hourOut>> = [];
      let dark = 0;
      const start = Math.ceil(now / 3600000) * 3600000;
      for (let i = 0; i < hours; i++) {
        const t = start + i * 3600000;
        if (SunCalc.getPosition(new Date(t), loc.lat, loc.lon).altitude * 180 / Math.PI > -12) continue;
        dark++;
        const k = kpAt(kp, t) ?? kpNow ?? 0;
        let cc: number | undefined;
        let local = new Date(t).toISOString().slice(0, 16);
        if (cloud) {
          const idx = cloud.times.findIndex((x) => Math.abs(Date.parse(x + 'Z') - (t + tzOffsetMs(cloud.timezone, t))) < 1800000);
          if (idx >= 0) { cc = cloud.cloud[idx] ?? undefined; local = cloud.times[idx]; }
        }
        out.push({ time: local, kp: k, cloudCover: cc, chance: auroraChance(k, need, cc) });
      }
      // best hour: highest chance, then known cloud cover before unknown, then fewer clouds, then higher Kp
      const best = out.slice().sort((a, b) => RANK[b.chance] - RANK[a.chance] || (a.cloudCover === undefined ? 1 : 0) - (b.cloudCover === undefined ? 1 : 0)
        || (a.cloudCover ?? 100) - (b.cloudCover ?? 100) || b.kp - a.kp)[0];
      const chance: Chance = best ? best.chance : 'none';

      const lines = [`Aurora forecast for ${loc.name}, next ${hours} h`];
      lines.push(`Kp needed here: about ${formatNum(need)} · Kp now: ${kpNow !== undefined ? formatNum(kpNow) : 'unknown'}`);
      if (activityNow) lines.push(`Measured activity now at ${activityNow.station} (${activityNow.distanceKm} km): ${activityNow.level.toLowerCase()} (R-index ${activityNow.rIndex})`);
      if (!dark) lines.push('No dark hours in this period (the sun stays less than 12° below the horizon), so auroras cannot be seen.');
      else {
        // consecutive dark hours as periods ("03:00–06:00, 19:00–23:00"), each period ending at its last dark hour + 1 h
        const periods: string[] = [];
        for (let i = 0; i < out.length; i++) {
          const s = i;
          while (i + 1 < out.length && Date.parse(out[i + 1].time + 'Z') - Date.parse(out[i].time + 'Z') === 3600000) i++;
          const end = new Date(Date.parse(out[i].time + 'Z') + 3600000).toISOString().slice(11, 16);
          periods.push(`${out[s].time.slice(11)}–${end}`);
        }
        lines.push(`Dark enough: ${dark} h (${periods.join(', ')} local time)`);
        const clearSky = out.reduce((m, h) => Math.max(m, RANK[auroraChance(h.kp, need)]), 0);   // the same hours without clouds
        lines.push(chance === 'none' ? (clearSky > 0 ? 'Chance: very low because clouds cover the sky during the dark hours (activity alone would allow auroras).'
          : 'Chance: very low (too little geomagnetic activity for this latitude).')
          : `Best chance: ${chance}${best ? ` around ${best.time.slice(11)} (Kp ${formatNum(best.kp)}${best.cloudCover !== undefined ? `, clouds ${best.cloudCover} %` : ', cloud cover unknown'})` : ''}`);
        const cl = out.map((h) => h.cloudCover).filter((x): x is number => x !== undefined);
        if (cl.length) lines.push(`Cloud cover during dark hours: ${Math.min(...cl)}–${Math.max(...cl)} %`);
      }
      lines.push('', `Sources: NOAA SWPC Kp${activityNow ? ', FMI R-index' : ''}, cloud cover ${forecastModel(loc.lat, loc.lon).label} · ${SPACE_ATTRIBUTION}`);
      return ok(lines.join('\n'), {
        location: toLocation(loc), kpNeeded: need, kpNow, activityNow, darkHours: dark, best, chance, hours: out, attribution: SPACE_ATTRIBUTION,
      });
    } catch (err) {
      return fail(`Error fetching aurora forecast: ${errorMessage(err)}`);
    }
  },
};

/** Offset (ms) of a time zone from UTC at an instant. */
function tzOffsetMs(tz: string, t: number): number {
  const p: Record<string, number> = {};
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(t))) p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute) - Math.floor(t / 60000) * 60000;
}
