import { describe, it, expect } from "vitest";
import { FileContext, BandResult, ImportantPosition } from "./context.js";

const samplePython = `#!/usr/bin/env python3
"""Data processing module."""

import os
import json
from typing import List, Optional

# Constants
DEFAULT_TIMEOUT = 30
MAX_RETRIES = 3


class DataProcessor:
    """Main data processing class."""

    def __init__(self, config: dict):
        self.config = config
        self.cache = {}

    def load_data(self, path: str) -> List[dict]:
        """Load data from a JSON file."""
        with open(path) as f:
            return json.load(f)

    def process(self, data: List[dict]) -> List[dict]:
        """Apply transformation pipeline."""
        results = []
        for item in data:
            cleaned = self._clean(item)
            transformed = self._transform(cleaned)
            results.append(transformed)
        return results

    def _clean(self, item: dict) -> dict:
        """Remove null fields."""
        return {k: v for k, v in item.items() if v is not None}

    def _transform(self, item: dict) -> dict:
        """Apply business logic."""
        if 'value' in item:
            item['value'] = item['value'] * 2
        return item


def helper_function(x: int) -> int:
    """Standalone helper."""
    return x * x


class AnotherClass:
    """Secondary class."""

    def method_a(self):
        pass

    def method_b(self):
        pass


if __name__ == '__main__':
    processor = DataProcessor({'verbose': True})
    data = processor.load_data('input.json')
    result = processor.process(data)
    print(f"Processed {len(result)} items")
`;

