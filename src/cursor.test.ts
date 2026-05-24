import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CursorManager } from "./cursor.js";
import { FileContext } from "./context.js";

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

    // Artificially age
    const entry = (manager as any).cursors.get("test.py");
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

  it("getCursorImportantPositions returns null for unknown file", () => {
    const positions = manager.getCursorImportantPositions("unknown.py");
    expect(positions).toBeNull();
  });
});
