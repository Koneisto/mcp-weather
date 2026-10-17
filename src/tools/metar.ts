import { z } from 'zod';
import type { tool } from '../types.js';
import { fetchMetar } from '../sources/metar.js';
import { lookupFinnishLocation } from '../utils/finnish-locations.js';
import { degreesToCardinal, formatNum, formatFixed, formatLocalTime } from '../utils/units.js';
import { fetchFmiObservation, type FmiObservation } from '../sources/fmi.js';
import { finnishAirports } from '../utils/finnish-airports.js';
import { ok, fail, errorMessage, READ_ONLY_EXTERNAL } from '../utils/result.js';

const FMI_AIRPORT_RADIUS_KM = 15;

/** METAR unavailable: the Finnish airport's FMI station observation, clearly marked as not a METAR. */
function fmiFallbackText(icao: string, metarError: string, o: FmiObservation): string {
  const w = o.weather;
  const lines: string[] = [
    `METAR for ${icao} is unavailable (${metarError}).`,
    `Showing the airport weather station observation from the Finnish Meteorological Institute instead.`,
    `This is not a METAR: no raw message, flight category or cloud base heights.`,
    '',
    `Station: ${o.station} (${formatNum(o.distanceKm)} km from the aerodrome reference point)`,
    `Observation: ${formatLocalTime(o.observationTime)} Finnish time (${o.observationTime})`,
  ];
  if (w.temperature !== undefined) lines.push(`Temperature: ${formatNum(w.temperature)} °C`);
  if (w.dewPoint !== undefined) lines.push(`Dew point: ${formatNum(w.dewPoint)} °C`);
  if (w.windSpeed !== undefined) {
    const dir = w.windDirection !== undefined ? ` from ${degreesToCardinal(w.windDirection)} (${formatNum(w.windDirection)}°)` : '';
    lines.push(`Wind: ${formatNum(w.windSpeed)} m/s${dir}`);
  }
  if (w.windGusts !== undefined) lines.push(`Wind gusts: ${formatNum(w.windGusts)} m/s`);
  if (w.visibility !== undefined) lines.push(`Visibility: ${formatFixed(w.visibility / 1000, 1)} km`);
  if (w.cloudCover !== undefined) lines.push(`Cloud cover: ${formatNum(w.cloudCover)} %`);
  if (w.pressure !== undefined) lines.push(`Pressure (sea level): ${formatNum(w.pressure)} hPa`);
  lines.push('');
  lines.push('Source: Finnish Meteorological Institute open data (CC BY 4.0)');
  return lines.join('\n');
}

const schema = {
  station: z.string().max(200).describe('ICAO airport code (e.g. "EFHK") or city name with a known ICAO code'),
};

const outputSchema = {
  station: z.string().describe('ICAO code'),
  kind: z.enum(['metar', 'fmi_observation']).describe('fmi_observation = METAR unavailable, airport weather station observation instead (not a METAR)'),
  raw: z.string().optional().describe('raw METAR (kind = metar)'),
  observationTime: z.string().optional().describe('ISO 8601, UTC'),
  flightCategory: z.string().optional(),
  temperature: z.number().optional(),
  dewPoint: z.number().optional(),
  windSpeed: z.number().optional().describe('m/s'),
  windDirection: z.number().optional(),
  windGusts: z.number().optional().describe('m/s'),
  visibility: z.number().optional().describe('metres'),
  visibilityOrMore: z.boolean().optional().describe('visibility is a lower bound (9999, CAVOK, P6SM)'),
  cloudCover: z.number().optional().describe('% (FMI observation)'),
  clouds: z.string().optional(),
  weather: z.string().optional(),
  pressure: z.number().optional().describe('hPa'),
  altimeter: z.number().optional().describe('hPa'),
  fmiStation: z.string().optional(),
  fmiDistanceKm: z.number().optional(),
  metarUnavailableReason: z.string().optional(),
  source: z.string(),
};

