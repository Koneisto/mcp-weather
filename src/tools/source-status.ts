import { z } from 'zod';
import type { tool } from '../types.js';
import { ok, READ_ONLY_LOCAL } from '../utils/result.js';
import { getAllSourceStatuses } from '../utils/aggregator.js';
import { cache } from '../cache.js';
import { quota } from '../quota.js';
import { HOW_TO_SET, KEYS, keyHelpLines } from '../keys.js';

const outputSchema = {
  sources: z.array(z.object({
    name: z.string(),
    status: z.enum(['Ready', 'OK', 'Error', 'Not configured']),
    lastCallTime: z.string().optional(),
    lastError: z.string().optional(),
  })),
  cache: z.object({ entries: z.number(), inflight: z.number(), hits: z.number(), misses: z.number(), hitRate: z.string(), weatherEntries: z.number(), metadataEntries: z.number(), bytes: z.number() }),
  quota: z.array(z.object({ provider: z.string(), accounts: z.number(), used: z.number(), usedHour: z.number(), limitHour: z.number(), remainingHour: z.number(), limitDay: z.number(), remainingDay: z.number(), blocked: z.boolean(), blockedUntil: z.string().optional() })),
  apiKeys: z.object({
    missing: z.array(z.object({ source: z.string(), env: z.string(), signup: z.string() })),
    howToSet: z.string(),
  }),
};

export const sourceStatusTool: tool<Record<string, never>, typeof outputSchema> = {
  name: 'get_weather_source_status',
  title: 'Weather source status',
  description: 'Check health and cache status of all weather data sources, and which optional API keys are missing with where to get them and how to set them. Returns each source\'s configuration state, last call result, and cache hit rate. Useful when weather data seems stale or incomplete, or when the user asks how to add more sources.',
  schema: {},
  outputSchema,
  annotations: READ_ONLY_LOCAL,
  handler: () => {
    const statuses = getAllSourceStatuses();
    const cacheStats = cache.getStats();
    const quotaStats = quota.getStats();

    const lines: string[] = ['Weather source status', ''];

    for (const s of statuses) {
      const status = s.configured
        ? (s.lastCallOk === undefined ? 'Ready' : s.lastCallOk ? 'OK' : 'Error')
        : 'Not configured';
      lines.push(`${s.name}: ${status}`);
      if (!s.configured) {
        const k = KEYS.find((x) => x.source === s.name);
        lines.push(k ? `  Requires API key: set ${k.env} (free key at ${k.signup})` : '  Requires API key');
      }
      if (s.lastCallTime) {
        lines.push(`  Last call: ${s.lastCallTime}`);
      }
      if (s.lastError && !s.lastCallOk) {
        lines.push(`  Error: ${s.lastError}`);
      }
      lines.push('');
    }

    lines.push(...keyHelpLines());
    lines.push('Cache statistics');
    lines.push(`  Entries: ${cacheStats.entries}`);
    lines.push(`  In-flight requests: ${cacheStats.inflight}`);
    lines.push(`  Hit rate: ${cacheStats.hitRate} (${cacheStats.hits} hits, ${cacheStats.misses} misses)`);
    lines.push(`  Bytes: ${cacheStats.bytes}; metadata entries: ${cacheStats.metadataEntries}`);
    lines.push('Upstream safety budgets (this state volume only)');
    for (const q of quotaStats) lines.push(`  ${q.provider}: ${q.remainingHour}/${q.limitHour} hour, ${q.remainingDay}/${q.limitDay} UTC day remaining${q.blocked ? '; blocked' : ''}${q.blockedUntil ? ` until ${q.blockedUntil}` : ''}`);

    const status = (s: (typeof statuses)[number]) =>
      s.configured ? (s.lastCallOk === undefined ? 'Ready' as const : s.lastCallOk ? 'OK' as const : 'Error' as const) : 'Not configured' as const;
    return ok(lines.join('\n'), {
      sources: statuses.map((s) => ({ name: s.name, status: status(s), lastCallTime: s.lastCallTime, lastError: s.lastCallOk ? undefined : s.lastError })),
      cache: cacheStats,
      quota: quotaStats,
      apiKeys: { missing: KEYS.filter((k) => !k.configured).map(({ source, env, signup }) => ({ source, env, signup })), howToSet: HOW_TO_SET },
    });
  },
};
