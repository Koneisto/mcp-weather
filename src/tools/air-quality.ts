import { z } from 'zod';
import type { tool } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { fetchOpenMeteoAirQuality } from '../sources/open-meteo.js';
import { fetchTomorrowAirQuality } from '../sources/tomorrow-io.js';
import { aqiToCategory } from '../utils/units.js';

const schema = {
  location: z.string().describe('City name, coordinates (lat,lon), or Finnish city alias'),
};

export const airQualityTool: tool<typeof schema> = {
  name: 'get_air_quality',
  description: 'Get air quality index and pollutant levels for a location. Uses European AQI from Open-Meteo (free). Enhanced with Tomorrow.io data if API key is configured.',
  schema,
  handler: async (args) => {
    try {
      const loc = await resolveLocation(args.location);

      const [openMeteoResult, tomorrowResult] = await Promise.allSettled([
        fetchOpenMeteoAirQuality(loc.lat, loc.lon),
        fetchTomorrowAirQuality(loc.lat, loc.lon),
      ]);

      const lines: string[] = [
        `Air quality for ${loc.name}`,
        '',
      ];

      const sources: string[] = [];
      let hasData = false;

      // Open-Meteo AQI (primary)
      if (openMeteoResult.status === 'fulfilled' && openMeteoResult.value.ok) {
        const d = openMeteoResult.value.data;
        hasData = true;
        sources.push('Open-Meteo');
        if (d.aqi !== undefined) {
          lines.push(`European AQI: ${d.aqi} (${d.aqiCategory ?? aqiToCategory(d.aqi)})`);
        }
        if (d.pm25 !== undefined) lines.push(`PM2.5: ${d.pm25} µg/m³`);
        if (d.pm10 !== undefined) lines.push(`PM10: ${d.pm10} µg/m³`);
        if (d.no2 !== undefined) lines.push(`NO₂: ${d.no2} µg/m³`);
        if (d.o3 !== undefined) lines.push(`O₃: ${d.o3} µg/m³`);
        if (d.so2 !== undefined) lines.push(`SO₂: ${d.so2} µg/m³`);
        if (d.co !== undefined) lines.push(`CO: ${d.co} µg/m³`);
      }

      // Tomorrow.io enhancement
      if (tomorrowResult.status === 'fulfilled' && tomorrowResult.value.ok) {
        const d = tomorrowResult.value.data;
        sources.push('Tomorrow.io');
        if (d.aqi !== undefined && !hasData) {
          lines.push(`EPA AQI: ${d.aqi} (${aqiToCategory(d.aqi)})`);
        } else if (d.aqi !== undefined) {
          lines.push(`EPA AQI (Tomorrow.io): ${d.aqi} (${aqiToCategory(d.aqi)})`);
        }
        hasData = true;
      }

      if (!hasData) {
        lines.push('No air quality data available for this location.');
      }

      lines.push('');
      lines.push(`Location: (${loc.lat}, ${loc.lon})`);
      if (sources.length > 0) lines.push(`Sources: ${sources.join(', ')}`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${String(err)}` }] };
    }
  },
};