export const metarTool: tool<typeof schema, typeof outputSchema> = {
  name: 'get_metar',
  title: 'Aviation weather (METAR)',
  description: 'Get aviation weather (METAR) for an airport. Returns raw METAR string plus decoded values including flight category, wind, visibility, clouds, and altimeter. Accepts ICAO codes or Finnish city names. For Finnish airports, falls back to the airport weather station observation from the Finnish Meteorological Institute if METAR is unavailable.',
  schema,
  outputSchema,
  annotations: READ_ONLY_EXTERNAL,
  handler: async (args) => {
    try {
      let icao = args.station.trim().toUpperCase();

      // Try to resolve city name to ICAO
      if (!/^[A-Z]{4}$/.test(icao)) {
        const alias = lookupFinnishLocation(args.station);
        if (alias?.icao) {
          icao = alias.icao;
        } else {
          return fail(`Could not resolve "${args.station}" to an ICAO code. Please provide a 4-letter ICAO airport code (e.g. EFHK for Helsinki).`);
        }
      }

      const result = await fetchMetar(icao);
      if (!result.ok) {
        // Finnish airports: fall back to the airport's FMI weather station
        const airport = finnishAirports[icao];
        if (airport) {
          const fmi = await fetchFmiObservation(airport.lat, airport.lon, FMI_AIRPORT_RADIUS_KM);
          if (fmi.ok) {
            const o = fmi.data, w = o.weather;
            return ok(fmiFallbackText(icao, result.error, o), {
              station: icao, kind: 'fmi_observation', observationTime: o.observationTime,
              temperature: w.temperature, dewPoint: w.dewPoint, windSpeed: w.windSpeed, windDirection: w.windDirection,
              windGusts: w.windGusts, visibility: w.visibility, cloudCover: w.cloudCover, pressure: w.pressure,
              fmiStation: o.station, fmiDistanceKm: o.distanceKm, metarUnavailableReason: result.error,
              source: 'Finnish Meteorological Institute open data (CC BY 4.0)',
            });
          }
          return fail(`Error fetching METAR: ${result.error}. FMI fallback also failed: ${fmi.error}`);
        }
        return fail(`Error fetching METAR: ${result.error}`);
      }

      const m = result.data;
      const lines: string[] = [
        `METAR for ${m.station}`,
        '',
        `Raw: ${m.raw}`,
        '',
      ];

      if (m.observationTime) lines.push(`Observation: ${formatLocalTime(m.observationTime)} Finnish time (${m.observationTime})`);
      if (m.flightCategory) lines.push(`Flight category: ${m.flightCategory}`);
      if (m.temperature !== undefined) lines.push(`Temperature: ${formatNum(m.temperature)} °C`);
      if (m.dewPoint !== undefined) lines.push(`Dew point: ${formatNum(m.dewPoint)} °C`);
      if (m.windSpeed !== undefined) {
        const dir = m.windDirection !== undefined ? ` from ${degreesToCardinal(m.windDirection)} (${formatNum(m.windDirection)}°)` : '';
        lines.push(`Wind: ${formatNum(m.windSpeed)} m/s${dir}`);
      }
      if (m.windGusts !== undefined) lines.push(`Wind gusts: ${formatNum(m.windGusts)} m/s`);
      if (m.visibility !== undefined) lines.push(`Visibility: ${formatFixed(m.visibility / 1000, 1)} km${m.visibilityOrMore ? ' or more' : ''}`);
      if (m.pressure !== undefined) lines.push(`Pressure: ${formatNum(m.pressure)} hPa`);
      if (m.altimeter !== undefined) lines.push(`Altimeter: ${formatNum(m.altimeter)} hPa`);
      if (m.clouds) lines.push(`Clouds: ${m.clouds}`);
      if (m.weather) lines.push(`Weather: ${m.weather}`);

      lines.push('');
      lines.push('Source: aviationweather.gov');

      return ok(lines.join('\n'), {
        station: m.station, kind: 'metar', raw: m.raw, observationTime: m.observationTime, flightCategory: m.flightCategory,
        temperature: m.temperature, dewPoint: m.dewPoint, windSpeed: m.windSpeed, windDirection: m.windDirection,
        windGusts: m.windGusts, visibility: m.visibility, visibilityOrMore: m.visibilityOrMore, clouds: m.clouds,
        weather: m.weather, pressure: m.pressure, altimeter: m.altimeter, source: 'aviationweather.gov',
      });
    } catch (err) {
      return fail(`Error: ${errorMessage(err)}`);
    }
  },
};
