import { z } from 'zod';
import type { tool, AirQualityData } from '../types.js';
import { resolveLocation } from '../utils/location.js';
import { fetchOpenMeteoAirQuality } from '../sources/open-meteo.js';
import { fetchFmiAirQuality } from '../sources/fmi-airquality.js';
import { aqiToCategory, europeanAqi, formatNum, formatLocalTime } from '../utils/units.js';
import { ok, fail, errorMessage, READ_ONLY_EXTERNAL } from '../utils/result.js';
import { locationOut, stationOut, toLocation } from '../utils/schemas.js';

const schema = {
  location: z.string().describe('City name, coordinates (lat,lon), or Finnish city alias'),
};

type Pollutant = 'pm25' | 'pm10' | 'no2' | 'o3' | 'so2' | 'co';
const POLLUTANTS: Array<[Pollutant, string]> = [
  ['pm25', 'PM2.5'], ['pm10', 'PM10'], ['no2', 'NO₂'], ['o3', 'O₃'], ['so2', 'SO₂'], ['co', 'CO'],
];

const value = z.object({ value: z.number().describe('µg/m³'), origin: z.enum(['measured', 'model']) });
const outputSchema = {
  location: locationOut,
  europeanAqi: z.number().optional(),
  category: z.string().optional().describe('Good, Fair, Moderate, Poor, Very poor, Extremely poor'),
  pollutants: z.object({ pm25: value.optional(), pm10: value.optional(), no2: value.optional(), o3: value.optional(), so2: value.optional(), co: value.optional() }),
  measuredAt: stationOut.optional().describe('air quality station (Finland, within 10 km); time = hourly value'),
  sources: z.array(z.string()),
};

export const airQualityTool: tool<typeof schema, typeof outputSchema> = {
  name: 'get_air_quality',
  title: 'Air quality',
  description: 'Get air quality index and pollutant concentrations (PM2.5, PM10, NO2, O3, SO2, CO) for a location. Returns the European AQI with category. In Finland, values measured at the nearest air quality station (within 10 km) take precedence over the model.',
  schema,
  outputSchema,
  annotations: READ_ONLY_EXTERNAL,
  handler: async (args) => {
    try {
      const loc = await resolveLocation(args.location);
      const [model, fmi] = await Promise.all([fetchOpenMeteoAirQuality(loc.lat, loc.lon), fetchFmiAirQuality(loc.lat, loc.lon)]);
      const measured = fmi.ok ? fmi.data : undefined;

      const lines: string[] = [`Air quality for ${loc.name}`, ''];
      const sources: string[] = [];
      if (measured) sources.push('FMI');
      if (model.ok) sources.push('Open-Meteo');

      if (!measured && !model.ok) {
        return fail(`Error: no air quality data available for ${loc.name} (${model.error})`);
      }
      const structured: Record<string, { value: number; origin: 'measured' | 'model' }> = {};
      let aqiOut: number | undefined;
      {
        // Measured values first, the model fills pollutants the station does not measure. The index is computed from
        // the values shown, so it agrees with them (the model's own index would describe the model values).
        const values: AirQualityData = {};
        const origin: Partial<Record<Pollutant, string>> = {};
        for (const [k] of POLLUTANTS) {
          const m = measured?.data[k], o = model.ok ? model.data[k] : undefined;
          if (m !== undefined) { values[k] = m; origin[k] = 'measured'; }
          else if (o !== undefined) { values[k] = o; origin[k] = 'model'; }
        }
        const aqi = measured ? europeanAqi(values) : (model.ok ? model.data.aqi : undefined);
        aqiOut = aqi;
        if (aqi !== undefined) lines.push(`European AQI: ${aqi} (${aqiToCategory(aqi)})`);
        for (const [k, label] of POLLUTANTS) {
          const v = values[k];
          if (v !== undefined) {
            lines.push(`${label}: ${formatNum(v)} µg/m³${measured ? ` (${origin[k]})` : ''}`);
            structured[k] = { value: v, origin: (origin[k] as 'measured' | 'model') ?? 'model' };
          }
        }
      }

      lines.push('');
      if (measured) {
        lines.push(`Measured at: ${measured.station} (${formatNum(measured.distanceKm)} km away), hourly average, ${formatLocalTime(measured.observationTime)}`);
      }
      lines.push(`Location: (${loc.lat}, ${loc.lon})`);
      if (sources.length > 0) lines.push(`Sources: ${sources.join(', ')}`);
      if (measured) lines.push('Observation data: Finnish Meteorological Institute and municipal air quality networks (CC BY 4.0)');

      return ok(lines.join('\n'), {
        location: toLocation(loc),
        europeanAqi: aqiOut,
        category: aqiOut === undefined ? undefined : aqiToCategory(aqiOut),
        pollutants: structured,
        measuredAt: measured && { station: measured.station, distanceKm: measured.distanceKm, observationTime: measured.observationTime },
        sources,
      });
    } catch (err) {
      return fail(`Error: ${errorMessage(err)}`);
    }
  },
};