describe("FileContext", () => {
  const ctx = new FileContext("test.py", samplePython);

  describe("basic properties", () => {
    it("stores filename and line count", () => {
      expect(ctx.filename).toBe("test.py");
      // lineCount = split without trailing empty line
      const rawLines = samplePython.split("\n");
      const expectedCount = rawLines[rawLines.length - 1] === ""
        ? rawLines.length - 1
        : rawLines.length;
      expect(ctx.lineCount).toBe(expectedCount);
    });

    it("has wavelet coefficients computed", () => {
      expect(ctx.coefficients.coefficients.length).toBeGreaterThan(0);
    });
  });

  describe("get_important_positions", () => {
    it("returns top structural positions", () => {
      const positions = ctx.getImportantPositions(0.15, 15);
      expect(positions.length).toBeGreaterThan(0);
      expect(positions.length).toBeLessThanOrEqual(15);

      // Sorted by coefficient descending
      for (let i = 1; i < positions.length; i++) {
        expect(
          Math.abs(positions[i - 1].coefficient),
        ).toBeGreaterThanOrEqual(Math.abs(positions[i].coefficient));
      }
    });

    it("returns all peaks when threshold is low", () => {
      const positions = ctx.getImportantPositions(0.1, 50);
      expect(positions.length).toBeGreaterThan(3);
    });

    it("returns empty when threshold is too high", () => {
      const positions = ctx.getImportantPositions(100, 10);
      expect(positions).toEqual([]);
    });
  });

  describe("query_wavelet_context", () => {
    it("returns fine, medium, and coarse bands", () => {
      // Center on the 'process' method
      const lines = samplePython.split("\n");
      const center = lines.findIndex((l) => l.includes("def process"));
      const result = ctx.queryWaveletContext(center, 300);

      expect(result.center).toBe(center);
      expect(result.bands.fine).toBeDefined();
      expect(result.bands.medium).toBeDefined();
      expect(result.bands.coarse).toBeDefined();

      // Fine band contains the exact method definition
      const fineContent = result.bands.fine.content;
      expect(typeof fineContent).toBe("string");
      expect(fineContent).toContain("def process");

      // Medium band covers broader class region
      const medContent = result.bands.medium.content;
      expect(typeof medContent).toBe("string");
      expect(medContent.length).toBeGreaterThan(0);

      // Coarse band covers high-level structure
      const coarseContent = result.bands.coarse.content;
      expect(typeof coarseContent).toBe("string");
      expect(coarseContent.length).toBeGreaterThan(0);
    });

    it("returns wavelet peaks near the center", () => {
      const lines = samplePython.split("\n");
      const center = lines.findIndex((l) =>
        l.includes("class DataProcessor")
      );
      const result = ctx.queryWaveletContext(center, 200);

      expect(result.waveletPeaks.length).toBeGreaterThan(0);
      for (const peak of result.waveletPeaks) {
        expect(typeof peak.position).toBe("number");
        expect(typeof peak.coefficient).toBe("number");
        expect(typeof peak.label).toBe("string");
      }
    });

    it("handles center near beginning of file", () => {
      const result = ctx.queryWaveletContext(0, 200);
      expect(result.bands.fine.content.length).toBeGreaterThan(0);
    });

    it("handles center near end of file", () => {
      const rawLines = samplePython.split("\n");
      const totalLines = rawLines[rawLines.length - 1] === ""
        ? rawLines.length - 1
        : rawLines.length;
      const result = ctx.queryWaveletContext(totalLines - 1, 200);
      expect(result.bands.fine.content.length).toBeGreaterThan(0);
    });
  });

  describe("get_summary_at_scale", () => {
    it("returns compressed view using wavelet peaks", () => {
      const summary = ctx.getSummaryAtScale(0, ctx.lineCount - 1, 4);
      expect(typeof summary).toBe("string");
      expect(summary.length).toBeGreaterThan(0);
    });

    it("handles scale selection automatically", () => {
      const summary = ctx.getSummaryAtScale(0, 50);
      expect(typeof summary).toBe("string");
      expect(summary.length).toBeGreaterThan(0);
    });
  });

  describe("get_wavelet_coefficients", () => {
    it("returns coefficients for a specific scale", () => {
      const result = ctx.getWaveletCoefficients(0, 9, 2);
      expect(result.coefficients.length).toBe(10);
      expect(result.scale).toBe(2);
      expect(result.requestedScale).toBe(2);
      for (const c of result.coefficients) {
        expect(typeof c).toBe("number");
      }
    });

    it("clamps to valid range", () => {
      const result = ctx.getWaveletCoefficients(
        -5,
        ctx.lineCount + 10,
        2,
      );
      expect(result.coefficients.length).toBe(ctx.lineCount);
    });

    it("surfaces scale substitution when an unavailable scale is requested", () => {
      const result = ctx.getWaveletCoefficients(0, 9, 3);
      expect(result.requestedScale).toBe(3);
      expect(result.scale).not.toBe(3);
      expect([2, 4]).toContain(result.scale);
    });
  });

  describe("get_summary_at_scale — auto-selection", () => {
    it("picks a small scale for a small region", () => {
      // Region ~30 lines → fine band (scale 2-ish)
      const small = ctx.getSummaryAtScale(0, 30);
      expect(typeof small).toBe("string");
      expect(small.length).toBeGreaterThan(0);
    });

    it("picks a coarse scale for a large region", () => {
      const large = ctx.getSummaryAtScale(0, ctx.lineCount - 1);
      // Should still produce a summary, not raw full text
      expect(large.length).toBeGreaterThan(0);
      expect(large.length).toBeLessThan(samplePython.length);
    });

    it("auto-selected scale differs by region size", () => {
      const smallScale = ctx.autoScale(0, 30);
      const largeScale = ctx.autoScale(0, ctx.lineCount - 1);
      expect(largeScale).toBeGreaterThan(smallScale);
    });
  });

  describe("buildSectionSummary — first peak at rangeStart regression", () => {
    it("does not emit an inverted range when the first peak lies on rangeStart", () => {
      // Force a coarse-band query that includes peak at position 0.
      const result = ctx.queryWaveletContext(0, ctx.lineCount);
      const coarse = result.bands.coarse.content;
      // No "[X-Y] ..." with X > Y
      for (const line of coarse.split("\n")) {
        const m = line.match(/^\[(\d+)-(\d+)\]/);
        if (m) {
          const x = Number(m[1]);
          const y = Number(m[2]);
          expect(x).toBeLessThanOrEqual(y);
        }
      }
    });
  });

  describe("queryWaveletContext — clamping disclosure", () => {
    it("returns clamped=true and clampedFrom when center is beyond file", () => {
      const result = ctx.queryWaveletContext(ctx.lineCount + 100, 200);
      expect(result.clamped).toBe(true);
      expect(result.clampedFrom).toBe(ctx.lineCount + 100);
      expect(result.center).toBe(ctx.lineCount - 1);
    });

    it("returns clamped=false and no clampedFrom when center is valid", () => {
      const result = ctx.queryWaveletContext(10, 200);
      expect(result.clamped).toBe(false);
      expect(result.clampedFrom).toBeUndefined();
    });
  });
});
