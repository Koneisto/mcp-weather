import { z } from 'zod';
import type { tool } from '../types.js';
import { fetchMetar } from '../sources/metar.js';
import { lookupFinnishLocation } from '../utils/finnish-locations.js';
import { degreesToCardinal } from '../utils/units.js';

const schema = {
  station: z.string().describe('ICAO airport code (e.g. "EFHK") or city name with a known ICAO code'),
};

export const metarTool: tool<typeof schema> = {
  name: 'get_metar',
  description: 'Get aviation weather (METAR) for an airport. Returns raw METAR string plus decoded values including flight category, wind, visibility, clouds, and altimeter. Accepts ICAO codes or Finnish city names.',
  schema,
  handler: async (args) => {
    try {
      let icao = args.station.trim().toUpperCase();

      // Try to resolve city name to ICAO
      if (!/^[A-Z]{4}$/.test(icao)) {
        const alias = lookupFinnishLocation(args.station);
        if (alias?.icao) {
          icao = alias.icao;
        } else {
          return { content: [{ type: 'text', text: `Could not resolve "${args.station}" to an ICAO code. Please provide a 4-letter ICAO airport code (e.g. EFHK for Helsinki).` }] };
        }
      }

      const result = await fetchMetar(icao);
      if (!result.ok) {
        return { content: [{ type: 'text', text: `Error fetching METAR: ${result.error}` }] };
      }

      const m = result.data;
      const lines: string[] = [
        `METAR for ${m.station}`,
        '',
        `Raw: ${m.raw}`,
        '',
      ];

      if (m.observationTime) lines.push(`Observation: ${m.observationTime}`);
      if (m.flightCategory) lines.push(`Flight category: ${m.flightCategory}`);
      if (m.temperature !== undefined) lines.push(`Temperature: ${m.temperature}°C`);
      if (m.dewPoint !== undefined) lines.push(`Dew point: ${m.dewPoint}°C`);
      if (m.windSpeed !== undefined) {
        const dir = m.windDirection !== undefined ? ` from ${degreesToCardinal(m.windDirection)} (${m.windDirection}°)` : '';
        lines.push(`Wind: ${m.windSpeed} m/s${dir}`);
      }
      if (m.windGusts !== undefined) lines.push(`Wind gusts: ${m.windGusts} m/s`);
      if (m.visibility !== undefined) lines.push(`Visibility: ${(m.visibility / 1000).toFixed(1)} km`);
      if (m.pressure !== undefined) lines.push(`Pressure: ${m.pressure} hPa`);
      if (m.altimeter !== undefined) lines.push(`Altimeter: ${m.altimeter} hPa`);
      if (m.clouds) lines.push(`Clouds: ${m.clouds}`);
      if (m.weather) lines.push(`Weather: ${m.weather}`);

      lines.push('');
      lines.push('Source: aviationweather.gov');

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${String(err)}` }] };
    }
  },
};
