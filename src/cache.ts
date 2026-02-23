import { config } from './config.js';

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
}

class Cache {
  private store = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;

  async getOrFetch<T>(key: string, fetcher: () => Promise<T>, ttlMs?: number): Promise<T> {
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      this.hits++;
      // LRU: move to end
      this.store.delete(key);
      this.store.set(key, existing);
      return existing.value as T;
    }

    this.misses++;

    // Stampede prevention: reuse in-flight request
    const pending = this.inflight.get(key);
    if (pending) {
      return pending as Promise<T>;
    }

    const promise = fetcher().then((value) => {
      this.inflight.delete(key);
      const ttl = ttlMs ?? config.cacheTtlMs;
      this.store.set(key, { value, expiresAt: Date.now() + ttl });
      this.evictIfNeeded();
      return value;
    }).catch((err) => {
      this.inflight.delete(key);
      throw err;
    });

    this.inflight.set(key, promise);
    return promise;
  }

  private evictIfNeeded(): void {
    while (this.store.size > config.cacheMaxEntries) {
      // Delete oldest (first inserted)
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) {
        this.store.delete(firstKey);
      }
    }
  }

  getStats(): { entries: number; inflight: number; hits: number; misses: number; hitRate: string } {
    const total = this.hits + this.misses;
    return {
      entries: this.store.size,
      inflight: this.inflight.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(1).replace('.', ',')} %` : 'N/A',
    };
  }
}

export const cache = new Cache();
