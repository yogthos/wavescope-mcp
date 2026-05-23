import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { ProjectIndex } from "./project.js";

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

  it("lists all indexed files", async () => {
    const project = await ProjectIndex.load(testDir);
    expect(project.listFiles().length).toBeGreaterThanOrEqual(4);
  });
});
