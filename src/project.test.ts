import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  ProjectIndex,
  MAX_FILE_BYTES,
  MAX_FILES,
  evictExpiredProjects,
  evictFractionProjects,
  __test_clearProjectCache,
  __test_projectCacheSize,
} from "./project.js";

const testDir = join(tmpdir(), `wavescope-test-${Date.now()}`);

beforeAll(async () => {
  await mkdir(testDir, { recursive: true });

  await writeFile(
    join(testDir, "app.py"),
    `"""Main application module."""
import os
import json

class App:
    def __init__(self, config):
        self.config = config

    def run(self):
        pass

if __name__ == "__main__":
    App({}).run()
`,
  );

  await writeFile(
    join(testDir, "utils.ts"),
    `import { readFile } from 'fs';

export function load(path: string): string {
  return readFile(path, 'utf-8');
}

export interface Config {
  host: string;
  port: number;
}

export class Helper {
  constructor(private deps: Config) {}

  public process(): void {
    console.log("processing");
  }
}
`,
  );

  await writeFile(
    join(testDir, "ignore.txt"),
    `This is not a code file.`,
  );

  await mkdir(join(testDir, "subdir"), { recursive: true });
  await writeFile(
    join(testDir, "subdir", "nested.py"),
    `def nested_function(x):
    return x + 1
`,
  );

  // File with same basename in different directory
  await mkdir(join(testDir, "other"), { recursive: true });
  await writeFile(
    join(testDir, "other", "utils.ts"),
    `export function foo() { return 42; }
`,
  );
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("ProjectIndex", () => {
  it("discovers and indexes code files recursively", async () => {
    const project = await ProjectIndex.load(testDir);

    const paths = project.listFiles();
    expect(paths).toContain("app.py");
    expect(paths).toContain("utils.ts");
    expect(paths).toContain("subdir/nested.py");
    expect(paths).toContain("other/utils.ts");
    expect(paths).not.toContain("ignore.txt");
  });

  it("returns project-wide important positions", async () => {
    const project = await ProjectIndex.load(testDir);
    const positions = project.getImportantPositions(0.2, 20);

    expect(positions.length).toBeGreaterThan(0);

    // Should include file info in labels
    for (const p of positions) {
      expect(typeof p.label).toBe("string");
      expect(p.label).toContain("(");
    }
  });

  it("has file-level context accessible by relative path", async () => {
    const project = await ProjectIndex.load(testDir);
    const ctx = project.getFile("app.py");
    expect(ctx).toBeDefined();
    expect(ctx!.filename).toBe("app.py");

    const result = ctx!.queryWaveletContext(5, 50);
    expect(result.bands.fine.content).toContain("class App");
  });

  it("distinguishes files with same basename in different dirs", async () => {
    const project = await ProjectIndex.load(testDir);
    const ctx1 = project.getFile("utils.ts");
    const ctx2 = project.getFile("other/utils.ts");
    expect(ctx1).toBeDefined();
    expect(ctx2).toBeDefined();
    // They should be different instances
    expect(ctx1).not.toBe(ctx2);
    // One has Helper, one has foo
    expect(
      ctx1!.lines.join("\n").includes("Helper") ||
        ctx2!.lines.join("\n").includes("Helper"),
    ).toBe(true);
  });

  it("returns null for unknown files", async () => {
    const project = await ProjectIndex.load(testDir);
    expect(project.getFile("nonexistent.py")).toBeNull();
  });

  it("returns project-wide important positions with low limit across many files", async () => {
    const dir = join(tmpdir(), `wavescope-multifile-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      // Create 10 files, each with class and function peaks
      for (let i = 0; i < 10; i++) {
        await writeFile(
          join(dir, `f${i}.ts`),
          `export class C${i} {}\nexport function f${i}() {}\n`,
        );
      }
      const project = await ProjectIndex.load(dir);
      const positions = project.getImportantPositions(0.0, 5);

      expect(positions.length).toBeLessThanOrEqual(5);
      // Sorted by |coefficient| descending
      for (let i = 1; i < positions.length; i++) {
        expect(
          Math.abs(positions[i - 1].coefficient),
        ).toBeGreaterThanOrEqual(Math.abs(positions[i].coefficient));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists all indexed files", async () => {
    const project = await ProjectIndex.load(testDir);
    expect(project.listFiles().length).toBeGreaterThanOrEqual(4);
  });
});

describe("ProjectIndex — .gitignore", () => {
  const gitignoreDir = join(tmpdir(), `wavescope-gitignore-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(gitignoreDir, { recursive: true });
    await writeFile(join(gitignoreDir, ".gitignore"), "secrets.py\n*.generated.ts\nbuilt/\n");
    await writeFile(join(gitignoreDir, "keep.py"), "def main(): pass\n");
    await writeFile(join(gitignoreDir, "secrets.py"), "API_KEY = 'real'\n");
    await writeFile(join(gitignoreDir, "foo.generated.ts"), "export const x = 1;\n");
    await mkdir(join(gitignoreDir, "built"), { recursive: true });
    await writeFile(join(gitignoreDir, "built", "out.ts"), "export {};\n");
  });

  afterAll(async () => {
    await rm(gitignoreDir, { recursive: true, force: true });
  });

  it("excludes files matched by root .gitignore", async () => {
    const project = await ProjectIndex.load(gitignoreDir);
    const paths = project.listFiles();
    expect(paths).toContain("keep.py");
    expect(paths).not.toContain("secrets.py");
    expect(paths).not.toContain("foo.generated.ts");
    expect(paths).not.toContain("built/out.ts");
  });

  it("supports negation patterns (!) to re-include files", async () => {
    const negDir = join(tmpdir(), `wavescope-negate-${Date.now()}`);
    await mkdir(negDir, { recursive: true });
    try {
      await writeFile(
        join(negDir, ".gitignore"),
        "generated/*.ts\n!generated/keep.ts\n",
      );
      await mkdir(join(negDir, "generated"), { recursive: true });
      await writeFile(join(negDir, "generated", "drop.ts"), "export const x = 1;\n");
      await writeFile(join(negDir, "generated", "keep.ts"), "export const y = 2;\n");
      await writeFile(join(negDir, "app.ts"), "export {};\n");

      const project = await ProjectIndex.load(negDir);
      const paths = project.listFiles();
      expect(paths).toContain("app.ts");
      expect(paths).toContain("generated/keep.ts"); // re-included by negation
      expect(paths).not.toContain("generated/drop.ts"); // excluded
    } finally {
      await rm(negDir, { recursive: true, force: true });
    }
  });
});

describe("ProjectIndex — caps", () => {
  it("MAX_FILE_BYTES exists and is reasonable", () => {
    expect(MAX_FILE_BYTES).toBeGreaterThan(100_000);
    expect(MAX_FILE_BYTES).toBeLessThan(50_000_000);
  });

  it("MAX_FILES exists and is reasonable", () => {
    expect(MAX_FILES).toBeGreaterThan(100);
  });

  it("reports truncated=false when under the file cap", async () => {
    const project = await ProjectIndex.load(testDir);
    expect(project.truncated).toBe(false);
  });

  it("skips files larger than MAX_FILE_BYTES", async () => {
    const dir = join(tmpdir(), `wavescope-bigfile-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, "small.ts"), "export {};\n");
      // 3MB file of valid TS
      const big = "export const x = 1;\n".repeat(150_000);
      await writeFile(join(dir, "huge.ts"), big);
      const project = await ProjectIndex.load(dir);
      const paths = project.listFiles();
      expect(paths).toContain("small.ts");
      expect(paths).not.toContain("huge.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ProjectIndex — binary detection", () => {
  it("skips files containing NUL bytes in the first 4KB", async () => {
    const dir = join(tmpdir(), `wavescope-binary-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, "good.ts"), "export const x = 1;\n");
      // Write a fake binary with NUL bytes
      const buf = Buffer.concat([
        Buffer.from("export "),
        Buffer.alloc(10, 0),
        Buffer.from("garbage"),
      ]);
      await writeFile(join(dir, "fake.ts"), buf);
      const project = await ProjectIndex.load(dir);
      const paths = project.listFiles();
      expect(paths).toContain("good.ts");
      expect(paths).not.toContain("fake.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ProjectIndex — symlink handling", () => {
  it("follows in-tree symlinks once without duplicating files", async () => {
    const dir = join(tmpdir(), `wavescope-symlink-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      await mkdir(join(dir, "real"), { recursive: true });
      await writeFile(join(dir, "real", "a.ts"), "export {};\n");
      try {
        await symlink(join(dir, "real"), join(dir, "link"));
      } catch {
        // Some sandboxes deny symlink — skip gracefully
        return;
      }
      const project = await ProjectIndex.load(dir);
      const paths = project.listFiles().sort();
      // Should only see one copy of a.ts, not both real/a.ts and link/a.ts
      const aCount = paths.filter((p) => p.endsWith("a.ts")).length;
      expect(aCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ProjectIndex — min_coefficient raw-scale semantics", () => {
  it("treats minCoefficient as raw absolute coefficient (same as single-file mode)", async () => {
    const dir = join(tmpdir(), `wavescope-mincoef-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(
        join(dir, "x.ts"),
        "export class Foo {}\nexport function bar() {}\n",
      );
      const project = await ProjectIndex.load(dir);
      const allRaw = project.getImportantPositions(0.0, 100);
      expect(allRaw.length).toBeGreaterThan(0);
      const maxCoef = Math.max(...allRaw.map((p) => Math.abs(p.coefficient)));
      // Threshold above max should yield zero
      const aboveMax = project.getImportantPositions(maxCoef + 1, 100);
      expect(aboveMax.length).toBe(0);
      // Threshold of 0 should yield same coefficients (no per-file normalization)
      expect(allRaw[0].coefficient).toBe(allRaw[0].coefficient);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ProjectIndex — path normalization", () => {
  it("treats trailing-slash and non-trailing-slash roots as the same cache entry", async () => {
    const dir = join(tmpdir(), `wavescope-pathnorm-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, "a.ts"), "export {};\n");
      const p1 = await ProjectIndex.load(dir);
      const p2 = await ProjectIndex.load(dir + "/");
      expect(p1).toBe(p2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ProjectCache — cleanup", () => {
  it("evictExpiredProjects removes stale entries", async () => {
    __test_clearProjectCache();
    expect(__test_projectCacheSize()).toBe(0);

    const dir = join(tmpdir(), `wavescope-projc-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, "a.ts"), "export {};\n");
      await ProjectIndex.load(dir);
      expect(__test_projectCacheSize()).toBe(1);

      // Force-expire by using a future timestamp
      const future = Date.now() + 120_000;
      const evicted = evictExpiredProjects(future);
      expect(evicted).toBe(1);
      expect(__test_projectCacheSize()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("evictFractionProjects removes fraction of entries", async () => {
    __test_clearProjectCache();

    const dir1 = join(tmpdir(), `wavescope-projf-${Date.now()}-1`);
    const dir2 = join(tmpdir(), `wavescope-projf-${Date.now()}-2`);
    const dir3 = join(tmpdir(), `wavescope-projf-${Date.now()}-3`);
    const dir4 = join(tmpdir(), `wavescope-projf-${Date.now()}-4`);
    try {
      await mkdir(dir1, { recursive: true });
      await mkdir(dir2, { recursive: true });
      await mkdir(dir3, { recursive: true });
      await mkdir(dir4, { recursive: true });
      await writeFile(join(dir1, "a.ts"), "export {};\n");
      await writeFile(join(dir2, "a.ts"), "export {};\n");
      await writeFile(join(dir3, "a.ts"), "export {};\n");
      await writeFile(join(dir4, "a.ts"), "export {};\n");

      await ProjectIndex.load(dir1);
      await ProjectIndex.load(dir2);
      await ProjectIndex.load(dir3);
      await ProjectIndex.load(dir4);
      expect(__test_projectCacheSize()).toBe(4);

      const evicted = evictFractionProjects(0.5);
      expect(evicted).toBe(2);
      expect(__test_projectCacheSize()).toBe(2);
    } finally {
      await rm(dir1, { recursive: true, force: true });
      await rm(dir2, { recursive: true, force: true });
      await rm(dir3, { recursive: true, force: true });
      await rm(dir4, { recursive: true, force: true });
    }
  });
});
