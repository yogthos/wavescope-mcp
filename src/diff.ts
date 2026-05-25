import { Peak } from "./wavelet.js";

export interface PeakChange {
  kind: "added" | "removed" | "shifted" | "magnitudeChanged" | "unchanged";
  before: Peak | null;
  after: Peak | null;
}

export interface PeakDiffSummary {
  added: number;
  removed: number;
  shifted: number;
  magnitudeChanged: number;
  unchanged: number;
}

export interface PeakDiff {
  changes: PeakChange[];
  summary: PeakDiffSummary;
}

export interface FileDiffResult {
  beforeLineCount: number;
  afterLineCount: number;
  diff: PeakDiff;
}

const DEFAULT_WINDOW = 2;
const COEFF_EPSILON = 1e-10;

/**
 * Diff two sets of wavelet peaks (e.g. from different git revisions of a file).
 *
 * Matching is greedy by proximity: each after-peak is paired with the closest
 * unmatched before-peak within `window` lines. Unmatched before-peaks are
 * "removed", unmatched after-peaks are "added". Matched peaks at the same
 * position with the same coefficient are "unchanged"; same position with a
 * different coefficient are "magnitudeChanged"; different positions within
 * the window are "shifted".
 *
 * Results are sorted by position (preferring the "after" position for shifted,
 * the "before" position for removed, the "after" position for added).
 */
export function diffPeaks(
  before: Peak[],
  after: Peak[],
  window: number = DEFAULT_WINDOW,
): PeakDiff {
  const changes: PeakChange[] = [];
  const usedBefore = new Set<number>();

  const afterSorted = [...after].sort((a, b) => a.position - b.position);

  for (const ap of afterSorted) {
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let i = 0; i < before.length; i++) {
      if (usedBefore.has(i)) continue;
      const bp = before[i];
      const dist = Math.abs(bp.position - ap.position);
      if (dist <= window && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx !== -1) {
      usedBefore.add(bestIdx);
      const bp = before[bestIdx];
      if (bp.position === ap.position) {
        if (Math.abs(bp.coefficient - ap.coefficient) < COEFF_EPSILON) {
          changes.push({ kind: "unchanged", before: bp, after: ap });
        } else {
          changes.push({ kind: "magnitudeChanged", before: bp, after: ap });
        }
      } else {
        changes.push({ kind: "shifted", before: bp, after: ap });
      }
    } else {
      changes.push({ kind: "added", before: null, after: ap });
    }
  }

  for (let i = 0; i < before.length; i++) {
    if (!usedBefore.has(i)) {
      changes.push({ kind: "removed", before: before[i], after: null });
    }
  }

  // Sort by position: use after.position for added/shifted/unchanged/magnitudeChanged,
  // before.position for removed.
  changes.sort((a, b) => {
    const posA =
      a.kind === "removed" ? a.before!.position : a.after?.position ?? a.before!.position;
    const posB =
      b.kind === "removed" ? b.before!.position : b.after?.position ?? b.before!.position;
    return posA - posB;
  });

  const summary: PeakDiffSummary = {
    added: 0,
    removed: 0,
    shifted: 0,
    magnitudeChanged: 0,
    unchanged: 0,
  };

  for (const c of changes) {
    summary[c.kind]++;
  }

  return { changes, summary };
}

/**
 * Compare the wavelet profiles of two FileContext instances and return
 * a structured diff. Peaks are extracted with the given minCoefficient
 * and the diff is computed with the given position-matching window.
 *
 * This is the core logic behind the `diff_wavelet_context` MCP tool.
 */
export function diffFileContext(
  beforePeaks: Peak[],
  afterPeaks: Peak[],
  beforeLineCount: number,
  afterLineCount: number,
  window: number = DEFAULT_WINDOW,
): FileDiffResult {
  return {
    beforeLineCount,
    afterLineCount,
    diff: diffPeaks(beforePeaks, afterPeaks, window),
  };
}
