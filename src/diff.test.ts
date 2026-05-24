import { describe, it, expect } from "vitest";
import { diffPeaks, diffFileContext, FileDiffResult } from "./diff.js";
import { Peak } from "./wavelet.js";

function makePeak(
  position: number,
  coefficient: number,
  scale: number = 1,
): Peak {
  return { position, coefficient, scale };
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
