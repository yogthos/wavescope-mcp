import { ImportantPosition } from "./context.js";
import { randomUUID } from "node:crypto";

export type StreamStatus = "active" | "complete" | "errored";

export interface StreamState {
  id: string;
  status: StreamStatus;
  complete: boolean;
  /** Error message when status === "errored". */
  error?: string;
  createdAt: number;
  lastAccess: number;
  /** Accumulated batches, each as a flat array of peaks. */
  batches: ImportantPosition[][];
  /** Index of the next batch to deliver on poll(). */
  cursor: number;
}

export interface PollResult {
  peaks: ImportantPosition[];
  /** True if there are more batches queued or the producer is still running. */
  more: boolean;
  /** True when the stream is complete and all batches delivered. */
  complete: boolean;
}

/**
 * Manages streaming state for project-wide operations.
 *
 * Since MCP doesn't support native streaming, we use a pull-based model:
 * - `createStream()` → stream_id
 * - Producer calls `appendBatch(id, peaks, isLast)` as files are processed
 * - Consumer calls `poll(id)` to get the next batch
 * - `close(id)` cleans up
 *
 * Streams have a TTL (default 60s) refreshed on every poll/append.
 * A max stream count prevents unbounded memory growth.
 */
export class StreamManager {
  private streams = new Map<string, StreamState>();
  /** Insertion-order list for LRU eviction. */
  private lruOrder: string[] = [];
  /**
   * Per-stream AbortController. The producer subscribes via .signal so a
   * stream_close (or TTL/LRU eviction) can interrupt long discovery work
   * — not just emit-loop iterations.
   */
  private aborters = new Map<string, AbortController>();

  constructor(
    readonly ttl: number = 60_000,
    readonly maxStreams: number = 20,
  ) {}

  /** Create a new stream and return its ID. */
  createStream(): string {
    const id = randomUUID();
    const now = Date.now();
    const state: StreamState = {
      id,
      status: "active",
      complete: false,
      createdAt: now,
      lastAccess: now,
      batches: [],
      cursor: 0,
    };
    this.streams.set(id, state);
    this.lruOrder.push(id);
    this.evictLRU();
    return id;
  }

  /**
   * Get stream state by ID and refresh its access time.
   * Returns null if not found.
   */
  getStream(id: string): StreamState | null {
    const state = this.streams.get(id) ?? null;
    if (state) {
      state.lastAccess = Date.now();
      this.bumpLRU(id);
    }
    return state;
  }

  /**
   * Look up a stream without refreshing access time.
   * Use this for producer cancellation checks so the producer does not
   * keep its own stream alive against TTL eviction.
   */
  peek(id: string): StreamState | null {
    return this.streams.get(id) ?? null;
  }

  /**
   * Append a batch of peaks to the stream.
   * Silently no-ops if the stream was closed (cancelled).
   * @param isLast - true if this is the final batch
   */
  appendBatch(id: string, peaks: ImportantPosition[], isLast: boolean): void {
    const state = this.streams.get(id);
    if (!state) return; // stream was cancelled/closed

    state.lastAccess = Date.now();
    this.bumpLRU(id);
    state.batches.push(peaks);

    if (isLast) {
      state.complete = true;
      state.status = "complete";
    }
  }

  /**
   * Mark a stream as errored without closing it. Consumer sees the error
   * on next poll, after any buffered batches drain. Overwrites a previous
   * `complete` status — a producer that finishes the last batch and then
   * fails during cleanup must still surface the failure to the consumer.
   */
  markErrored(id: string, error: string): void {
    const state = this.streams.get(id);
    if (!state) return;
    state.status = "errored";
    state.error = error;
    state.complete = true;
    state.lastAccess = Date.now();
  }

  /**
   * Poll the next available batch from the stream.
   * Returns null if the stream is unknown.
   * Returns `{ complete: true, peaks: [] }` when all batches delivered.
   *
   * Errored streams still drain their buffered batches first; the error
   * surfaces only once the consumer has caught up to the failure point.
   */
  poll(id: string): PollResult | { peaks: []; error: string; complete: true } | null {
    const state = this.streams.get(id);
    if (!state) return null;

    state.lastAccess = Date.now();
    this.bumpLRU(id);

    if (state.cursor < state.batches.length) {
      const peaks = state.batches[state.cursor];
      state.cursor++;
      const drained = state.cursor >= state.batches.length;
      const isErrored = state.status === "errored";
      // If errored, never claim complete on a batch — the error itself
      // still needs to be delivered on a follow-up poll. Otherwise a
      // consumer that stops on `complete:true` would silently lose the
      // failure signal.
      return {
        peaks,
        more: isErrored ? true : !drained || !state.complete,
        complete: !isErrored && state.complete && drained,
      };
    }

    if (state.status === "errored") {
      return { peaks: [], error: state.error ?? "Stream error", complete: true };
    }

    return {
      peaks: [],
      more: !state.complete,
      complete: state.complete,
    };
  }

  /**
   * Register an AbortController whose `.abort()` will fire when this
   * stream is closed, evicted, or shut down. Producer attaches its own
   * controller and threads its signal into long-running work.
   */
  registerAborter(id: string, controller: AbortController): void {
    if (!this.streams.has(id)) {
      // Stream already gone — abort immediately so producer doesn't waste work.
      controller.abort();
      return;
    }
    this.aborters.set(id, controller);
  }

  private fireAborter(id: string): void {
    const c = this.aborters.get(id);
    if (c) {
      this.aborters.delete(id);
      try {
        c.abort();
      } catch {
        // AbortController.abort() never throws in spec, but guard anyway
      }
    }
  }

  /** Close and remove a stream (also signals cancellation to producers). */
  close(id: string): void {
    this.streams.delete(id);
    this.fireAborter(id);
    this.lruOrder = this.lruOrder.filter((x) => x !== id);
  }

  /** Remove streams whose last access is older than TTL. Returns eviction count. */
  evictExpired(now: number = Date.now()): number {
    let count = 0;
    for (const [id, state] of this.streams) {
      if (now - state.lastAccess >= this.ttl) {
        this.streams.delete(id);
        this.fireAborter(id);
        this.lruOrder = this.lruOrder.filter((x) => x !== id);
        count++;
      }
    }
    return count;
  }

  /** Remove all streams. */
  shutdown(): void {
    for (const id of this.streams.keys()) this.fireAborter(id);
    this.streams.clear();
    this.lruOrder = [];
  }

  get size(): number {
    return this.streams.size;
  }

  private bumpLRU(id: string): void {
    this.lruOrder = this.lruOrder.filter((x) => x !== id);
    this.lruOrder.push(id);
  }

  private evictLRU(): void {
    while (this.lruOrder.length > this.maxStreams) {
      const oldest = this.lruOrder.shift()!;
      this.streams.delete(oldest);
      this.fireAborter(oldest);
    }
  }
}
