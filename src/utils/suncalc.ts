import SunCalc, { type GetTimesResult } from 'suncalc';
import { formatFixed } from './units.js';

const DEFAULT_TZ = 'Europe/Helsinki';

export interface SunData {
  sunrise: string | null;
  sunset: string | null;
  solarNoon: string | null;
  solarNoonAltitude: number | null;
  nadir: string | null;
  dayLength: string | null;
  dawn: string | null;
  dusk: string | null;
  nauticalDawn: string | null;
  nauticalDusk: string | null;
  nightEnd: string | null;
  night: string | null;
  goldenHourStart: string | null;
  goldenHourEnd: string | null;
  polarCondition: 'midnight-sun' | 'polar-night' | 'white-nights' | null;
}

export interface MoonData {
  phaseName: string;
  illumination: number;
  moonrise: string | null;
  moonset: string | null;
  alwaysUp: boolean;
  alwaysDown: boolean;
}

function formatTime(date: Date, tz: string): string | null {
  if (!date || isNaN(date.getTime())) return null;
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
    hour12: false,
  });
}

function radToDeg(rad: number): number {
  return rad * 180 / Math.PI;
}

/** Convert suncalc azimuth (from south, clockwise, radians) to compass degrees (from north, 0-360) */
function azimuthToCompass(azimuthRad: number): number {
  return ((radToDeg(azimuthRad) + 180) % 360 + 360) % 360;
}

export function phaseToName(phase: number): string {
  if (phase < 0.0625 || phase >= 0.9375) return 'New Moon';
  if (phase < 0.1875) return 'Waxing Crescent';
  if (phase < 0.3125) return 'First Quarter';
  if (phase < 0.4375) return 'Waxing Gibbous';
  if (phase < 0.5625) return 'Full Moon';
  if (phase < 0.6875) return 'Waning Gibbous';
  if (phase < 0.8125) return 'Last Quarter';
  return 'Waning Crescent';
}

function computeDayLength(sunrise: Date, sunset: Date): string | null {
  if (isNaN(sunrise.getTime()) || isNaN(sunset.getTime())) return null;
  const diffMs = sunset.getTime() - sunrise.getTime();
  if (diffMs < 0) return null;
  const hours = Math.floor(diffMs / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);
  return `${hours}h ${minutes}min`;
}

function detectPolarCondition(times: GetTimesResult): 'midnight-sun' | 'polar-night' | 'white-nights' | null {
  const noSunrise = isNaN(times.sunrise.getTime());
  const noSunset = isNaN(times.sunset.getTime());
  const noNight = isNaN(times.night.getTime());
  const noNightEnd = isNaN(times.nightEnd.getTime());

  // If solarNoon altitude > 0 but no sunrise/sunset → midnight sun
  // If solarNoon altitude < 0 and no sunrise/sunset → polar night
  if (noSunrise && noSunset) {
    // Distinguish by checking if solarNoon is valid (it always is)
    // We'll let the caller check altitude; for now mark based on night
    if (noNight && noNightEnd) return 'midnight-sun';
    return 'polar-night';
  }

  // Sun rises and sets but it never gets fully dark
  if (noNight || noNightEnd) return 'white-nights';

  return null;
}

export function getSunData(date: Date, lat: number, lon: number, tz?: string): SunData {
  const timezone = tz ?? DEFAULT_TZ;
  const times = SunCalc.getTimes(date, lat, lon);

  const noonPos = SunCalc.getPosition(times.solarNoon, lat, lon);
  const noonAltDeg = isNaN(times.solarNoon.getTime()) ? null : radToDeg(noonPos.altitude);

  // Refine polar condition using noon altitude
  let polar = detectPolarCondition(times);
  if (polar === 'polar-night' && noonAltDeg !== null && noonAltDeg > 0) {
    polar = 'midnight-sun';
  } else if (polar === 'midnight-sun' && noonAltDeg !== null && noonAltDeg < 0) {
    polar = 'polar-night';
  }

  return {
    sunrise: formatTime(times.sunrise, timezone),
    sunset: formatTime(times.sunset, timezone),
    solarNoon: formatTime(times.solarNoon, timezone),
    solarNoonAltitude: noonAltDeg !== null ? Math.round(noonAltDeg * 10) / 10 : null,
    nadir: formatTime(times.nadir, timezone),
    dayLength: computeDayLength(times.sunrise, times.sunset),
    dawn: formatTime(times.dawn, timezone),
    dusk: formatTime(times.dusk, timezone),
    nauticalDawn: formatTime(times.nauticalDawn, timezone),
    nauticalDusk: formatTime(times.nauticalDusk, timezone),
    nightEnd: formatTime(times.nightEnd, timezone),
    night: formatTime(times.night, timezone),
    goldenHourStart: formatTime(times.goldenHour, timezone),
    goldenHourEnd: formatTime(times.goldenHourEnd, timezone),
    polarCondition: polar,
  };
}

export function getMoonData(date: Date, lat: number, lon: number, tz?: string): MoonData {
  const timezone = tz ?? DEFAULT_TZ;
  const illum = SunCalc.getMoonIllumination(date);
  const moonTimes = SunCalc.getMoonTimes(date, lat, lon);

  return {
    phaseName: phaseToName(illum.phase),
    illumination: Math.round(illum.fraction * 100),
    moonrise: moonTimes.rise ? formatTime(moonTimes.rise, timezone) : null,
    moonset: moonTimes.set ? formatTime(moonTimes.set, timezone) : null,
    alwaysUp: moonTimes.alwaysUp === true,
    alwaysDown: moonTimes.alwaysDown === true,
  };
}

export { azimuthToCompass, radToDeg, formatTime };
