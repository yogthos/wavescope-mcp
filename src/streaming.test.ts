import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StreamManager, StreamState } from "./streaming.js";
import { ImportantPosition } from "./context.js";
import { FileContext } from "./context.js";

function makePeak(pos: number, label: string): ImportantPosition {
  return { position: pos, coefficient: 0.8, scale: 4, label };
}

describe("StreamManager", () => {
  let manager: StreamManager;

  beforeEach(() => {
    manager = new StreamManager(10_000, 5);
  });

  afterEach(() => {
    manager.shutdown();
  });

  it("creates a stream with a unique ID", () => {
    const id = manager.createStream();
    expect(id).toBeTypeOf("string");
    expect(id.length).toBeGreaterThan(0);

    const state = manager.getStream(id);
    expect(state).not.toBeNull();
    expect(state!.status).toBe("active");
    expect(state!.complete).toBe(false);
  });

  it("creates unique IDs for different streams", () => {
    const id1 = manager.createStream();
    const id2 = manager.createStream();
    expect(id1).not.toBe(id2);
  });

  it("appends batches to the stream buffer", () => {
    const id = manager.createStream();

    const batch: ImportantPosition[] = [
      makePeak(10, "class Foo"),
      makePeak(20, "def bar"),
    ];

    manager.appendBatch(id, batch, false);
    manager.appendBatch(id, [makePeak(30, "class Baz")], true);

    const state = manager.getStream(id)!;
    expect(state.batches.length).toBe(2);
    expect(state.complete).toBe(true);
    expect(state.status).toBe("complete");
  });

  it("poll returns next batch and advances cursor", () => {
    const id = manager.createStream();

    const batch1: ImportantPosition[] = [makePeak(10, "class Foo")];
    const batch2: ImportantPosition[] = [makePeak(20, "def bar")];

    manager.appendBatch(id, batch1, false);
    manager.appendBatch(id, batch2, true);

    // First poll
    const result1 = manager.poll(id);
    expect(result1).not.toBeNull();
    if (!result1 || "error" in result1) throw new Error("unexpected");
    expect(result1.peaks.length).toBe(1);
    expect(result1.more).toBe(true);
    expect(result1.complete).toBe(false);

    // Second poll
    const result2 = manager.poll(id);
    expect(result2).not.toBeNull();
    if (!result2 || "error" in result2) throw new Error("unexpected");
    expect(result2.peaks.length).toBe(1);
    expect(result2.more).toBe(false);
    expect(result2.complete).toBe(true);

    // Third poll returns empty complete (not null — stream still exists)
    const result3 = manager.poll(id);
    expect(result3).not.toBeNull();
    if (!result3 || "error" in result3) throw new Error("unexpected");
    expect(result3.peaks).toEqual([]);
    expect(result3.complete).toBe(true);
  });

  it("poll returns null for unknown stream (not {complete:true})", () => {
    const result = manager.poll("nonexistent");
    expect(result).toBeNull();
  });

  it("poll on empty complete stream returns empty peaks with complete:true", () => {
    const id = manager.createStream();
    manager.appendBatch(id, [], true);

    const result = manager.poll(id);
    expect(result).not.toBeNull();
    if (!result || "error" in result) throw new Error("unexpected");
    expect(result.peaks).toEqual([]);
    expect(result.complete).toBe(true);

    // Second poll — all delivered
    const result2 = manager.poll(id);
    expect(result2).not.toBeNull();
    if (!result2 || "error" in result2) throw new Error("unexpected");
    expect(result2.peaks).toEqual([]);
    expect(result2.complete).toBe(true);
  });

  it("close removes the stream", () => {
    const id = manager.createStream();
    manager.appendBatch(id, [makePeak(10, "class Foo")], true);

    manager.close(id);
    expect(manager.getStream(id)).toBeNull();
    // Poll returns null after close (not complete)
    expect(manager.poll(id)).toBeNull();
  });

  it("close is idempotent for unknown streams", () => {
    expect(() => manager.close("nonexistent")).not.toThrow();
  });

  it("appendBatch no-ops after close (cancellation)", () => {
    const id = manager.createStream();
    manager.close(id);
    // Should not throw
    manager.appendBatch(id, [makePeak(10, "class Foo")], true);
    expect(manager.getStream(id)).toBeNull();
  });

  it("evicts expired streams using lastAccess, not createdAt", async () => {
    const id = manager.createStream();
    manager.appendBatch(id, [makePeak(10, "class Foo")], false);

    // Artificially age the stream
    const state = manager.getStream(id)!;
    state.lastAccess = Date.now() - 20_000;

    manager.evictExpired(Date.now());
    expect(manager.getStream(id)).toBeNull();
  });

  it("keeps actively-polled streams alive beyond TTL", () => {
    // Short TTL
    const short = new StreamManager(100, 5);
    const id = short.createStream();
    short.appendBatch(id, [makePeak(10, "class Foo")], false);

    // Poll refreshes lastAccess
    short.poll(id);
    short.poll(id); // second poll returns empty, but refreshes timestamp

    // Artificially age createdAt but lastAccess is fresh
    const state = short.getStream(id)!;
    state.createdAt = Date.now() - 50_000; // well past TTL

    short.evictExpired(Date.now());
    expect(short.getStream(id)).not.toBeNull(); // still alive — lastAccess is fresh

    short.shutdown();
  });

  it("markErrored makes poll return error after buffered batches drain", () => {
    const id = manager.createStream();
    manager.appendBatch(id, [makePeak(10, "class Foo")], false);
    manager.appendBatch(id, [makePeak(20, "def bar")], false);

    manager.markErrored(id, "disk full");

    // First poll still delivers buffered batch — consumer must not lose data
    const result1 = manager.poll(id);
    if (!result1 || "error" in result1) throw new Error("expected batch");
    expect(result1.peaks[0].position).toBe(10);

    // Second poll delivers next buffered batch
    const result2 = manager.poll(id);
    if (!result2 || "error" in result2) throw new Error("expected batch");
    expect(result2.peaks[0].position).toBe(20);

    // Third poll — buffer drained, now surface the error
    const result3 = manager.poll(id);
    expect(result3).toHaveProperty("error", "disk full");
    expect(result3).toHaveProperty("complete", true);
  });

  it("peek does not refresh lastAccess", () => {
    const id = manager.createStream();
    const state = manager.peek(id)!;
    const originalAccess = state.lastAccess - 5_000;
    state.lastAccess = originalAccess;

    // peek should NOT bump lastAccess
    const peeked = manager.peek(id);
    expect(peeked?.lastAccess).toBe(originalAccess);

    // getStream SHOULD bump it
    manager.getStream(id);
    expect(state.lastAccess).toBeGreaterThan(originalAccess);
  });

  it("drained-but-not-complete poll signals more:true", () => {
    const id = manager.createStream();
    manager.appendBatch(id, [makePeak(10, "class Foo")], false);

    // Drain the single buffered batch
    const first = manager.poll(id);
    if (!first || "error" in first) throw new Error("expected batch");
    expect(first.peaks.length).toBe(1);

    // Cursor caught up, but producer hasn't sent isLast yet
    const second = manager.poll(id);
    if (!second || "error" in second) throw new Error("unexpected");
    expect(second.peaks).toEqual([]);
    expect(second.more).toBe(true); // producer still running
    expect(second.complete).toBe(false);
  });

  it("markErrored is a no-op on cancelled streams", () => {
    const id = manager.createStream();
    manager.close(id);
    expect(() => manager.markErrored(id, "whatever")).not.toThrow();
  });

  it("enforces max streams limit with proper LRU (insertion order)", () => {
    // Create 5 streams (max)
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(manager.createStream());
    }
    expect(manager.size).toBe(5);

    // Creating a 6th should evict the oldest (first created)
    const id6 = manager.createStream();
    expect(manager.getStream(ids[0])).toBeNull();
    expect(manager.getStream(id6)).not.toBeNull();

    // Access ids[1] to bump it to most-recent
    manager.getStream(ids[1]);
    const id7 = manager.createStream();
    // ids[2] is now the oldest, not ids[1]
    expect(manager.getStream(ids[2])).toBeNull();
    expect(manager.getStream(ids[1])).not.toBeNull(); // survived
  });

  it("returns accurate size", () => {
    expect(manager.size).toBe(0);
    const id1 = manager.createStream();
    expect(manager.size).toBe(1);
    const id2 = manager.createStream();
    expect(manager.size).toBe(2);
    manager.close(id1);
    expect(manager.size).toBe(1);
    manager.shutdown();
    expect(manager.size).toBe(0);
  });
});

