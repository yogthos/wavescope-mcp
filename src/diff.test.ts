import { describe, it, expect } from "vitest";
import { diffPeaks, diffFileContext, diffFileAtRefs, FileDiffResult } from "./diff.js";
import { readFileAtRef, tryReadFileAtRef, findGitRoot } from "./git.js";
import { FileContext } from "./context.js";
import { Peak } from "./wavelet.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: __dirname,
  encoding: "utf-8",
}).trim();

function makePeak(
  position: number,
  coefficient: number,
  scale: number = 1,
  label?: string,
): Peak {
  return { position, coefficient, scale, label };
}

describe("diffPeaks", () => {
  it("returns empty diff for identical peak sets", () => {
    const before = [makePeak(10, 0.9), makePeak(20, 0.8)];
    const after = [makePeak(10, 0.9), makePeak(20, 0.8)];
    const diff = diffPeaks(before, after);

    expect(diff.summary.unchanged).toBe(2);
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
    expect(diff.summary.shifted).toBe(0);
    expect(diff.summary.magnitudeChanged).toBe(0);

    const kinds = diff.changes.map((c) => c.kind);
    expect(kinds).toEqual(["unchanged", "unchanged"]);
  });

  it("detects added peaks", () => {
    const before = [makePeak(10, 0.9)];
    const after = [makePeak(10, 0.9), makePeak(30, 0.7)];
    const diff = diffPeaks(before, after);

    expect(diff.summary.added).toBe(1);
    expect(diff.summary.unchanged).toBe(1);

    const added = diff.changes.find((c) => c.kind === "added");
    expect(added).toBeDefined();
    expect(added!.after!.position).toBe(30);
    expect(added!.before).toBeNull();
  });

  it("detects removed peaks", () => {
    const before = [makePeak(10, 0.9), makePeak(30, 0.7)];
    const after = [makePeak(10, 0.9)];
    const diff = diffPeaks(before, after);

    expect(diff.summary.removed).toBe(1);
    expect(diff.summary.unchanged).toBe(1);

    const removed = diff.changes.find((c) => c.kind === "removed");
    expect(removed).toBeDefined();
    expect(removed!.before!.position).toBe(30);
    expect(removed!.after).toBeNull();
  });

  it("detects shifted peaks (moved within window)", () => {
    const before = [makePeak(10, 0.9)];
    const after = [makePeak(12, 0.9)];
    const diff = diffPeaks(before, after, 3);

    expect(diff.summary.shifted).toBe(1);

    const shifted = diff.changes.find((c) => c.kind === "shifted");
    expect(shifted).toBeDefined();
    expect(shifted!.before!.position).toBe(10);
    expect(shifted!.after!.position).toBe(12);
  });

  it("treats far-away peaks as remove+add, not shifted", () => {
    const before = [makePeak(10, 0.9)];
    const after = [makePeak(50, 0.9)];
    const diff = diffPeaks(before, after, 3);

    expect(diff.summary.removed).toBe(1);
    expect(diff.summary.added).toBe(1);
    expect(diff.summary.shifted).toBe(0);
  });

  it("detects magnitude changes at same position", () => {
    const before = [makePeak(10, 0.5)];
    const after = [makePeak(10, 1.2)];
    const diff = diffPeaks(before, after);

    expect(diff.summary.magnitudeChanged).toBe(1);

    const changed = diff.changes.find((c) => c.kind === "magnitudeChanged");
    expect(changed).toBeDefined();
    expect(changed!.before!.coefficient).toBe(0.5);
    expect(changed!.after!.coefficient).toBe(1.2);
  });

  it("treats near-identical coefficients as unchanged (floating-point tolerance)", () => {
    const before = [makePeak(10, 0.5)];
    const after = [makePeak(10, 0.5 + 1e-15)];
    const diff = diffPeaks(before, after);

    expect(diff.summary.magnitudeChanged).toBe(0);
    expect(diff.summary.unchanged).toBe(1);
  });

  it("preserves labels through the diff", () => {
    const before = [makePeak(10, 0.9, 2, "class Foo")];
    const after = [makePeak(10, 0.9, 2, "class Foo"), makePeak(30, 0.7, 4, "def bar")];
    const diff = diffPeaks(before, after);

    const unchanged = diff.changes.find((c) => c.kind === "unchanged");
    expect(unchanged?.before?.label).toBe("class Foo");
    expect(unchanged?.after?.label).toBe("class Foo");

    const added = diff.changes.find((c) => c.kind === "added");
    expect(added?.before).toBeNull();
    expect(added?.after?.label).toBe("def bar");
  });

  it("handles empty before peaks", () => {
    const before: Peak[] = [];
    const after = [makePeak(10, 0.9), makePeak(20, 0.8)];
    const diff = diffPeaks(before, after);

    expect(diff.summary.added).toBe(2);
    expect(diff.summary.unchanged).toBe(0);
    expect(diff.changes.every((c) => c.kind === "added")).toBe(true);
  });

  it("handles empty after peaks", () => {
    const before = [makePeak(10, 0.9), makePeak(20, 0.8)];
    const after: Peak[] = [];
    const diff = diffPeaks(before, after);

    expect(diff.summary.removed).toBe(2);
    expect(diff.summary.unchanged).toBe(0);
    expect(diff.changes.every((c) => c.kind === "removed")).toBe(true);
  });

  it("handles both empty", () => {
    const diff = diffPeaks([], []);
    expect(diff.changes).toEqual([]);
    expect(diff.summary.unchanged).toBe(0);
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
  });

  it("breaks distance ties by coefficient closeness, not input order (R3.4)", () => {
    // both before peaks are exactly 2 lines away from after[12]
    // before[10] has coef 0.5, before[14] has coef 0.9
    // after[12] has coef 0.9 → before[14] is the better match by coef
    const before = [makePeak(10, 0.5), makePeak(14, 0.9)];
    const after = [makePeak(12, 0.9)];
    const diff = diffPeaks(before, after, 3);

    const shifted = diff.changes.find((c) => c.kind === "shifted");
    expect(shifted).toBeDefined();
    expect(shifted!.before!.position).toBe(14);

    const removed = diff.changes.find((c) => c.kind === "removed");
    expect(removed).toBeDefined();
    expect(removed!.before!.position).toBe(10);
  });

  it("tiebreak is stable when before is reordered", () => {
    const after = [makePeak(12, 0.9)];
    const a = diffPeaks([makePeak(10, 0.5), makePeak(14, 0.9)], after, 3);
    const b = diffPeaks([makePeak(14, 0.9), makePeak(10, 0.5)], after, 3);
    // The "winning" before should be 14 in both orderings
    expect(a.changes.find((c) => c.kind === "shifted")!.before!.position).toBe(14);
    expect(b.changes.find((c) => c.kind === "shifted")!.before!.position).toBe(14);
  });

  it("matches closest peak when multiple candidates exist within window", () => {
    const before = [makePeak(10, 0.9), makePeak(15, 0.3)];
    const after = [makePeak(12, 0.85)];
    const diff = diffPeaks(before, after, 5);

    // Should match after[12] with before[10] (closest), not before[15]
    expect(diff.summary.shifted).toBe(1);
    expect(diff.summary.removed).toBe(1);

    const shifted = diff.changes.find((c) => c.kind === "shifted");
    expect(shifted!.before!.position).toBe(10);
    expect(shifted!.after!.position).toBe(12);

    const removed = diff.changes.find((c) => c.kind === "removed");
    expect(removed!.before!.position).toBe(15);
  });

  it("uses default window of 2", () => {
    const before = [makePeak(10, 0.9)];
    const after = [makePeak(11, 0.9)];
    const diff = diffPeaks(before, after);

    expect(diff.summary.shifted).toBe(1);
  });

  it("returns changes sorted by position (before or after)", () => {
    const before = [makePeak(5, 0.5), makePeak(30, 0.9)];
    const after = [makePeak(20, 0.8)];
    const diff = diffPeaks(before, after);

    const positions = diff.changes.map((c) => {
      if (c.kind === "removed") return c.before!.position;
      if (c.kind === "added") return c.after!.position;
      if (c.kind === "shifted") return c.after!.position;
      return c.before!.position;
    });

    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]);
    }
  });
});

