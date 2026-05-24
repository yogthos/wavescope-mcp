import { describe, it, expect, beforeEach } from "vitest";
import { mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __test_getFileContext,
  __test_clearCache,
  __test_cacheSize,
  __test_MAX_CACHE_ENTRIES,
} from "./index.js";

describe("getFileContext — caching", () => {
  beforeEach(() => __test_clearCache());

  it("returns the same instance on repeated calls within TTL", async () => {
    const dir = join(tmpdir(), `wavescope-idx-${Date.now()}-a`);
    await mkdir(dir, { recursive: true });
    try {
      const f = join(dir, "a.ts");
      await writeFile(f, "export const x = 1;\n");
      const ctx1 = await __test_getFileContext(f);
      const ctx2 = await __test_getFileContext(f);
      expect(ctx1).toBe(ctx2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("invalidates cache when the file mtime changes", async () => {
    const dir = join(tmpdir(), `wavescope-idx-${Date.now()}-b`);
    await mkdir(dir, { recursive: true });
    try {
      const f = join(dir, "b.ts");
      await writeFile(f, "export const x = 1;\n");
      const ctx1 = await __test_getFileContext(f);
      // Bump mtime forward by 10s
      const future = new Date(Date.now() + 10_000);
      await utimes(f, future, future);
      await writeFile(f, "export const x = 2;\nexport const y = 3;\n");
      // After writing, mtime is "now" again but content changed
      const ctx2 = await __test_getFileContext(f);
      expect(ctx2).not.toBe(ctx1);
      expect(ctx2.lineCount).toBeGreaterThan(ctx1.lineCount);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats relative and absolute paths to the same file as one cache entry", async () => {
    const dir = join(tmpdir(), `wavescope-idx-${Date.now()}-c`);
    await mkdir(dir, { recursive: true });
    try {
      const f = join(dir, "c.ts");
      await writeFile(f, "export {};\n");
      const ctx1 = await __test_getFileContext(f);
      // Relative path from cwd resolves to the same absolute path
      const ctx2 = await __test_getFileContext(f);
      expect(ctx1).toBe(ctx2);
      expect(__test_cacheSize()).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enforces MAX_CACHE_ENTRIES cap", async () => {
    const dir = join(tmpdir(), `wavescope-idx-${Date.now()}-d`);
    await mkdir(dir, { recursive: true });
    try {
      // Create cap+5 distinct files
      const N = __test_MAX_CACHE_ENTRIES + 5;
      for (let i = 0; i < N; i++) {
        await writeFile(join(dir, `f${i}.ts`), `export const x${i} = ${i};\n`);
      }
      for (let i = 0; i < N; i++) {
        await __test_getFileContext(join(dir, `f${i}.ts`));
      }
      expect(__test_cacheSize()).toBeLessThanOrEqual(__test_MAX_CACHE_ENTRIES);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
