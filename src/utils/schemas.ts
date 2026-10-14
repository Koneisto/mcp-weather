import { z } from 'zod';

/** Shared output schema parts (structuredContent). Units: °C, %, hPa, m/s, degrees, metres, mm, µg/m³. */
export const locationOut = z.object({
  name: z.string(),
  country: z.string().optional(),
  lat: z.number(),
  lon: z.number(),
  icao: z.string().optional(),
}).describe('Resolved location');

export const stationOut = z.object({
  station: z.string(),
  distanceKm: z.number(),
  observationTime: z.string().describe('ISO 8601, UTC'),
});

export const toLocation = (loc: { name: string; country?: string; lat: number; lon: number; icao?: string }) =>
  ({ name: loc.name, country: loc.country, lat: loc.lat, lon: loc.lon, icao: loc.icao });
