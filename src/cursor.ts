import { resolve } from "node:path";
import { FileContext, WaveletContextResult, ImportantPosition } from "./context.js";

export interface CursorPosition {
  line: number;
  column: number;
}

interface CursorEntry {
  file: string;
  cursor: CursorPosition;
  context: FileContext;
  proactiveContext: WaveletContextResult | null;
  timestamp: number;
}

/**
 * Rank important positions by a blend of proximity to cursor and
 * structural significance. Distance is normalized against a fixed
 * "neighborhood" of 100 lines and coefficient against the strongest
 * candidate in the set, so the two terms are comparable in [0, ~1+].
 *
 * Lower score = better match. The previous unnormalized form
 * (`|coef|*2 − dist*0.5`) collapsed to a pure proximity sort because
 * `|coef|` was always well under 1 in practice.
 */
/**
 * Distance scale (in lines) used to normalize proximity. Tuned to roughly
 * match the default `proactiveRadius`. Pass a different value when ranking
 * over a very small or very large file.
 */
const DEFAULT_NEIGHBORHOOD = 300;

function p90AbsCoef(positions: ImportantPosition[]): number {
  // 90th-percentile absolute coefficient. More outlier-resistant than max:
  // a single very-strong header peak no longer compresses every other
  // peak's normalized significance to near zero.
  const sorted = positions
    .map((p) => Math.abs(p.coefficient))
    .sort((a, b) => a - b);
  const idx = Math.floor(0.9 * (sorted.length - 1));
  return Math.max(sorted[idx], 1e-9);
}

