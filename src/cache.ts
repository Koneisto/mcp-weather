import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, constants } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
  bytes: number;
}

export class Cache {
  private store = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<unknown>>();
  private metadata = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private persistTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly maxEntries = config.cacheMaxEntries, private readonly maxInflight = config.cacheMaxInflight,
    private readonly options: { maxBytes?: number; metadataMaxEntries?: number; metadataMaxBytes?: number; persistPath?: string; persistIntervalMs?: number } = {}) {
    if (options.persistPath) this.restore();
  }

  private isMetadata(key: string): boolean {
    return /^(geocode:|station:|road:stations$|syke:(stations|normal|offset):|obs:[^:]+:stations$|marine:[^:]+:stations$)/.test(key);
  }
  private bucket(key: string) { return this.isMetadata(key) ? this.metadata : this.store; }
  // Only explicitly public, JSON-native datasets survive restart. Never persist warnings,
  // arbitrary caller keys, URLs or credential-bearing objects.
  private reusable(key: string, value: unknown): boolean {
    if (!/^(geocode:|station:|openmeteo:|syke:(stations|normal|offset):|road:stations$|obs:[^:]+:stations$|marine:[^:]+:stations$)/.test(key)) return false;
    try {
      const text = JSON.stringify([key, value]);
      return !/(https?:|api[_-]?key|token|authorization|password|secret)/i.test(text);
    } catch { return false; }
  }
  private restore(): void {
    let fd: number | undefined;
    try {
      fd = openSync(this.options.persistPath!, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) || st.size > this.byteLimit(false) + this.byteLimit(true) + 65536) return;
      const rows: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (!Array.isArray(rows)) return;
      for (const row of rows.slice(-(this.maxEntries + (this.options.metadataMaxEntries ?? config.metadataCacheMaxEntries)))) {
        if (!Array.isArray(row) || row.length !== 2) continue;
        const [key, entry] = row;
        if (typeof key !== 'string' || !entry || typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now() || entry.expiresAt > Date.now() + 7 * 86400000 || !this.reusable(key, entry.value)) continue;
        const bytes = Buffer.byteLength(JSON.stringify([key, entry.value])) + 64;
        this.bucket(key).set(key, {value: entry.value, expiresAt: entry.expiresAt, bytes});
        this.evictIfNeeded();
      }
    } catch { /* Missing or corrupt state is a cache miss. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  private schedulePersist(): void {
    if (!this.options.persistPath) return;
    if (!this.options.persistIntervalMs) { this.flush(); return; }
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => { this.persistTimer = undefined; this.flush(); }, this.options.persistIntervalMs);
      this.persistTimer.unref();
    }
  }
  /** Flush optional restart data. Data-cache persistence never controls quota accounting. */
  flush(): void {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = undefined; }
    if (!this.options.persistPath) return;
    const temp = `${this.options.persistPath}.${process.pid}.tmp`;
    try {
      const rows = [...this.store, ...this.metadata].filter(([k, e]) => e.expiresAt > Date.now() && this.reusable(k, e.value));
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify(rows)); } finally { closeSync(fd); }
      renameSync(temp, this.options.persistPath);
    } catch { try { unlinkSync(temp); } catch {} /* Persistence is optional, never change freshness. */ }
  }
  private byteLimit(metadata: boolean): number {
    return metadata ? (this.options.metadataMaxBytes ?? config.metadataCacheMaxBytes) : (this.options.maxBytes ?? config.cacheMaxBytes);
  }

  async getOrFetch<T>(key: string, fetcher: () => Promise<T>, ttlMs?: number): Promise<T> {
    const bucket = this.bucket(key);
    const existing = bucket.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      this.hits++;
      // LRU: move to end
      bucket.delete(key);
      bucket.set(key, existing);
      return existing.value as T;
    }

    if (existing) bucket.delete(key);
    this.misses++;

    // Stampede prevention: reuse in-flight request
    const pending = this.inflight.get(key);
    if (pending) {
      return pending as Promise<T>;
    }

    if (this.inflight.size >= this.maxInflight) throw new Error('Cache fetch capacity reached; retry later');

    const promise = Promise.resolve().then(fetcher).then((value) => {
      this.inflight.delete(key);
      const ttl = ttlMs ?? config.cacheTtlMs;
      let bytes = Infinity;
      try { bytes = Buffer.byteLength(JSON.stringify([key, value])) + 64; } catch { /* Non-JSON values are not cacheable. */ }
      if (ttl > 0 && Number.isFinite(ttl) && bytes <= this.byteLimit(this.isMetadata(key))) {
        bucket.set(key, { value, expiresAt: Date.now() + ttl, bytes });
        this.evictIfNeeded();
        if (this.options.persistPath && this.reusable(key, value)) this.schedulePersist();
      }
      return value;
    }).catch((err) => {
      this.inflight.delete(key);
      throw err;
    });

    this.inflight.set(key, promise);
    return promise;
  }

  private evictIfNeeded(): void {
    for (const [bucket, maxEntries, maxBytes] of [
      [this.store, this.maxEntries, this.byteLimit(false)],
      [this.metadata, this.options.metadataMaxEntries ?? config.metadataCacheMaxEntries, this.byteLimit(true)],
    ] as const) {
      for (const [key, entry] of bucket) if (entry.expiresAt <= Date.now()) bucket.delete(key);
      let bytes = [...bucket.values()].reduce((n, e) => n + e.bytes, 0);
      while (bucket.size > maxEntries || bytes > maxBytes) {
        const key = bucket.keys().next().value;
        if (key === undefined) break;
        bytes -= bucket.get(key)!.bytes;
        bucket.delete(key);
      }
    }
  }

  getStats() {
    const total = this.hits + this.misses;
    return {
      entries: this.store.size + this.metadata.size,
      weatherEntries: this.store.size, metadataEntries: this.metadata.size,
      bytes: [...this.store.values(), ...this.metadata.values()].reduce((n, e) => n + e.bytes, 0),
      inflight: this.inflight.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(1).replace('.', ',')} %` : 'N/A',
    };
  }
}

let persistPath: string | undefined;
try {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  // A private cache directory is required for persisted location queries.
  const fd = openSync(config.stateDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { const st = fstatSync(fd); if ((st.mode & 0o077) === 0 && (!process.getuid || st.uid === process.getuid())) persistPath = join(config.stateDir, 'datasets-v1.json'); } finally { closeSync(fd); }
} catch { /* In-memory caching remains available. */ }
export const cache = new Cache(undefined, undefined, { persistPath, persistIntervalMs: 1000 });
process.once('exit', () => cache.flush());
