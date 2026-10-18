import { z } from 'zod';
import type { tool, ToolResult } from './types.js';

export type Profile = 'full' | 'compact';
type AnyTool = tool<z.ZodRawShape, z.ZodRawShape>;
const descriptions: Record<string, string> = {
  get_current_weather: 'Current measured weather; models fill gaps. Fields select top-level values.',
  get_weather_forecast: 'Daily forecast, up to 7 days; FMI in Finland, MET Nordic elsewhere.',
  get_precipitation_nowcast: 'Radar rain/snow for the next 2 hours, Nordic area.',
  get_weather_warnings: 'Official Nordic/Baltic warnings. Country coverage requires checking area names.',
  get_marine_conditions: 'Coastal sea level, temperature, waves and model forecast.',
  get_lake_conditions: 'Finnish lake level, temperature and ice; retain freshness and ice cautions.',
  get_road_weather: 'Finnish road station and 12-hour driving conditions.',
  get_air_quality: 'European AQI, pollutants and pollen; measured values first.',
  get_aurora_forecast: 'Northern lights: Kp, darkness and cloud cover.',
  get_metar: 'Airport METAR and decoded aviation weather.',
  get_astronomy: 'Local sun/moon calculations, including polar conditions.',
  get_weather_source_status: 'Source health, shared cache and quota status. Full detail includes key setup.',
};
const contextKeys = new Set(['location', 'lake', 'country', 'coverage', 'source', 'sources', 'attribution', 'measuredAt', 'nearestStation', 'updatedAt', 'observationTime', 'date', 'radarCoverage', 'station', 'kind', 'fmiStation', 'fmiDistanceKm', 'metarUnavailableReason', 'timezone', 'activityNow']);
const safety: Record<string, string[]> = {
  get_weather_warnings: ['warnings'],
  get_road_weather: ['station', 'forecast', 'sections'],
  get_lake_conditions: ['waterLevels', 'waterTemperatures', 'ice', 'iceStationOutOfSeason'],
  get_air_quality: ['europeanAqi', 'category'],
  get_metar: ['flightCategory', 'raw', 'visibilityOrMore'],
};
const notes: Record<string, string> = {
  get_current_weather: 'nearestStation is reference only; it does not supply the reported values. No measurement time means freshness is unknown.',
  get_weather_warnings: 'coverage=country lists all country warnings; check each area against location. Empty warnings do not imply other hazards are absent.',
  get_lake_conditions: 'Daily readings. status=missing is stale; off_season is not a current measurement. Ice thickness never establishes safe ice. Gauge cm uses station zero; n2000M is altitude.',
  get_air_quality: 'Pollutants: µg/m³; pollen: grains/m³. No measurement time means model freshness is unknown.',
  get_marine_conditions: 'model is forecast, not buoy measurement; sea level reference is gauge-specific.',
};
// Units remain available when outputSchema descriptions are omitted from discovery.
const units: Record<string, string> = {
  get_lake_conditions: 'water level cm relative to gauge zero; n2000M m altitude; temperature °C; ice/snow thickness cm; ageDays days',
  get_marine_conditions: 'sea level cm against named reference; water temperature °C; wave height m; wave period s; directions degrees; wind m/s',
  get_current_weather: 'temperature/feelsLike/dewPoint °C; humidity/cloudCover %; pressure hPa; windSpeed/windGusts m/s; windDirection degrees; visibility m; precipitation mm; snowDepth cm',
  get_weather_forecast: 'temperature °C; precipitation mm; probability %; wind m/s; direction degrees',
  get_precipitation_nowcast: 'maxRate/steps.rate mm/h; totalMm mm',
  get_road_weather: 'temperatures °C; wind m/s; direction degrees; humidity %; precipitationRate mm/h; visibilityKm km; friction 0–1',
  get_astronomy: 'solarNoonAltitude degrees; moon.illumination %; times use timezone',
  get_aurora_forecast: 'cloud cover %; darkHours hours; Kp and R-index dimensionless',
  get_metar: 'temperature/dewPoint °C; windSpeed/windGusts m/s; windDirection degrees; visibility m; pressure/altimeter hPa',
};

export function compactDefinition(t: AnyTool) {
  const names = Object.keys(t.outputSchema);
  const schema: Record<string, z.ZodType> = { ...t.schema } as Record<string, z.ZodType>;
  // Keep all original constraints/defaults; shorten only descriptions.
  for (const [key, value] of Object.entries(schema)) {
    if (value.description) schema[key] = value.describe(key === 'location' ? 'Place, lat,lon or ICAO; see tool coverage.' : key);
  }
  schema.fields = z.array(z.enum(names as [string, ...string[]])).min(1).max(names.length).optional()
    .describe('Top-level output fields; provenance, time and safety data always retained.');
  schema.detail = z.enum(['compact', 'full']).default('compact').describe('full includes optional key setup help.');
  return { title: t.title, description: descriptions[t.name] ?? t.title, inputSchema: schema, annotations: t.annotations };
}

/** Validate canonical results even though compact discovery omits outputSchema. Return JSON text once, for clients
 * that do not surface structuredContent to models. Full endpoint remains the automation contract. */
export function compactResult(t: AnyTool, result: ToolResult, args: { fields?: string[]; detail?: string }): ToolResult {
  if (result.isError) return { content: result.content, isError: true };
  const canonical = z.object(t.outputSchema).parse(result.structuredContent);
  const requested = args.fields;
  if (requested?.some((key) => !Object.hasOwn(t.outputSchema, key))) throw new Error('Unknown output field');
  const selected = new Set([...(requested ?? Object.keys(t.outputSchema)), ...contextKeys, ...(safety[t.name] ?? [])]);
  const shape = Object.fromEntries(Object.entries(t.outputSchema).filter(([key]) => selected.has(key)));
  const data = z.object(shape).parse(canonical) as Record<string, unknown>;
  if (t.name === 'get_weather_source_status' && args.detail !== 'full' && data.apiKeys) {
    const keys = data.apiKeys as { missing: { source: string }[] };
    data.apiKeys = { missing: keys.missing.map(({ source }) => source) };
    z.object({ missing: z.array(z.string()) }).parse(data.apiKeys);
  }
  const metadata: Record<string, string> = {};
  if (notes[t.name]) metadata.note = notes[t.name];
  if (units[t.name]) metadata.units = units[t.name];
  // Preserve non-schema caveats without repeating the entire human rendering.
  const caveats = result.content.flatMap((c) => c.text.split('\n')).filter((line) =>
    /^(No (?:tide gauge|road weather station|water temperature station)|Observation data:)/.test(line));
  const payload = { ...data, ...(Object.keys(metadata).length ? { _context: metadata } : {}), ...(caveats.length ? { _notes: [...new Set(caveats)] } : {}) };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
