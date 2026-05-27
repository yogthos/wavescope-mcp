import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdir,
  writeFile,
  rm,
  utimes,
  unlink,
  symlink,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileContext } from "./context.js";
import { ProjectIndex } from "./project.js";
import { diffFileAtRefs, DiffFileMissingError } from "./diff.js";
import { CursorManager } from "./cursor.js";
import { StreamManager } from "./streaming.js";
import { FileCache } from "./file-cache.js";
import {
  handleDiffWaveletContext,
  handleGetCursorContext,
  handleGetCursorImportantPositions,
  handleStreamStart,
} from "./index.js";

// Repo where end-to-end git operations happen
const repoBase = join(tmpdir(), `wavescope-feature-${Date.now()}`);

const sampleTs = `import { foo } from "./foo";

export class Greeter {
  constructor(private name: string) {}

  greet(): string {
    return \`hello, \${this.name}\`;
  }

  shout(): string {
    return this.greet().toUpperCase();
  }
}

export function makeGreeter(name: string): Greeter {
  return new Greeter(name);
}
`;

const sampleTsV2 = `import { foo, bar } from "./foo";

export class Greeter {
  constructor(private name: string, private prefix = "hi") {}

  greet(): string {
    return \`\${this.prefix}, \${this.name}\`;
  }

  shout(): string {
    return this.greet().toUpperCase();
  }

  whisper(): string {
    return this.greet().toLowerCase();
  }
}

export class Farewell {
  constructor(private name: string) {}

  bye(): string {
    return \`bye, \${this.name}\`;
  }
}

export function makeGreeter(name: string): Greeter {
  return new Greeter(name);
}
`;

beforeAll(async () => {
  await mkdir(repoBase, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoBase });
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: repoBase });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repoBase });
});

afterAll(async () => {
  await rm(repoBase, { recursive: true, force: true });
});

describe("E2E: multi-resolution viewing", () => {
  it("query_wavelet_context returns fine, medium, coarse around a class", () => {
    const ctx = new FileContext("Greeter.ts", sampleTs);
    const greeterLine = ctx.lines.findIndex((l) =>
      l.includes("export class Greeter"),
    );
    expect(greeterLine).toBeGreaterThan(0);

    const result = ctx.queryWaveletContext(greeterLine, 300);

    expect(result.center).toBe(greeterLine);
    expect(result.clamped).toBe(false);
    // Fine band shows the actual class line
    expect(result.bands.fine.content).toContain("class Greeter");
    // Medium band exists with meaningful content
    expect(result.bands.medium.content.length).toBeGreaterThan(0);
    // Coarse band exists
    expect(result.bands.coarse.content.length).toBeGreaterThan(0);
    // At least one peak surfaces
    expect(result.waveletPeaks.length).toBeGreaterThan(0);
  });

  it("clamps out-of-range center and reports clampedFrom", () => {
    const ctx = new FileContext("Greeter.ts", sampleTs);
    const result = ctx.queryWaveletContext(99999, 300);
    expect(result.clamped).toBe(true);
    expect(result.clampedFrom).toBe(99999);
    expect(result.center).toBe(ctx.lineCount - 1);
  });

  it("get_summary_at_scale produces non-empty output for the whole file", () => {
    const ctx = new FileContext("Greeter.ts", sampleTs);
    const summary = ctx.getSummaryAtScale(0, ctx.lineCount - 1);
    expect(summary.length).toBeGreaterThan(0);
  });

  it("get_summary_at_scale returns empty for fully-out-of-range request", () => {
    const ctx = new FileContext("Greeter.ts", sampleTs);
    expect(ctx.getSummaryAtScale(99999, 999999)).toBe("");
  });

  it("get_wavelet_coefficients flags clamping when range overflows", () => {
    const ctx = new FileContext("Greeter.ts", sampleTs);
    const result = ctx.getWaveletCoefficients(-5, ctx.lineCount + 10, 8);
    expect(result.clamped).toBe(true);
    expect(result.clampedFrom).toEqual({ start: -5, end: ctx.lineCount + 10 });
    expect(result.coefficients.length).toBeGreaterThan(0);
  });
});