export function rankByProximityAndSignificance(
  positions: ImportantPosition[],
  cursorLine: number,
  limit: number,
  neighborhood: number = DEFAULT_NEIGHBORHOOD,
): ImportantPosition[] {
  if (positions.length === 0) return [];
  const coefScale = p90AbsCoef(positions);
  return positions
    .map((p) => ({
      p,
      score:
        Math.abs(p.position - cursorLine) / neighborhood -
        Math.abs(p.coefficient) / coefScale,
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      const da = Math.abs(a.p.position - cursorLine);
      const db = Math.abs(b.p.position - cursorLine);
      if (da !== db) return da - db;
      return a.p.position - b.p.position;
    })
    .slice(0, limit)
    .map((s) => s.p);
}

/**
 * Manages editor cursor positions and provides proactive context.
 *
 * When the editor reports a cursor move, the manager precomputes
 * wavelet context around the cursor. Subsequent queries for context
 * at that file return the cached result without recomputation.
 *
 * Cursor movement is debounced: moves within 10 lines of the
 * previous position reuse the cached context.
 */
export class CursorManager {
  private cursors = new Map<string, CursorEntry>();
  /** Radius used for proactive context queries. */
  private proactiveRadius = 300;
  /** Minimum line distance to trigger a context recompute. */
  private debounceLines = 10;

  constructor(
    readonly ttl: number = 60_000,
    readonly maxEntries: number = 50,
  ) {}

  private norm(path: string): string {
    return resolve(path);
  }

  /**
   * Update the cursor position for a file. Recomputes proactive
   * context only when the cursor has moved significantly.
   */
  updateCursor(
    ctx: FileContext,
    file: string,
    line: number,
    column: number,
  ): void {
    const key = this.norm(file);
    const existing = this.cursors.get(key);

    if (existing) {
      const prevLine = existing.cursor.line;
      const contextChanged = existing.context !== ctx;
      existing.cursor = { line, column };
      existing.timestamp = Date.now();
      existing.context = ctx;

      // Debounce: skip recompute only when cursor hasn't moved much
      // AND the underlying file hasn't changed on disk.
      if (
        existing.proactiveContext &&
        Math.abs(prevLine - line) < this.debounceLines &&
        !contextChanged
      ) {
        return;
      }

      existing.proactiveContext = ctx.queryWaveletContext(line, this.proactiveRadius);
    } else {
      const proactiveContext = ctx.queryWaveletContext(line, this.proactiveRadius);
      this.cursors.set(key, {
        file: key,
        cursor: { line, column },
        context: ctx,
        proactiveContext,
        timestamp: Date.now(),
      });
      this.evictLRU();
    }
  }

  /** Get the current cursor position for a file, or null. */
  getCursor(file: string): CursorPosition | null {
    const entry = this.cursors.get(this.norm(file));
    if (!entry) return null;
    entry.timestamp = Date.now();
    return { line: entry.cursor.line, column: entry.cursor.column };
  }

  /**
   * Get precomputed wavelet context around the current cursor.
   * Returns null if no cursor is known for the file.
   *
   * When `freshCtx` is supplied and differs from the cached entry's
   * FileContext (e.g. the file changed on disk since the last
   * update_cursor_position), the proactive context is recomputed
   * against the fresh ctx and the entry is updated.
   */
  getProactiveContext(
    file: string,
    freshCtx?: FileContext,
  ): WaveletContextResult | null {
    const entry = this.cursors.get(this.norm(file));
    if (!entry) return null;
    entry.timestamp = Date.now();
    if (freshCtx && freshCtx !== entry.context) {
      this.refreshAgainst(entry, freshCtx);
    }
    return entry.proactiveContext;
  }

  /**
   * Get important positions near the cursor, sorted by proximity.
   * Returns null if no cursor is known for the file.
   *
   * `freshCtx` behaves identically to {@link getProactiveContext}.
   */
  getCursorImportantPositions(
    file: string,
    limit: number = 10,
    freshCtx?: FileContext,
  ): ImportantPosition[] | null {
    const entry = this.cursors.get(this.norm(file));
    if (!entry) return null;
    entry.timestamp = Date.now();
    if (freshCtx && freshCtx !== entry.context) {
      this.refreshAgainst(entry, freshCtx);
    }

    const cursorLine = entry.cursor.line;
    const allPositions = entry.context.getImportantPositions(0.1, 100);
    // Scale the proximity normalizer to the file so the distance term
    // doesn't permanently dominate on large files.
    const neighborhood = Math.max(
      50,
      Math.min(entry.context.lineCount, DEFAULT_NEIGHBORHOOD),
    );
    return rankByProximityAndSignificance(
      allPositions,
      cursorLine,
      limit,
      neighborhood,
    );
  }

  /** Remove a file from cursor tracking. */
  removeFile(file: string): void {
    this.cursors.delete(this.norm(file));
  }

  /** Remove expired entries. Returns eviction count. */
  evictExpired(now: number = Date.now()): number {
    let count = 0;
    for (const [key, entry] of this.cursors) {
      if (now - entry.timestamp >= this.ttl) {
        this.cursors.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Remove all entries. */
  shutdown(): void {
    this.cursors.clear();
  }

  get size(): number {
    return this.cursors.size;
  }

  // Swap the entry's FileContext to a fresh one and recompute its
  // proactiveContext. Cursor line is clamped to the new file length so a
  // shrunken file doesn't anchor the cursor past EOF. Synchronous and
  // self-contained — no awaits, so concurrent callers see last-writer-wins
  // on a consistent (context, proactiveContext) pair.
  private refreshAgainst(entry: CursorEntry, freshCtx: FileContext): void {
    entry.context = freshCtx;
    if (freshCtx.lineCount > 0 && entry.cursor.line >= freshCtx.lineCount) {
      entry.cursor.line = freshCtx.lineCount - 1;
    }
    entry.proactiveContext = freshCtx.queryWaveletContext(
      entry.cursor.line,
      this.proactiveRadius,
    );
  }

  private evictLRU(): void {
    if (this.cursors.size <= this.maxEntries) return;
    const entries = [...this.cursors.entries()].sort(
      (a, b) => a[1].timestamp - b[1].timestamp,
    );
    const toDelete = entries.slice(0, this.cursors.size - this.maxEntries);
    for (const [key] of toDelete) this.cursors.delete(key);
  }
}
