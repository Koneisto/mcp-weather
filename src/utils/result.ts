import { safeError } from './errors.js';
import type { ToolAnnotations, ToolResult } from '../types.js';

/** Successful result: the text as before plus the same data as structuredContent (validated against outputSchema). */
export function ok(text: string, data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: data };
}

/** Failed result: the message as text with isError, so clients and models see a failure, not an answer. */
export function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function errorMessage(err: unknown): string {
  return safeError(err instanceof Error ? err.message : err);
}

/** All tools only read public weather data; most call external services. */
export const READ_ONLY_EXTERNAL: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const READ_ONLY_LOCAL: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