describe("Streaming integration", () => {
  it("streams file discovery results in batches", () => {
    const manager = new StreamManager(30_000, 10);

    const file1 = new FileContext("a.py", "class Foo:\n    def bar(self):\n        pass\n");
    const file2 = new FileContext("b.py", "class Baz:\n    def qux(self):\n        pass\n");

    const streamId = manager.createStream();

    // Simulate batch processing
    const peaks1 = file1.getImportantPositions(0.15, 10);
    manager.appendBatch(streamId, peaks1, false);

    const peaks2 = file2.getImportantPositions(0.15, 10);
    manager.appendBatch(streamId, peaks2, true);

    // Poll batches
    const poll1 = manager.poll(streamId);
    expect(poll1).not.toBeNull();
    if (!poll1 || "error" in poll1) throw new Error("unexpected");
    expect(poll1.peaks.length).toBeGreaterThan(0);
    expect(poll1.more).toBe(true);

    const poll2 = manager.poll(streamId);
    expect(poll2).not.toBeNull();
    if (!poll2 || "error" in poll2) throw new Error("unexpected");
    expect(poll2.peaks.length).toBeGreaterThan(0);
    expect(poll2.complete).toBe(true);

    manager.shutdown();
  });

  it("empty repo signals completion immediately", () => {
    const manager = new StreamManager(30_000, 10);
    const streamId = manager.createStream();

    // Simulate empty project
    manager.appendBatch(streamId, [], true);

    const poll1 = manager.poll(streamId);
    expect(poll1).not.toBeNull();
    if (!poll1 || "error" in poll1) throw new Error("unexpected");
    expect(poll1.peaks).toEqual([]);
    expect(poll1.complete).toBe(true);

    manager.shutdown();
  });
});
