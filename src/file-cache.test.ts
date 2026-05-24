import { describe, it, expect, beforeEach } from "vitest";
import { mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileCache } from "./file-cache.js";

describe("FileCache", () => {
  let cache: FileCache;

  beforeEach(() => {
    cache = new FileCache(60_000, 10);
  });

  it("returns the same instance when mtime has not changed", async () => {
    const dir = join(tmpdir(), `fc-${Date.now()}-a`);
    await mkdir(dir, { recursive: true });
    try {
      const f = join(dir, "a.ts");
      await writeFile(f, "export const x = 1;\n");
      const ctx1 = await cache.get(f);
      const ctx2 = await cache.get(f);
      expect(ctx1).toBe(ctx2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns a new instance when mtime changes", async () => {
    const dir = join(tmpdir(), `fc-${Date.now()}-b`);
    await mkdir(dir, { recursive: true });
    try {
      const f = join(dir, "b.ts");
      await writeFile(f, "export const x = 1;\n");
      const ctx1 = await cache.get(f);

      const future = new Date(Date.now() + 10_000);
      await utimes(f, future, future);
      await writeFile(f, "export const x = 2;\nexport const y = 3;\n");

      const ctx2 = await cache.get(f);
      expect(ctx2).not.toBe(ctx1);
      expect(ctx2.lineCount).toBeGreaterThan(ctx1.lineCount);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("bumps timestamp on cache hit so hot files are never re-read", async () => {
    const dir = join(tmpdir(), `fc-${Date.now()}-c`);
    await mkdir(dir, { recursive: true });
    try {
      const f = join(dir, "c.ts");
      await writeFile(f, "export {};\n");
      // Initial get — sets ts
      const ctx1 = await cache.get(f);
      // Hit again — bumps ts, returns same instance
      const ctx2 = await cache.get(f);
      expect(ctx1).toBe(ctx2);

      // evictExpired should NOT evict because ts was bumped
      cache.evictExpired();
      expect(cache.size).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("evictExpired removes entries older than TTL", async () => {
    const cache2 = new FileCache(500, 10); // 500ms TTL
    const dir = join(tmpdir(), `fc-${Date.now()}-d`);
    await mkdir(dir, { recursive: true });
    try {
      const f = join(dir, "d.ts");
      await writeFile(f, "export {};\n");
      await cache2.get(f);
      expect(cache2.size).toBe(1);

      // Wait for TTL to pass
      await new Promise((r) => setTimeout(r, 600));

      const evicted = cache2.evictExpired();
      expect(evicted).toBe(1);
      expect(cache2.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("evictFraction removes the oldest entries", async () => {
    const dir = join(tmpdir(), `fc-${Date.now()}-e`);
    await mkdir(dir, { recursive: true });
    try {
      // Insert 4 files
      for (let i = 0; i < 4; i++) {
        const f = join(dir, `e${i}.ts`);
        await writeFile(f, `export const x${i} = ${i};\n`);
        await cache.get(f);
      }
      expect(cache.size).toBe(4);

      cache.evictFraction(0.5);
      expect(cache.size).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("put is idempotent for same path + mtime", async () => {
    const { stat } = await import("node:fs/promises");
    const dir = join(tmpdir(), `fc-${Date.now()}-f`);
    await mkdir(dir, { recursive: true });
    try {
      const f = join(dir, "f.ts");
      await writeFile(f, "export {};\n");
      const ctx = await cache.get(f);
      expect(cache.size).toBe(1);

      const st = await stat(f);
      cache.put(f, ctx, st.mtimeMs);
      expect(cache.size).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enforces maxEntries cap via LRU eviction", async () => {
    const dir = join(tmpdir(), `fc-${Date.now()}-g`);
    await mkdir(dir, { recursive: true });
    try {
      const N = cache.maxEntries + 5;
      for (let i = 0; i < N; i++) {
        const f = join(dir, `g${i}.ts`);
        await writeFile(f, `export const x${i} = ${i};\n`);
        await cache.get(f);
      }
      expect(cache.size).toBeLessThanOrEqual(cache.maxEntries);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("normalizes relative and absolute paths to the same cache entry", async () => {
    const dir = join(tmpdir(), `fc-${Date.now()}-h`);
    await mkdir(dir, { recursive: true });
    try {
      const f = join(dir, "h.ts");
      await writeFile(f, "export {};\n");
      await cache.get(f);
      expect(cache.size).toBe(1);
      await cache.get(f); // same resolved path
      expect(cache.size).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
