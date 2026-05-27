import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { CursorManager, rankByProximityAndSignificance } from "./cursor.js";
import { FileContext, ImportantPosition } from "./context.js";

const samplePython = `#!/usr/bin/env python3
"""Data processing module."""

import os
import json


class DataProcessor:
    """Main data processing class."""

    def __init__(self, config: dict):
        self.config = config

    def process(self, data):
        """Apply transformation pipeline."""
        return [self._transform(item) for item in data]

    def _transform(self, item):
        return item


def helper(x: int) -> int:
    """Standalone helper."""
    return x * x
`;

describe("CursorManager", () => {
  let manager: CursorManager;

  beforeEach(() => {
    manager = new CursorManager(30_000, 50);
  });

  afterEach(() => {
    manager.shutdown();
  });

  it("stores cursor position for a file", () => {
    const ctx = new FileContext("test.py", samplePython);
    manager.updateCursor(ctx, "test.py", 10, 4);

    const pos = manager.getCursor("test.py");
    expect(pos).not.toBeNull();
    expect(pos!.line).toBe(10);
    expect(pos!.column).toBe(4);
  });

  it("returns null for unknown file", () => {
    const pos = manager.getCursor("unknown.py");
    expect(pos).toBeNull();
  });

  it("updates existing cursor position", () => {
    const ctx = new FileContext("test.py", samplePython);
    manager.updateCursor(ctx, "test.py", 5, 2);
    manager.updateCursor(ctx, "test.py", 20, 8);

    const pos = manager.getCursor("test.py");
    expect(pos!.line).toBe(20);
    expect(pos!.column).toBe(8);
  });

  it("returns proactive context around cursor", () => {
    const ctx = new FileContext("test.py", samplePython);
    manager.updateCursor(ctx, "test.py", 14, 4); // line with "def process"

    const context = manager.getProactiveContext("test.py");
    expect(context).not.toBeNull();
    expect(context!.bands.fine).toBeDefined();
    expect(context!.bands.medium).toBeDefined();
    expect(context!.bands.coarse).toBeDefined();
    // Center should be near the cursor
    expect(context!.center).toBeGreaterThanOrEqual(10);
    expect(context!.center).toBeLessThanOrEqual(18);
  });

  it("returns null for proactive context when no cursor known", () => {
    const context = manager.getProactiveContext("nonexistent.py");
    expect(context).toBeNull();
  });

  it("debounces cursor updates — small moves don't recompute", () => {
    const ctx = new FileContext("test.py", samplePython);

    // Initial update at line 10
    manager.updateCursor(ctx, "test.py", 10, 4);
    const initialContext = manager.getProactiveContext("test.py");

    // Small move (within debounce threshold of 10 lines)
    manager.updateCursor(ctx, "test.py", 12, 4);
    const sameContext = manager.getProactiveContext("test.py");

    // Should return the same cached context (same center)
    expect(sameContext!.center).toBe(initialContext!.center);
  });

  it("uses fresh FileContext even when debounced (stale-context bug)", () => {
    // Simulate file change on disk: ctx1 is the old version, ctx2 is new.
    const ctx1 = new FileContext("test.py", samplePython);

    // New version with an extra class (produces different important positions)
    const newContent = samplePython + `

class NewProcessor:
    """Added after the fact."""

    def run(self):
        pass
`;
    const ctx2 = new FileContext("test.py", newContent);

    // Initial update
    manager.updateCursor(ctx1, "test.py", 10, 4);

    // Small cursor move within debounce threshold, but with new FileContext
    manager.updateCursor(ctx2, "test.py", 12, 4);

    // getCursorImportantPositions must use the new context (ctx2)
    const positions = manager.getCursorImportantPositions("test.py", 50);
    expect(positions).not.toBeNull();

    // ctx2 has more structural peaks than ctx1 (extra class)
    const ctx1Positions = ctx1.getImportantPositions(0.1, 50);
    const ctx2Positions = ctx2.getImportantPositions(0.1, 50);
    expect(ctx2Positions.length).toBeGreaterThan(ctx1Positions.length);
    expect(positions!.length).toBe(ctx2Positions.length);
  });

  it("recomputes proactiveContext when context object changes, even within debounce", () => {
    const ctx1 = new FileContext("test.py", samplePython);
    const newContent = samplePython + `

class NewProcessor:
    """Added after the fact."""

    def run(self):
        pass
`;
    const ctx2 = new FileContext("test.py", newContent);

    // Cursor near the end of the original file
    manager.updateCursor(ctx1, "test.py", 28, 4);
    const firstContext = manager.getProactiveContext("test.py");
    expect(firstContext).not.toBeNull();

    // Small move within debounce, but with new FileContext
    manager.updateCursor(ctx2, "test.py", 30, 4);
    const secondContext = manager.getProactiveContext("test.py");

    // proactiveContext must reflect the new file — fine band should
    // include the newly added class
    expect(secondContext).not.toBeNull();
    expect(secondContext!.bands.fine.content).toContain("NewProcessor");
  });

  it("recomputes proactive context on significant cursor move", () => {
    const ctx = new FileContext("test.py", samplePython);

    // Initial update
    manager.updateCursor(ctx, "test.py", 10, 4);
    const initialContext = manager.getProactiveContext("test.py");

    // Large move (beyond debounce threshold)
    manager.updateCursor(ctx, "test.py", 25, 4);
    const newContext = manager.getProactiveContext("test.py");

    // Should have recomputed — different center
    expect(newContext!.center).not.toBe(initialContext!.center);
  });

  it("tracks multiple files independently", () => {
    const ctx = new FileContext("test.py", samplePython);
    const ctx2 = new FileContext("other.py", samplePython);

    manager.updateCursor(ctx, "test.py", 10, 4);
    manager.updateCursor(ctx2, "other.py", 5, 2);

    expect(manager.getCursor("test.py")!.line).toBe(10);
    expect(manager.getCursor("other.py")!.line).toBe(5);
  });

  it("evicts expired cursor entries", () => {
    const ctx = new FileContext("test.py", samplePython);
    manager.updateCursor(ctx, "test.py", 10, 4);

    // Artificially age — use normalized key
    const entry = (manager as any).cursors.get(resolve("test.py"));
    entry!.timestamp = Date.now() - 60_000;

    manager.evictExpired(Date.now());
    expect(manager.getCursor("test.py")).toBeNull();
  });

  it("removes file from cursor tracking", () => {
    const ctx = new FileContext("test.py", samplePython);
    manager.updateCursor(ctx, "test.py", 10, 4);

    manager.removeFile("test.py");
    expect(manager.getCursor("test.py")).toBeNull();
    expect(manager.getProactiveContext("test.py")).toBeNull();
  });

  it("getCursorImportantPositions returns peaks near cursor", () => {
    const ctx = new FileContext("test.py", samplePython);
    manager.updateCursor(ctx, "test.py", 21, 4); // near "def helper"

    const positions = manager.getCursorImportantPositions("test.py", 5);
    expect(positions).not.toBeNull();
    expect(positions!.length).toBeGreaterThan(0);
    // Should include positions near line 21
    const near = positions!.filter(
      (p) => Math.abs(p.position - 21) <= 10,
    );
    expect(near.length).toBeGreaterThan(0);
  });

  it("normalizes file paths so /a/./b and /a/b share the same entry", () => {
    const ctx = new FileContext("/abs/test.py", samplePython);
    manager.updateCursor(ctx, "/abs/./test.py", 10, 4);

    // Same logical file via different path spelling
    const pos = manager.getCursor("/abs/test.py");
    expect(pos).not.toBeNull();
    expect(pos!.line).toBe(10);
  });

  it("getCursorImportantPositions returns null for unknown file", () => {
    const positions = manager.getCursorImportantPositions("unknown.py");
    expect(positions).toBeNull();
  });

  describe("R1.6: proximity vs significance ranking (rankByProximityAndSignificance)", () => {
    const mk = (position: number, coefficient: number): ImportantPosition => ({
      position,
      coefficient,
      scale: 4,
      label: `line ${position}`,
    });

    it("strong distant peak beats weak nearby peak", () => {
      // Cursor at 50. Weak peak at 52 (close, coef 0.1) vs strong peak at
      // 90 (40 lines away, coef 2.0). Normalized scores:
      //   weak  = 2/100 - 0.1/2.0 = 0.02 - 0.05  = -0.03
      //   strong= 40/100 - 2.0/2.0 = 0.4 - 1.0  = -0.6
      // strong wins (lower score = better).
      const ranked = rankByProximityAndSignificance(
        [mk(52, 0.1), mk(90, 2.0)],
        50,
        10,
      );
      expect(ranked[0].position).toBe(90);
      expect(ranked[1].position).toBe(52);
    });

    it("with equal coefficients, closer beats farther", () => {
      const ranked = rankByProximityAndSignificance(
        [mk(10, 0.8), mk(50, 0.8), mk(30, 0.8)],
        20,
        10,
      );
      expect(ranked.map((p) => p.position)).toEqual([10, 30, 50]);
    });

    it("with equal distance, stronger beats weaker", () => {
      const ranked = rankByProximityAndSignificance(
        [mk(45, 0.2), mk(55, 0.9)],
        50,
        10,
      );
      expect(ranked[0].position).toBe(55);
    });

    it("is deterministic across calls", () => {
      const input = [
        mk(10, 0.5),
        mk(20, 0.5),
        mk(30, 0.5),
        mk(40, 0.5),
      ];
      const a = rankByProximityAndSignificance(input, 25, 4);
      const b = rankByProximityAndSignificance(input, 25, 4);
      expect(a).toEqual(b);
    });

    it("respects the limit", () => {
      const ranked = rankByProximityAndSignificance(
        [mk(10, 0.5), mk(20, 0.5), mk(30, 0.5), mk(40, 0.5)],
        25,
        2,
      );
      expect(ranked.length).toBe(2);
    });

    it("handles empty input", () => {
      expect(rankByProximityAndSignificance([], 0, 10)).toEqual([]);
    });

    it("p90 normalization resists a single outlier coefficient", () => {
      // Without p90 (i.e. with max), the outlier at coef=100 would
      // compress every other peak's normalized significance to ~0, so the
      // ranking among the rest would collapse to pure distance.
      // With p90 the outlier sits outside the normalizer so moderate
      // peaks retain useful contrast.
      const cursor = 50;
      const positions = [
        mk(80, 100),  // outlier — close enough that we expect it first regardless
        mk(45, 0.3),  // closer to cursor, moderate
        mk(70, 0.9),  // farther, stronger moderate
      ];
      const ranked = rankByProximityAndSignificance(positions, cursor, 10);
      // Outlier should win
      expect(ranked[0].position).toBe(80);
      // Between the two moderates, the stronger one (70) should still
      // beat the closer-but-weaker one (45) because p90 preserves their
      // coefficient contrast.
      const moderateOrder = ranked
        .filter((p) => p.position !== 80)
        .map((p) => p.position);
      expect(moderateOrder[0]).toBe(70);
    });

    it("neighborhood parameter scales the proximity weight", () => {
      const positions = [mk(60, 0.9), mk(200, 2.0)];
      const cursor = 50;
      // Small neighborhood: distance dominates → strong-but-far still loses.
      const small = rankByProximityAndSignificance(positions, cursor, 10, 10);
      expect(small[0].position).toBe(60);
      // Large neighborhood: significance gets room to matter → strong wins.
      const large = rankByProximityAndSignificance(positions, cursor, 10, 1000);
      expect(large[0].position).toBe(200);
    });

    it("no longer collapses to pure distance sort (regression for R1.6)", () => {
      // Pre-fix formula was dist*0.5 - |coef|*2. With |coef| < 1, distance
      // term dominated. Construct a case where the pure-distance ordering
      // would put a weak peak above a strong distant one.
      const positions = [
        mk(51, 0.05), // 1 line away, coef 0.05
        mk(52, 0.06), // 2 lines away, coef 0.06
        mk(80, 1.5),  // 30 lines away, coef 1.5
      ];
      const ranked = rankByProximityAndSignificance(positions, 50, 3);
      // Strong peak should be first
      expect(ranked[0].position).toBe(80);
    });
  });

  describe("R1.5: stale-context refresh on read", () => {
    it("getProactiveContext recomputes when fresh ctx differs from cached", () => {
      const ctx1 = new FileContext("test.py", samplePython);
      manager.updateCursor(ctx1, "test.py", 10, 4);
      const stale = manager.getProactiveContext("test.py");
      expect(stale).not.toBeNull();

      // File changed on disk — a fresh ctx is computed elsewhere (e.g. via
      // mtime-aware file cache). Caller passes it in to keep the cursor's
      // proactiveContext in sync without requiring an update_cursor_position
      // round-trip.
      const newContent = samplePython +
        "\n\nclass FreshOne:\n    def fresh(self):\n        pass\n";
      const ctx2 = new FileContext("test.py", newContent);

      const refreshed = manager.getProactiveContext("test.py", ctx2);
      expect(refreshed).not.toBeNull();
      // Coarse band of refreshed ctx should reflect the new class
      const merged =
        refreshed!.bands.coarse.content +
        refreshed!.bands.medium.content +
        refreshed!.bands.fine.content;
      expect(merged).toContain("FreshOne");
    });

    it("getProactiveContext returns cached when fresh ctx is identical", () => {
      const ctx = new FileContext("test.py", samplePython);
      manager.updateCursor(ctx, "test.py", 10, 4);
      const first = manager.getProactiveContext("test.py");
      const second = manager.getProactiveContext("test.py", ctx);
      // Same object reference — no recompute
      expect(second).toBe(first);
    });

    it("clamps cursor line when fresh ctx is much shorter", () => {
      const ctx1 = new FileContext("test.py", samplePython);
      manager.updateCursor(ctx1, "test.py", 25, 0); // near end of original

      // Drastically shrunken file — only 3 lines
      const tiny = new FileContext("test.py", "a = 1\nb = 2\nc = 3\n");
      const refreshed = manager.getProactiveContext("test.py", tiny);
      expect(refreshed).not.toBeNull();
      // Center should be clamped into the new file's range
      expect(refreshed!.center).toBeLessThan(tiny.lineCount);
    });

    it("getCursorImportantPositions uses fresh ctx when provided", () => {
      const ctx1 = new FileContext("test.py", samplePython);
      manager.updateCursor(ctx1, "test.py", 10, 4);

      const newContent = samplePython +
        "\n\nclass FreshTwo:\n    def fresh(self):\n        pass\n";
      const ctx2 = new FileContext("test.py", newContent);

      const stalePositions = manager.getCursorImportantPositions("test.py", 50);
      const freshPositions = manager.getCursorImportantPositions("test.py", 50, ctx2);

      expect(stalePositions).not.toBeNull();
      expect(freshPositions).not.toBeNull();
      // Fresh context with extra class should expose more peaks
      expect(freshPositions!.length).toBeGreaterThan(stalePositions!.length);
    });
  });
});
