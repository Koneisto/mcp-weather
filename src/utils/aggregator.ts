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
): Promise<{ weather: CurrentWeather; sources: string[]; summary: string; observation?: Observation; nearbyObservation?: Observation; analysis?: Observation }> {
  // Measured first: the nearest station of the country's national weather service (FMI, SMHI, DMI, IMO, LHMT, Estonia)
  // within 15 km, then MET Norway's MET Nordic analysis (observations and radar on a 1 km grid) in Finland, Sweden, Norway
  // and Denmark, then the models. Values are filled in this order, so measurements win and models only fill the gaps.
  const country = countryOfLocation(loc);
  const obsPromise = fetchNationalObservation(country, loc.lat, loc.lon);
  // Norway: the analysis already is the national observation (Frost needs a client id), so it is not fetched twice
  const anaPromise = country && ['FI', 'SE', 'DK'].includes(country)
    ? metNordicAnalysis(loc.lat, loc.lon).catch(() => null) : Promise.resolve(null);
  const results = await Promise.allSettled([
    obsPromise.then((r) => (r.ok ? { ok: true as const, source: r.source, data: r.data.weather } : null)),
    anaPromise.then((a) => (a ? { ok: true as const, source: 'MET Nordic analysis', data: a.weather } : null)),
    fetchOpenMeteoCurrent(loc.lat, loc.lon),
    fetchWttrCurrent(`${loc.lat},${loc.lon}`),   // coordinates: wttr.in's own name search failed for e.g. "Stockholm/Arlanda Arpt (ESSA)"
    config.hasOpenWeatherMap ? fetchOWMCurrent(loc.lat, loc.lon) : Promise.resolve(null),
    config.hasWeatherApi ? fetchWeatherApiCurrent(loc.lat, loc.lon) : Promise.resolve(null),
    config.hasTomorrowIo ? fetchTomorrowCurrent(loc.lat, loc.lon) : Promise.resolve(null),
  ]);

  const merged: CurrentWeather = {};
  const usedSources: string[] = [];

  for (const result of results) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    const r = result.value;
    if (!r.ok) continue;

    usedSources.push(r.source);
    const d = r.data;

    // Fill nulls from secondary sources
    merged.temperature ??= d.temperature;
    merged.feelsLike ??= d.feelsLike;
    merged.humidity ??= d.humidity;
    merged.pressure ??= d.pressure;
    merged.windSpeed ??= d.windSpeed;
    merged.windDirection ??= d.windDirection;
    merged.windGusts ??= d.windGusts;
    merged.cloudCover ??= d.cloudCover;
    merged.visibility ??= d.visibility;
    merged.uvIndex ??= d.uvIndex;
    merged.weatherCode ??= d.weatherCode;
    merged.weatherDescription ??= d.weatherDescription;
    merged.precipitation ??= d.precipitation;
    merged.dewPoint ??= d.dewPoint;
    merged.snowDepth ??= d.snowDepth;
  }

  const obs = await obsPromise, analysis = (await anaPromise) ?? undefined;
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
