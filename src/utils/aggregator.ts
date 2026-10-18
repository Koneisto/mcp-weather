import { getMetNorwayStatus } from '../sources/met-norway.js';
import { getWarningsStatus } from '../sources/warnings.js';
import { getSpaceWeatherStatus } from '../sources/space-weather.js';
import type { CurrentWeather, ResolvedLocation, SourceStatus } from '../types.js';
import { config } from '../config.js';
import { degreesToCardinal, formatNum } from './units.js';
import { fetchOpenMeteoCurrent, getOpenMeteoStatus } from '../sources/open-meteo.js';
import { fetchWttrCurrent, getWttrStatus } from '../sources/wttr-in.js';
import { fetchOWMCurrent, getOWMStatus } from '../sources/openweathermap.js';
import { fetchWeatherApiCurrent, getWeatherApiStatus } from '../sources/weatherapi.js';
import { fetchTomorrowCurrent, getTomorrowStatus } from '../sources/tomorrow-io.js';
import { getMetarStatus } from '../sources/metar.js';
import { getFmiStatus } from '../sources/fmi.js';
import { getFmiForecastStatus } from '../sources/fmi-forecast.js';
import { fetchNationalObservation, metNordicAnalysis, getNationalObsStatus, type Observation } from '../sources/national-obs.js';
import { countryOfLocation } from './region.js';
import { getFmiAirQualityStatus } from '../sources/fmi-airquality.js';
import { getMarineStatus } from '../sources/marine.js';
import { getRoadWeatherStatus } from '../sources/road-weather.js';
import { getSykeStatus } from '../sources/syke.js';

const NEARBY_STATION_KM = 50;

export async function aggregateCurrentWeather(
  loc: ResolvedLocation,
  fields?: string[],
): Promise<{ weather: CurrentWeather; sources: string[]; summary: string; observation?: Observation; nearbyObservation?: Observation; analysis?: Observation }> {
  // Measured first: the nearest station of the country's national weather service (FMI, SMHI, DMI, IMO, LHMT, Estonia)
  // within 15 km, then MET Norway's MET Nordic analysis (observations and radar on a 1 km grid) in Finland, Sweden, Norway
  // and Denmark, then the models. Values are filled in this order, so measurements win and models only fill the gaps.
  const country = countryOfLocation(loc);
  const merged: CurrentWeather = {};
  const usedSources: string[] = [];
  // Default essentials avoid spending optional/paid calls to fill rare fields (UV,
  // visibility, snow). Explicit demand can still request those fields.
  const essentials = ['temperature', 'feelsLike', 'humidity', 'pressure', 'windSpeed', 'windDirection', 'weatherDescription', 'precipitation'];
  const weatherFields = new Set([...essentials, 'windGusts', 'cloudCover', 'visibility', 'uvIndex', 'weatherCode', 'dewPoint', 'snowDepth']);
  const requested = fields?.map((f) => f === 'conditions' ? 'weatherDescription' : f).filter((f) => weatherFields.has(f));
  const required = requested?.length ? requested : essentials;
  const satisfied = () => required.every((f) => merged[f as keyof CurrentWeather] != null);
  const merge = (source: string, data: CurrentWeather) => {
    let contributed = false;
    for (const [key, value] of Object.entries(data)) {
      const field = key as keyof CurrentWeather;
      if (value != null && (typeof value !== 'number' || Number.isFinite(value)) && merged[field] == null) {
        // Values from a source already selected for requested fields are cheap to retain.
        (merged as Record<string, unknown>)[field] = value;
        contributed = true;
      }
    }
    if (contributed) usedSources.push(source);
  };
  const obs = await fetchNationalObservation(country, loc.lat, loc.lon);
  if (obs.ok) merge(obs.source, obs.data.weather);
  let analysis: Observation | undefined;
  if (!satisfied() && country && ['FI', 'SE', 'DK'].includes(country)) {
    analysis = (await metNordicAnalysis(loc.lat, loc.lon).catch(() => null)) ?? undefined;
    if (analysis) merge('MET Nordic analysis', analysis.weather);
  }
  const common = ['temperature', 'feelsLike', 'humidity', 'pressure', 'windSpeed', 'windDirection', 'windGusts', 'cloudCover', 'weatherDescription'];
  const providers: Array<{fields: string[]; fetch: () => Promise<import('../types.js').SourceResult<CurrentWeather>>}> = [
    {fields: [...common, 'weatherCode', 'precipitation', 'dewPoint'], fetch: () => fetchOpenMeteoCurrent(loc.lat, loc.lon)},
    {fields: [...common, 'visibility', 'uvIndex', 'precipitation', 'dewPoint'], fetch: () => fetchWttrCurrent(`${loc.lat},${loc.lon}`)},
    ...(config.hasOpenWeatherMap ? [{fields: [...common, 'visibility'], fetch: () => fetchOWMCurrent(loc.lat, loc.lon)}] : []),
    ...(config.hasWeatherApi ? [{fields: [...common, 'visibility', 'uvIndex', 'precipitation', 'dewPoint'], fetch: () => fetchWeatherApiCurrent(loc.lat, loc.lon)}] : []),
    ...(config.hasTomorrowIo ? [{fields: [...common, 'visibility', 'uvIndex', 'precipitation', 'dewPoint'], fetch: () => fetchTomorrowCurrent(loc.lat, loc.lon)}] : []),
  ];
  for (const provider of providers) {
    if (satisfied()) break;
    if (!required.some((f) => merged[f as keyof CurrentWeather] == null && provider.fields.includes(f))) continue;
    try { const result = await provider.fetch(); if (result.ok) merge(result.source, result.data); } catch { /* Continue fallback. */ }
  }

  // No station within 15 km (e.g. Utsjoki, rural lakeside): the analysis or model is used for the point, and the nearest
  // station within 50 km is shown for reference only, without mixing it into the values.
  let nearbyObservation: Observation | undefined;
  if (!obs.ok && country && country !== 'NO') {
    const far = await fetchNationalObservation(country, loc.lat, loc.lon, NEARBY_STATION_KM);
    if (far.ok) nearbyObservation = far.data;
  }
  const summary = buildSummary(merged, loc);
  return { weather: merged, sources: usedSources, summary, observation: obs.ok ? obs.data : undefined, nearbyObservation, analysis };
}

