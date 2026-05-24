import { describe, it, expect } from "vitest";
import { readFileAtRef, findGitRoot } from "./git.js";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: __dirname,
  encoding: "utf-8",
}).trim();

describe("readFileAtRef", () => {
  it("reads a file at HEAD", async () => {
    const content = await readFileAtRef(repoRoot, "src/wavelet.ts", "HEAD");
    expect(content).toContain("rickerWavelet");
  });

  it("reads a file at a specific ref by relative commit", async () => {
    const headContent = await readFileAtRef(repoRoot, "src/wavelet.ts", "HEAD");
    const prevContent = await readFileAtRef(
      repoRoot,
      "src/wavelet.ts",
      "HEAD~1",
    );
    // Both should return content (they might be the same if wavelet.ts hasn't changed)
    expect(typeof headContent).toBe("string");
    expect(typeof prevContent).toBe("string");
  });

  it("handles absolute file paths by resolving to repo-relative", async () => {
    const absPath = resolve(repoRoot, "src/wavelet.ts");
    const content = await readFileAtRef(repoRoot, absPath, "HEAD");
    expect(content).toContain("rickerWavelet");
  });

  it("throws for a file that does not exist at the given ref", async () => {
    await expect(
      readFileAtRef(repoRoot, "nonexistent/file.ts", "HEAD"),
    ).rejects.toThrow();
  });

  it("throws for an invalid ref", async () => {
    await expect(
      readFileAtRef(repoRoot, "src/wavelet.ts", "deadbeef"),
    ).rejects.toThrow();
  });
});

describe("findGitRoot", () => {
  it("finds the repo root from a file path", () => {
    const root = findGitRoot(resolve(repoRoot, "src/wavelet.ts"));
    expect(root).toBe(repoRoot);
  });

  it("finds the repo root from a directory path", () => {
    const root = findGitRoot(resolve(repoRoot, "src"));
    expect(root).toBe(repoRoot);
  });

  it("throws for a non-git directory", () => {
    expect(() => findGitRoot("/tmp")).toThrow();
  });
});
