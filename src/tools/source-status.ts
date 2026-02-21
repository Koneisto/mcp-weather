import type { tool } from '../types.js';
import { getAllSourceStatuses } from '../utils/aggregator.js';
import { cache } from '../cache.js';

export const sourceStatusTool: tool<Record<string, never>> = {
  name: 'get_weather_source_status',
  description: 'Check the status of all configured weather data sources, their health, and cache statistics.',
  schema: {},
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

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
};
