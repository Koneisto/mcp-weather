import { z } from 'zod';
import type { tool } from '../types.js';
import { ok, READ_ONLY_LOCAL } from '../utils/result.js';
import { getAllSourceStatuses } from '../utils/aggregator.js';
import { cache } from '../cache.js';

const outputSchema = {
  sources: z.array(z.object({
    name: z.string(),
    status: z.enum(['Ready', 'OK', 'Error', 'Not configured']),
    lastCallTime: z.string().optional(),
    lastError: z.string().optional(),
  })),
  cache: z.object({ entries: z.number(), inflight: z.number(), hits: z.number(), misses: z.number(), hitRate: z.string() }),
};

export const sourceStatusTool: tool<Record<string, never>, typeof outputSchema> = {
  name: 'get_weather_source_status',
  title: 'Weather source status',
  description: 'Check health and cache status of all configured weather data sources. Returns each source\'s configuration state, last call result, and cache hit rate. Useful for debugging when weather data seems stale or incomplete.',
  schema: {},
  outputSchema,
  annotations: READ_ONLY_LOCAL,
  handler: () => {
    const statuses = getAllSourceStatuses();
    const cacheStats = cache.getStats();

    const lines: string[] = ['Weather source status', ''];

    for (const s of statuses) {
      const status = s.configured
        ? (s.lastCallOk === undefined ? 'Ready' : s.lastCallOk ? 'OK' : 'Error')
        : 'Not configured';
      lines.push(`${s.name}: ${status}`);
      if (!s.configured) {
        lines.push(`  Requires API key`);
      }
      if (s.lastCallTime) {
        lines.push(`  Last call: ${s.lastCallTime}`);
      }
      if (s.lastError && !s.lastCallOk) {
        lines.push(`  Error: ${s.lastError}`);
      }
      lines.push('');
    }

    lines.push('Cache statistics');
    lines.push(`  Entries: ${cacheStats.entries}`);
    lines.push(`  In-flight requests: ${cacheStats.inflight}`);
    lines.push(`  Hit rate: ${cacheStats.hitRate} (${cacheStats.hits} hits, ${cacheStats.misses} misses)`);

    const status = (s: (typeof statuses)[number]) =>
      s.configured ? (s.lastCallOk === undefined ? 'Ready' as const : s.lastCallOk ? 'OK' as const : 'Error' as const) : 'Not configured' as const;
    return ok(lines.join('\n'), {
      sources: statuses.map((s) => ({ name: s.name, status: status(s), lastCallTime: s.lastCallTime, lastError: s.lastCallOk ? undefined : s.lastError })),
      cache: cacheStats,
    });
  },
};
