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
      existing.cursor = { line, column };
      existing.timestamp = Date.now();
      existing.context = ctx;

      // Debounce: only recompute if cursor moved significantly
      if (
        existing.proactiveContext &&
        Math.abs(prevLine - line) < this.debounceLines
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
   */
  getProactiveContext(file: string): WaveletContextResult | null {
    const entry = this.cursors.get(this.norm(file));
    if (!entry) return null;
    entry.timestamp = Date.now();
    return entry.proactiveContext;
  }

  /**
   * Get important positions near the cursor, sorted by proximity.
   * Returns null if no cursor is known for the file.
   */
  getCursorImportantPositions(
    file: string,
    limit: number = 10,
  ): ImportantPosition[] | null {
    const entry = this.cursors.get(this.norm(file));
    if (!entry) return null;
    entry.timestamp = Date.now();

    const cursorLine = entry.cursor.line;
    const allPositions = entry.context.getImportantPositions(0.1, 100);

    // Sort by proximity to cursor, then by coefficient magnitude
    const scored = allPositions
      .map((p) => ({
        position: p,
        proximityScore: Math.abs(p.position - cursorLine) * 0.5 -
          Math.abs(p.coefficient) * 2,
      }))
      .sort((a, b) => a.proximityScore - b.proximityScore)
      .slice(0, limit)
      .map((s) => s.position);

    return scored;
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

  private evictLRU(): void {
    if (this.cursors.size <= this.maxEntries) return;
    const entries = [...this.cursors.entries()].sort(
      (a, b) => a[1].timestamp - b[1].timestamp,
    );
    const toDelete = entries.slice(0, this.cursors.size - this.maxEntries);
    for (const [key] of toDelete) this.cursors.delete(key);
  }
}
