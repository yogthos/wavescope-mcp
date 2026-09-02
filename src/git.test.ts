import { describe, it, expect } from "vitest";
import { readFileAtRef, findGitRoot } from "./git.js";
import { execFileSync, spawnSync } from "node:child_process";
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

  it("rejects refs starting with '-' before invoking git", async () => {
    await expect(
      readFileAtRef(repoRoot, "src/wavelet.ts", "--no-such-flag"),
    ).rejects.toThrow("must not start with '-'");
  });

  it("rejects file paths that escape the repository", async () => {
    // resolve to an absolute path outside the repo
    const outsideFile = resolve("/tmp", "outside.txt");
    await expect(
      readFileAtRef(repoRoot, outsideFile, "HEAD"),
    ).rejects.toThrow("outside the repository");
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

  it("finds the repo root when passed the repo root directly", () => {
    const root = findGitRoot(repoRoot);
    expect(root).toBe(repoRoot);
  });
});

describe("findGitRoot — stderr hygiene", () => {
  it("probes for a repo without leaking git's error output to stderr", () => {
    // findGitRoot deliberately probes two directories and swallows the
    // failure, but execFileSync inherits stderr by default, so every probe
    // outside a repository printed a raw "fatal: not a git repository" line.
    // This is an MCP server whose stderr is the log channel, so those lines
    // surfaced as spurious errors in user logs for any file outside a repo.
    // Asserted in a child process because stderr is inherited at the fd
    // level and cannot be intercepted from inside this one.
    const script = [
      `import { findGitRoot } from ${JSON.stringify(
        new URL("./git.ts", import.meta.url).pathname,
      )};`,
      `try { findGitRoot("/"); } catch { /* expected outside a repo */ }`,
    ].join("\n");

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "-e", script],
      // cwd must be inside the project so `tsx` resolves. It does not
      // affect the probe: findGitRoot passes an explicit cwd of "/" to git.
      { encoding: "utf-8", cwd: resolve(__dirname, "..") },
    );

    expect(child.stderr).toBe("");
  });

  it("still throws when the path is not inside a repository", () => {
    expect(() => findGitRoot("/")).toThrow(/Not a git repository/);
  });
});