function buildSummary(w: CurrentWeather, loc: ResolvedLocation): string {
  const parts: string[] = [];

  const temp = w.temperature !== undefined ? `${formatNum(w.temperature)} °C` : 'unknown temperature';
  const desc = w.weatherDescription?.toLowerCase() ?? 'unknown conditions';
  parts.push(`Currently ${temp} and ${desc} in ${loc.name}.`);

  if (w.windSpeed !== undefined) {
    const dir = w.windDirection !== undefined ? ` from ${degreesToCardinal(w.windDirection)}` : '';
    const gust = w.windGusts !== undefined ? ` (gusts ${formatNum(w.windGusts)} m/s)` : '';
    parts.push(`Wind ${formatNum(w.windSpeed)} m/s${dir}${gust}.`);
  }

  if (w.humidity !== undefined) {
    parts.push(`Humidity ${formatNum(w.humidity)} %.`);
  }

  if (w.feelsLike !== undefined && w.temperature !== undefined && Math.abs(w.feelsLike - w.temperature) >= 2) {
    parts.push(`Feels like ${formatNum(w.feelsLike)} °C.`);
  }

  return parts.join(' ');
}

export function getAllSourceStatuses(): SourceStatus[] {
  return [
    getMetNorwayStatus(),
    getNationalObsStatus(),
    getWarningsStatus(),
    getSpaceWeatherStatus(),
    getMarineStatus(),
    getRoadWeatherStatus(),
    getSykeStatus(),
    getFmiStatus(),
    getFmiForecastStatus(),
    getFmiAirQualityStatus(),
    getOpenMeteoStatus(),
    getWttrStatus(),
    getMetarStatus(),
    getOWMStatus(),
    getWeatherApiStatus(),
    getTomorrowStatus(),
  ];
}
