import { Peak } from "./wavelet.js";
import { readFile } from "node:fs/promises";
import { FileContext } from "./context.js";
import { findGitRoot, tryReadFileAtRef } from "./git.js";

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
    let bestCoefDiff = Infinity;

    for (let i = 0; i < before.length; i++) {
      if (usedBefore.has(i)) continue;
      const bp = before[i];
      const dist = Math.abs(bp.position - ap.position);
      if (dist > window) continue;
      const coefDiff = Math.abs(bp.coefficient - ap.coefficient);
      // Closer distance wins. Tiebreak by coefficient closeness so the
      // match is independent of `before`'s input order — picking the
      // peak whose coefficient most resembles the after-peak's is more
      // likely to identify the same logical structural boundary.
      if (
        dist < bestDist ||
        (dist === bestDist && coefDiff < bestCoefDiff)
      ) {
        bestDist = dist;
        bestCoefDiff = coefDiff;
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

export interface DiffFileAtRefsOptions {
  minCoefficient: number;
  limit: number;
  window: number;
  /**
   * Optional getter for the working-tree FileContext. When provided and
   * `targetRef` is undefined, this is used instead of a raw readFile so the
   * call benefits from the shared mtime-keyed file cache. Should throw an
   * ENOENT-coded error when the file is missing.
   */
  getWorkingTreeContext?: (absFile: string) => Promise<FileContext>;
}

/** Thrown by diffFileAtRefs when the file is missing on both sides. */
export class DiffFileMissingError extends Error {
  readonly bothMissing = true as const;
  constructor(message: string) {
    super(message);
    this.name = "DiffFileMissingError";
  }
}

/**
 * Orchestrate a wavelet diff for a file between two git states.
 *
 * - `baseRef` is required.
 * - `targetRef` undefined → working tree on disk.
 *
 * A side that does not exist (file missing at the ref, or file deleted from
 * the working tree) is treated as an empty file rather than an error. This
 * lets callers diff freshly-added files (base missing) and deleted files
 * (target missing) without special-casing. If *both* sides are missing the
 * function throws.
 */
export async function diffFileAtRefs(
  absFile: string,
  baseRef: string,
  targetRef: string | undefined,
  opts: DiffFileAtRefsOptions,
): Promise<FileDiffResult> {
  const repoRoot = findGitRoot(absFile);

  const baseContent = await tryReadFileAtRef(repoRoot, absFile, baseRef);

  let targetCtx: FileContext | null = null;
  let targetContent: string | null = null;
  if (targetRef !== undefined) {
    targetContent = await tryReadFileAtRef(repoRoot, absFile, targetRef);
  } else if (opts.getWorkingTreeContext) {
    // Prefer the shared file cache when available so this call hits the
    // same mtime-keyed FileContext as other tools instead of reparsing.
    try {
      targetCtx = await opts.getWorkingTreeContext(absFile);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") throw err;
      targetContent = null;
    }
  } else {
    try {
      targetContent = await readFile(absFile, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        targetContent = null;
      } else {
        throw err;
      }
    }
  }

  const targetMissing = targetCtx === null && targetContent === null;
  if (baseContent === null && targetMissing) {
    const targetDesc = targetRef ? `target ref "${targetRef}"` : "working tree";
    throw new DiffFileMissingError(
      `File does not exist at base ref "${baseRef}" or in ${targetDesc}`,
    );
  }

  const baseCtx = new FileContext(absFile, baseContent ?? "");
  if (targetCtx === null) {
    targetCtx = new FileContext(absFile, targetContent ?? "");
  }

  const basePeaks = baseCtx.getImportantPositions(opts.minCoefficient, opts.limit);
  const targetPeaks = targetCtx.getImportantPositions(opts.minCoefficient, opts.limit);

  return diffFileContext(
    basePeaks,
    targetPeaks,
    baseCtx.lineCount,
    targetCtx.lineCount,
    opts.window,
  );
}
