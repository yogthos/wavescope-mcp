import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { FileContext } from "./context.js";

interface CacheEntry {
  ctx: FileContext;
  ts: number;
  mtimeMs: number;
}

/**
 * Shared file-level cache with mtime-based validity and TTL-based expiry.
 *
 * Unlike a pure TTL cache, mtime is the authoritative freshness check:
 * - If mtime matches, the entry is always valid (timestamp bumped on hit
 *   to prevent unnecessary re-read of unchanged hot files).
 * - TTL is only used by the periodic `evictExpired()` sweep to free memory
 *   for idle entries.
 * - LRU eviction kicks in when the entry cap is exceeded.
 */
export class FileCache {
  private cache = new Map<string, CacheEntry>();

  constructor(
    readonly ttl: number = 60_000,
    readonly maxEntries: number = 200,
  ) {}

  private norm(path: string): string {
    return resolve(path);
  }

  /**
   * Return a {@link FileContext} for `filePath`, reusing the cached
   * instance when the file has not been modified on disk.
   *
   * Timestamps are bumped on every hit so that hot files never trigger
   * unnecessary re-read / re-computation.
   */
  async get(filePath: string): Promise<FileContext> {
    const key = this.norm(filePath);
    const st = await stat(key);
    const mtimeMs = st.mtimeMs;
    const cached = this.cache.get(key);

    if (cached && cached.mtimeMs === mtimeMs) {
      cached.ts = Date.now();
      return cached.ctx;
    }

    const content = await readFile(key, "utf-8");
    const ctx = new FileContext(key, content);
    this.cache.set(key, { ctx, ts: Date.now(), mtimeMs });
    this.evictLRU();
    return ctx;
  }

  /**
   * Store a pre-constructed {@link FileContext} in the cache.
   * Used by {@link ProjectIndex} to populate the shared cache during
   * file discovery so that later file-level queries hit the same instance.
   */
  put(filePath: string, ctx: FileContext, mtimeMs: number): void {
    const key = this.norm(filePath);
    const existing = this.cache.get(key);
    if (existing && existing.mtimeMs === mtimeMs) return;
    this.cache.set(key, { ctx, ts: Date.now(), mtimeMs });
    this.evictLRU();
  }

  /**
   * Remove all entries whose timestamp is older than TTL.
   * Returns the count of evicted entries.
   */
  evictExpired(now: number = Date.now()): number {
    let count = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.ts >= this.ttl) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Evict the oldest `fraction` of entries (0-1).
   * Returns the count of evicted entries.
   */
  evictFraction(fraction: number): number {
    if (this.cache.size === 0) return 0;
    const capped = Math.min(Math.max(fraction, 0), 1);
    const toEvict = Math.max(1, Math.floor(this.cache.size * capped));
    const entries = [...this.cache.entries()].sort(
      (a, b) => a[1].ts - b[1].ts,
    );
    let count = 0;
    for (let i = 0; i < toEvict && i < entries.length; i++) {
      this.cache.delete(entries[i][0]);
      count++;
    }
    return count;
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  private evictLRU(): void {
    if (this.cache.size > this.maxEntries) {
      const entries = [...this.cache.entries()].sort(
        (a, b) => a[1].ts - b[1].ts,
      );
      const toDelete = entries.slice(0, this.cache.size - this.maxEntries);
      for (const [key] of toDelete) this.cache.delete(key);
    }
  }
}
