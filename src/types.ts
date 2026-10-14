import type { z } from 'zod';

/** Tool result: text for people and models, structuredContent matching the tool's outputSchema, isError on failure. */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type tool<Args extends z.ZodRawShape, Out extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  schema: Args;
  outputSchema: Out;
  annotations: ToolAnnotations;
  handler: (args: z.infer<z.ZodObject<Args>>, extra: unknown) => Promise<ToolResult> | ToolResult;
};

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ResolvedLocation {
  lat: number;
  lon: number;
  name: string;
  country?: string;
  icao?: string;
}

export interface CurrentWeather {
  temperature?: number;
  feelsLike?: number;
  humidity?: number;
  pressure?: number;
  windSpeed?: number;
  windDirection?: number;
  windGusts?: number;
  cloudCover?: number;
  visibility?: number;
  uvIndex?: number;
  weatherCode?: number;
  weatherDescription?: string;
  precipitation?: number;
  dewPoint?: number;
}

export interface DailyForecast {
  date: string;
  tempMax?: number;
  tempMin?: number;
  weatherCode?: number;
  weatherDescription?: string;
  precipitationSum?: number;
  precipitationProbability?: number;
  windSpeedMax?: number;
  windDirection?: number;
  uvIndexMax?: number;
  sunrise?: string;
  sunset?: string;
}

export interface MetarData {
  raw: string;
  station: string;
  observationTime?: string;
  temperature?: number;
  dewPoint?: number;
  windSpeed?: number;
  windDirection?: number;
  windGusts?: number;
  visibility?: number;
  /** visibility is a lower bound ("9999", CAVOK, "P6SM") */
  visibilityOrMore?: boolean;
  altimeter?: number;
  pressure?: number;
  flightCategory?: string;
  clouds?: string;
  weather?: string;
}

export interface AirQualityData {
  aqi?: number;
  aqiCategory?: string;
  pm25?: number;
  pm10?: number;
  no2?: number;
  o3?: number;
  so2?: number;
  co?: number;
}

export type SourceResult<T> =
  | { ok: true; data: T; source: string }
  | { ok: false; error: string; source: string };

export interface SourceStatus {
  name: string;
  configured: boolean;
  available: boolean;
  lastCallTime?: string;
  lastCallOk?: boolean;
  lastError?: string;
}