describe("E2E: project-wide indexing", () => {
  it("indexes a small project and returns peaks honoring min_coefficient and limit", async () => {
    const dir = join(tmpdir(), `wavescope-e2e-proj-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, "a.ts"), sampleTs);
      await writeFile(join(dir, "b.ts"), sampleTsV2);
      await writeFile(join(dir, "Rakefile"), "task :default do\n  puts 'rake'\nend\n");
      // .gitignore excludes secrets.ts
      await writeFile(join(dir, ".gitignore"), "secrets.ts\n");
      await writeFile(join(dir, "secrets.ts"), "export const KEY = 'no';\n");

      const project = await ProjectIndex.load(dir);
      const files = project.listFiles().sort();
      expect(files).toContain("a.ts");
      expect(files).toContain("b.ts");
      expect(files).toContain("Rakefile");
      expect(files).not.toContain("secrets.ts");

      // limit + minCoefficient
      const peaks = project.getImportantPositions(0.3, 5);
      expect(peaks.length).toBeLessThanOrEqual(5);
      for (const p of peaks) {
        expect(Math.abs(p.coefficient)).toBeGreaterThanOrEqual(0.3);
        expect(p.label).toContain("("); // label includes filename in parens
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("symlink-deduped projects don't double-index", async () => {
    const dir = join(tmpdir(), `wavescope-e2e-sym-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      const real = join(dir, "real.ts");
      await writeFile(real, sampleTs);
      await symlink(real, join(dir, "alias.ts"));

      const project = await ProjectIndex.load(dir);
      const ts = project.listFiles().filter((f) => f.endsWith(".ts"));
      expect(ts.length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("E2E: diff workflow", () => {
  it("diffs a real change committed to a real repo", async () => {
    const filePath = join(repoBase, "Greeter.ts");
    await writeFile(filePath, sampleTs);
    execFileSync("git", ["add", "Greeter.ts"], { cwd: repoBase });
    execFileSync("git", ["commit", "-q", "-m", "v1"], { cwd: repoBase });

    // Modify and commit v2
    await writeFile(filePath, sampleTsV2);
    execFileSync("git", ["add", "Greeter.ts"], { cwd: repoBase });
    execFileSync("git", ["commit", "-q", "-m", "v2"], { cwd: repoBase });

    const result = await diffFileAtRefs(filePath, "HEAD~1", "HEAD", {
      minCoefficient: 0.3,
      limit: 200,
      window: 3,
    });

    expect(result.beforeLineCount).toBeGreaterThan(0);
    expect(result.afterLineCount).toBeGreaterThan(result.beforeLineCount);
    // v2 adds an entire class (Farewell) plus methods → expect some "added"
    expect(result.diff.summary.added).toBeGreaterThan(0);
    // Summary counts add up to changes.length
    const total =
      result.diff.summary.added +
      result.diff.summary.removed +
      result.diff.summary.shifted +
      result.diff.summary.magnitudeChanged +
      result.diff.summary.unchanged;
    expect(total).toBe(result.diff.changes.length);
  });

  it("treats a newly-created (not in baseRef) file as added (base empty)", async () => {
    const filePath = join(repoBase, "Brand.ts");
    await writeFile(filePath, sampleTs);
    execFileSync("git", ["add", "Brand.ts"], { cwd: repoBase });
    execFileSync("git", ["commit", "-q", "-m", "add Brand"], { cwd: repoBase });

    const result = await diffFileAtRefs(filePath, "HEAD~1", "HEAD", {
      minCoefficient: 0.3,
      limit: 100,
      window: 2,
    });
    expect(result.beforeLineCount).toBe(0);
    expect(result.afterLineCount).toBeGreaterThan(0);
    expect(result.diff.summary.added).toBeGreaterThan(0);
    expect(result.diff.summary.removed).toBe(0);
  });

  it("treats a file deleted in working tree as removed (target empty)", async () => {
    const filePath = join(repoBase, "Brand.ts");
    await unlink(filePath);

    const result = await diffFileAtRefs(filePath, "HEAD", undefined, {
      minCoefficient: 0.3,
      limit: 100,
      window: 2,
    });
    expect(result.beforeLineCount).toBeGreaterThan(0);
    expect(result.afterLineCount).toBe(0);
    expect(result.diff.summary.added).toBe(0);
    expect(result.diff.summary.removed).toBeGreaterThan(0);
  });

  it("throws DiffFileMissingError when file missing on both sides", async () => {
    await expect(
      diffFileAtRefs(join(repoBase, "never_existed.ts"), "HEAD", "HEAD", {
        minCoefficient: 0.3,
        limit: 100,
        window: 2,
      }),
    ).rejects.toBeInstanceOf(DiffFileMissingError);
  });
});

describe("E2E: cursor + file-cache freshness", () => {
  it("cursor context refreshes when file on disk changes", async () => {
    const dir = join(tmpdir(), `wavescope-e2e-cursor-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "live.ts");
    try {
      await writeFile(file, sampleTs);
      const cache = new FileCache(60_000, 50);
      const manager = new CursorManager(60_000, 50);

      const ctx1 = await cache.get(file);
      manager.updateCursor(ctx1, file, 5, 0);
      const first = manager.getProactiveContext(file);
      expect(first).not.toBeNull();

      // Bump mtime forward and write a substantially different version
      const future = new Date(Date.now() + 10_000);
      await utimes(file, future, future);
      await writeFile(file, sampleTsV2);

      // Re-fetch through the file cache (mtime-aware) and pass as freshCtx.
      const ctx2 = await cache.get(file);
      expect(ctx2).not.toBe(ctx1);

      const refreshed = manager.getProactiveContext(file, ctx2);
      expect(refreshed).not.toBeNull();
      // v2 introduces a Farewell class; expect it in one of the bands
      const merged =
        refreshed!.bands.fine.content +
        refreshed!.bands.medium.content +
        refreshed!.bands.coarse.content;
      expect(merged).toMatch(/Farewell|whisper/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cursor important_positions sorts deterministically and uses fresh ctx", async () => {
    const dir = join(tmpdir(), `wavescope-e2e-cursor-pos-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "pos.ts");
    try {
      await writeFile(file, sampleTs);
      const cache = new FileCache(60_000, 50);
      const manager = new CursorManager(60_000, 50);
      const ctx = await cache.get(file);
      manager.updateCursor(ctx, file, 3, 0);

      const a = manager.getCursorImportantPositions(file, 10);
      const b = manager.getCursorImportantPositions(file, 10);
      expect(a).toEqual(b);
      expect(a!.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("E2E: streaming workflow", () => {
  it("start → poll → complete delivers peaks across batches", async () => {
    const dir = join(tmpdir(), `wavescope-e2e-stream-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      // Create a handful of files so we get multiple peaks
      for (let i = 0; i < 6; i++) {
        await writeFile(
          join(dir, `f${i}.ts`),
          `export class C${i} {\n  m${i}(): void {}\n}\n\nexport function g${i}() {}\n`,
        );
      }

      const cache = new FileCache(60_000, 50);
      const manager = new StreamManager(60_000, 20);
      const project = await ProjectIndex.load(dir, cache);
      const streamId = manager.createStream();

      // Producer
      const allPeaks = project.getImportantPositions(0.2, 50);
      const batchSize = 3;
      for (let i = 0; i < allPeaks.length; i += batchSize) {
        const chunk = allPeaks.slice(i, i + batchSize);
        const isLast = i + batchSize >= allPeaks.length;
        manager.appendBatch(streamId, chunk, isLast);
      }
      if (allPeaks.length === 0) {
        manager.appendBatch(streamId, [], true);
      }

      // Consumer
      const collected: typeof allPeaks = [];
      let safety = 100;
      while (safety-- > 0) {
        const r = manager.poll(streamId);
        if (!r) throw new Error("stream vanished");
        if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
        collected.push(...r.peaks);
        if (r.complete) break;
      }
      expect(collected.length).toBe(allPeaks.length);
      manager.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stream_close aborts an in-flight discovery via AbortSignal", async () => {
    const dir = join(tmpdir(), `wavescope-e2e-stream-abort-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      // Populate enough files that the walk has work to do
      for (let i = 0; i < 100; i++) {
        await writeFile(join(dir, `f${i}.ts`), `export const x${i} = ${i};\n`);
      }

      const manager = new StreamManager(60_000, 20);
      const streamId = manager.createStream();
      const aborter = new AbortController();
      manager.registerAborter(streamId, aborter);

      const loadPromise = ProjectIndex.load(dir, undefined, aborter.signal);
      // close the stream → aborter fires → load rejects with AbortError
      manager.close(streamId);

      await expect(loadPromise).rejects.toMatchObject({ name: "AbortError" });
      manager.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

});

describe("E2E: MCP tool wrappers", () => {
  it("diff handler rejects non-absolute path with curated message", async () => {
    const r = await handleDiffWaveletContext({
      file: "relative/path.ts",
      baseRef: "HEAD",
      minCoefficient: 0.3,
      limit: 100,
      window: 2,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/absolute path/);
  });

  it("diff handler curates 'not a git repository' for paths outside any repo", async () => {
    // /tmp itself is not inside a git repo (unless the test runner is weird)
    const r = await handleDiffWaveletContext({
      file: join(tmpdir(), `wavescope-not-a-repo-${Date.now()}.ts`),
      baseRef: "HEAD",
      minCoefficient: 0.3,
      limit: 100,
      window: 2,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not in a git repository/);
  });

  it("diff handler returns DiffFileMissingError message verbatim when both sides absent", async () => {
    const file = join(repoBase, "totally_absent.ts");
    const r = await handleDiffWaveletContext({
      file,
      baseRef: "HEAD",
      targetRef: "HEAD",
      minCoefficient: 0.3,
      limit: 100,
      window: 2,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/does not exist/);
  });

  it("diff handler success returns content[].text with valid JSON", async () => {
    const file = join(repoBase, "wrap-success.ts");
    await writeFile(file, sampleTs);
    execFileSync("git", ["add", "wrap-success.ts"], { cwd: repoBase });
    execFileSync("git", ["commit", "-q", "-m", "wrap"], { cwd: repoBase });

    const r = await handleDiffWaveletContext({
      file,
      baseRef: "HEAD~1",
      targetRef: "HEAD",
      minCoefficient: 0.3,
      limit: 100,
      window: 2,
    });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed).toHaveProperty("diff");
    expect(parsed).toHaveProperty("beforeLineCount");
    expect(parsed).toHaveProperty("afterLineCount");
  });

  it("get_cursor_context handler returns curated error when no cursor registered", async () => {
    const dir = join(tmpdir(), `wavescope-wrap-cursor-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "no-cursor.ts");
    try {
      await writeFile(file, sampleTs);
      const r = await handleGetCursorContext({ file });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/No cursor registered/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("get_cursor_context handler rejects non-absolute path", async () => {
    const r = await handleGetCursorContext({ file: "relative.ts" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/absolute path/);
  });

  it("get_cursor_important_positions handler rejects non-absolute path", async () => {
    const r = await handleGetCursorImportantPositions({
      file: "relative.ts",
      limit: 10,
    });
    expect(r.isError).toBe(true);
  });

  it("stream_start handler rejects non-absolute directory", async () => {
    const r = await handleStreamStart({
      directory: "relative",
      min_coefficient: 0.3,
      limit: 20,
      batch_size: 50,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/absolute path/);
  });

  it("stream_start handler returns 'Directory not found' for nonexistent path", async () => {
    const r = await handleStreamStart({
      directory: join(tmpdir(), `wavescope-no-such-dir-${Date.now()}`),
      min_coefficient: 0.3,
      limit: 20,
      batch_size: 50,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Directory not found/);
  });

  it("stream_start handler returns 'is not a directory' when path is a file", async () => {
    const dir = join(tmpdir(), `wavescope-wrap-notdir-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "actually-a-file.ts");
    try {
      await writeFile(file, "x");
      const r = await handleStreamStart({
        directory: file,
        min_coefficient: 0.3,
        limit: 20,
        batch_size: 50,
      });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/not a directory/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stream_start handler returns stream_id on success", async () => {
    const dir = join(tmpdir(), `wavescope-wrap-ok-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, "ok.ts"), sampleTs);
      const r = await handleStreamStart({
        directory: dir,
        min_coefficient: 0.3,
        limit: 20,
        batch_size: 50,
      });
      expect(r.isError).toBeFalsy();
      const parsed = JSON.parse(r.content[0].text);
      expect(parsed).toHaveProperty("stream_id");
      expect(typeof parsed.stream_id).toBe("string");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("E2E: streaming workflow (continued)", () => {
  it("errored stream surfaces error after draining buffered batches", () => {
    const manager = new StreamManager(60_000, 20);
    const streamId = manager.createStream();

    manager.appendBatch(streamId, [
      { position: 1, coefficient: 0.5, scale: 4, label: "a" },
    ], false);
    manager.markErrored(streamId, "indexing failed");

    const first = manager.poll(streamId);
    expect(first).not.toBeNull();
    if (!first || "error" in first) throw new Error("expected batch");
    expect(first.peaks.length).toBe(1);
    // Buffered batch delivered without claiming complete — error still pending
    expect(first.complete).toBe(false);

    const second = manager.poll(streamId);
    expect(second).toMatchObject({ error: "indexing failed", complete: true });

    manager.shutdown();
  });
});
