import type { CurrentWeather, ResolvedLocation, SourceStatus } from '../types.js';
import { config } from '../config.js';
import { degreesToCardinal, formatNum } from './units.js';
import { fetchOpenMeteoCurrent, getOpenMeteoStatus } from '../sources/open-meteo.js';
import { fetchWttrCurrent, getWttrStatus } from '../sources/wttr-in.js';
import { fetchOWMCurrent, getOWMStatus } from '../sources/openweathermap.js';
import { fetchWeatherApiCurrent, getWeatherApiStatus } from '../sources/weatherapi.js';
import { fetchTomorrowCurrent, getTomorrowStatus } from '../sources/tomorrow-io.js';
import { getMetarStatus } from '../sources/metar.js';

export async function aggregateCurrentWeather(
  loc: ResolvedLocation,
): Promise<{ weather: CurrentWeather; sources: string[]; summary: string }> {
  const results = await Promise.allSettled([
    fetchOpenMeteoCurrent(loc.lat, loc.lon),
    fetchWttrCurrent(loc.name),
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
  }

  const summary = buildSummary(merged, loc);
  return { weather: merged, sources: usedSources, summary };
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
    getOpenMeteoStatus(),
    getWttrStatus(),
    getMetarStatus(),
    getOWMStatus(),
    getWeatherApiStatus(),
    getTomorrowStatus(),
  ];
}