describe("diffFileContext", () => {
  it("returns before and after line counts in result", () => {
    const before = [makePeak(10, 0.9)];
    const after = [makePeak(10, 0.9), makePeak(30, 0.7)];
    const result = diffFileContext(before, after, 50, 55);

    expect(result.beforeLineCount).toBe(50);
    expect(result.afterLineCount).toBe(55);
    expect(result.diff.summary.unchanged).toBe(1);
    expect(result.diff.summary.added).toBe(1);
  });

  it("handles identical profiles producing no changes", () => {
    const peaks = [makePeak(10, 0.9), makePeak(20, 0.8)];
    const result = diffFileContext(peaks, peaks, 30, 30);

    expect(result.beforeLineCount).toBe(30);
    expect(result.afterLineCount).toBe(30);
    expect(result.diff.summary.unchanged).toBe(2);
    expect(result.diff.summary.added).toBe(0);
    expect(result.diff.summary.removed).toBe(0);
    expect(result.diff.summary.shifted).toBe(0);
    expect(result.diff.summary.magnitudeChanged).toBe(0);
  });
});

describe("integration: full composition path", () => {
  it("diffs wavelet peaks between two git revisions of a real file", async () => {
    // Use src/index.ts which changed between HEAD~1 and HEAD
    const filePath = resolve(repoRoot, "src/index.ts");
    const gitRoot = findGitRoot(filePath);
    expect(gitRoot).toBe(repoRoot);

    const baseContent = await readFileAtRef(repoRoot, filePath, "HEAD~1");
    const targetContent = await readFileAtRef(repoRoot, filePath, "HEAD");

    const baseCtx = new FileContext(filePath, baseContent);
    const targetCtx = new FileContext(filePath, targetContent);

    const minCoefficient = 0.3;
    const limit = 100;
    const basePeaks = baseCtx.getImportantPositions(minCoefficient, limit)
      .map((p) => ({ position: p.position, coefficient: p.coefficient, scale: p.scale }));
    const targetPeaks = targetCtx.getImportantPositions(minCoefficient, limit)
      .map((p) => ({ position: p.position, coefficient: p.coefficient, scale: p.scale }));

    const result = diffFileContext(
      basePeaks, targetPeaks,
      baseCtx.lineCount, targetCtx.lineCount,
    );

    // Structural assertions
    expect(result.beforeLineCount).toBeGreaterThan(0);
    expect(result.afterLineCount).toBeGreaterThan(0);
    expect(result.diff.changes.length).toBeGreaterThan(0);
    // All categories together should account for every change
    const total = result.diff.summary.added + result.diff.summary.removed +
      result.diff.summary.shifted + result.diff.summary.magnitudeChanged +
      result.diff.summary.unchanged;
    expect(total).toBe(result.diff.changes.length);

    // Every change should have a valid kind
    for (const c of result.diff.changes) {
      expect(["added", "removed", "shifted", "magnitudeChanged", "unchanged"])
        .toContain(c.kind);
      if (c.kind !== "added") expect(c.before).not.toBeNull();
      if (c.kind !== "removed") expect(c.after).not.toBeNull();
    }
  });

  it("tryReadFileAtRef rejects paths outside the repository with a recognizable message", async () => {
    // /etc/passwd is a real path outside any normal repo
    await expect(
      tryReadFileAtRef(repoRoot, "/etc/passwd", "HEAD"),
    ).rejects.toThrow(/outside the repository/);
  });

  it("tryReadFileAtRef returns null when file does not exist at ref", async () => {
    // streaming.ts was added in HEAD~2 — at HEAD~3 it didn't exist
    const result = await tryReadFileAtRef(repoRoot, resolve(repoRoot, "src/streaming.ts"), "HEAD~3");
    expect(result).toBeNull();
  });

  it("tryReadFileAtRef returns null for path that never existed at ref", async () => {
    const result = await tryReadFileAtRef(
      repoRoot,
      resolve(repoRoot, "src/no_such_file.ts"),
      "HEAD",
    );
    expect(result).toBeNull();
  });

  it("tryReadFileAtRef throws for invalid ref", async () => {
    await expect(
      tryReadFileAtRef(repoRoot, resolve(repoRoot, "src/index.ts"), "BOGUS_REF_DOES_NOT_EXIST"),
    ).rejects.toThrow();
  });

  it("tryReadFileAtRef returns content for valid ref + file", async () => {
    const result = await tryReadFileAtRef(repoRoot, resolve(repoRoot, "src/index.ts"), "HEAD");
    expect(result).toBeTypeOf("string");
    expect(result!.length).toBeGreaterThan(0);
  });

  it("diffFileAtRefs handles file that does not exist at base (treats base as empty)", async () => {
    // streaming.ts present at HEAD, missing at HEAD~3
    const filePath = resolve(repoRoot, "src/streaming.ts");
    const result = await diffFileAtRefs(filePath, "HEAD~3", "HEAD", {
      minCoefficient: 0.3,
      limit: 100,
      window: 2,
    });
    expect(result.beforeLineCount).toBe(0);
    expect(result.afterLineCount).toBeGreaterThan(0);
    expect(result.diff.summary.removed).toBe(0);
    expect(result.diff.summary.added).toBeGreaterThan(0);
  });

  it("diffFileAtRefs handles file deleted in working tree (treats target as empty)", async () => {
    // Create a temp git repo with a committed file, then delete the file on disk
    const tmp = mkdtempSync(join(tmpdir(), "wavescope-diff-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: tmp });
      execFileSync("git", ["config", "user.email", "test@test"], { cwd: tmp });
      execFileSync("git", ["config", "user.name", "test"], { cwd: tmp });
      const file = join(tmp, "foo.ts");
      writeFileSync(file, "export class Foo {\n  bar() {}\n  baz() {}\n}\n");
      execFileSync("git", ["add", "."], { cwd: tmp });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: tmp });
      unlinkSync(file);
      expect(existsSync(file)).toBe(false);

      const result = await diffFileAtRefs(file, "HEAD", undefined, {
        minCoefficient: 0.3,
        limit: 100,
        window: 2,
      });
      expect(result.beforeLineCount).toBeGreaterThan(0);
      expect(result.afterLineCount).toBe(0);
      expect(result.diff.summary.added).toBe(0);
      // The committed 4-line class produces at least one peak above 0.3
      expect(result.diff.summary.removed).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("diffFileAtRefs throws when file is missing on both sides", async () => {
    const file = resolve(repoRoot, "src/never_existed_anywhere.ts");
    await expect(
      diffFileAtRefs(file, "HEAD", "HEAD", { minCoefficient: 0.3, limit: 100, window: 2 }),
    ).rejects.toThrow();
  });

  it("returns all-unchanged for identical revisions", async () => {
    const filePath = resolve(repoRoot, "src/wavelet.ts");

    const content = await readFileAtRef(repoRoot, filePath, "HEAD");
    const ctx = new FileContext(filePath, content);

    const peaks = ctx.getImportantPositions(0.3, 100)
      .map((p) => ({ position: p.position, coefficient: p.coefficient, scale: p.scale }));

    const result = diffFileContext(peaks, peaks, ctx.lineCount, ctx.lineCount);

    expect(result.diff.summary.unchanged).toBe(peaks.length);
    expect(result.diff.summary.added).toBe(0);
    expect(result.diff.summary.removed).toBe(0);
    expect(result.diff.summary.shifted).toBe(0);
    expect(result.diff.summary.magnitudeChanged).toBe(0);
  });
});
