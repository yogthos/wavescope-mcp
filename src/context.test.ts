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

  describe("getSummaryAtScale — out-of-range handling", () => {
    it("does not crash when start is past end of file", () => {
      expect(() =>
        ctx.getSummaryAtScale(ctx.lineCount + 1000, ctx.lineCount + 2000),
      ).not.toThrow();
      const result = ctx.getSummaryAtScale(
        ctx.lineCount + 1000,
        ctx.lineCount + 2000,
      );
      expect(result).toBe("");
    });

    it("does not crash when end is negative", () => {
      expect(() => ctx.getSummaryAtScale(-100, -10)).not.toThrow();
      expect(ctx.getSummaryAtScale(-100, -10)).toBe("");
    });

    it("clamps when one bound is out of range but other is valid", () => {
      const result = ctx.getSummaryAtScale(0, ctx.lineCount + 1000);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("recovers a valid window from a swapped-negative pair", () => {
      // (start=10, end=-5) overlaps lines 0..10 once normalized — do not drop.
      const result = ctx.getSummaryAtScale(10, -5);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("returns empty for start exactly past end of file", () => {
      expect(ctx.getSummaryAtScale(ctx.lineCount, ctx.lineCount)).toBe("");
    });
  });

  describe("getWaveletCoefficients — out-of-range handling", () => {
    it("does not silently return last coefficient when start is past end of file", () => {
      const result = ctx.getWaveletCoefficients(
        ctx.lineCount + 1000,
        ctx.lineCount + 2000,
        2,
      );
      // Should be empty rather than returning a misleading single coefficient
      expect(result.coefficients).toEqual([]);
      expect(result.clamped).toBe(true);
    });

    it("flags clamping when bounds are partially out of range", () => {
      const result = ctx.getWaveletCoefficients(
        -5,
        ctx.lineCount + 10,
        2,
      );
      expect(result.coefficients.length).toBe(ctx.lineCount);
      expect(result.clamped).toBe(true);
      expect(result.clampedFrom).toEqual({ start: -5, end: ctx.lineCount + 10 });
    });

    it("does not flag clamping when bounds are in range", () => {
      const result = ctx.getWaveletCoefficients(0, 9, 2);
      expect(result.clamped).toBe(false);
      expect(result.clampedFrom).toBeUndefined();
    });

    it("does not crash and reports clamping when end is negative", () => {
      const result = ctx.getWaveletCoefficients(-100, -10, 2);
      expect(result.coefficients).toEqual([]);
      expect(result.clamped).toBe(true);
    });

    it("recovers a valid window from a swapped-negative pair", () => {
      const result = ctx.getWaveletCoefficients(10, -5, 2);
      expect(result.coefficients.length).toBe(11);
      expect(result.clamped).toBe(true);
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

describe("FileContext — coarse peaks survive next to a dominant fine spike (Round 1)", () => {
  // A single sharp structural line surrounded by zero-signal comment lines:
  // every scale peaks at line 100, but the strongest is the finest scale.
  // With cross-scale collapse the coarse peak at 100 was dropped, so a
  // coarse-scale summary fell back to even-sampled lines and lost it.
  const lines: string[] = [];
  for (let i = 0; i < 200; i++) lines.push(i === 100 ? "class Foo:" : "# filler");
  const ctx = new FileContext("spike.py", lines.join("\n"));

  it("surfaces the structural boundary at a coarse scale instead of dropping it", () => {
    const summary = ctx.getSummaryAtScale(0, ctx.lineCount - 1, 128);
    expect(summary).toContain("class Foo");
  });

  it("still ranks the boundary in get_important_positions", () => {
    const positions = ctx.getImportantPositions(0.1, 10);
    expect(positions.some((p) => p.position === 100)).toBe(true);
  });
});

describe("FileContext — inferLabel keeps hyphenated identifiers (Round 4)", () => {
  // Isolate the hyphenated defn as a lone high-signal line among comments so
  // it reliably surfaces as the dominant peak.
  const lines: string[] = [];
  for (let i = 0; i < 41; i++) lines.push("; comment");
  lines[20] = "(defn foo-bar [x] x)";
  const ctx = new FileContext("app.clj", lines.join("\n"));

  it("labels a Clojure defn with its full hyphenated name", () => {
    const labels = ctx.getImportantPositions(0.0, 10).map((p) => p.label);
    // Pre-fix the label-tokenizer split on '-' truncated this to "defn foo".
    expect(labels.some((l) => l === "defn foo-bar")).toBe(true);
  });
});

describe("FileContext — Lisp-family labels", () => {
  function labelFor(filename: string, line: string): string | undefined {
    // Isolate the form among comment lines so it is the dominant peak.
    const lines: string[] = [];
    for (let i = 0; i < 41; i++) lines.push("; comment");
    lines[20] = line;
    const ctx = new FileContext(filename, lines.join("\n"));
    return ctx.getImportantPositions(0.0, 10).find((p) => p.position === 20)?.label;
  }

  it("labels a Scheme define with the defined name", () => {
    expect(labelFor("a.scm", "(define (square x) (* x x))")).toBe("define square");
  });

  it("labels a Scheme define-record-type", () => {
    expect(labelFor("a.scm", "(define-record-type point (make-point x y) point?)"))
      .toBe("define-record-type point");
  });

  it("labels a Common Lisp defun and defclass", () => {
    expect(labelFor("a.lisp", "(defun square (x) (* x x))")).toBe("defun square");
    expect(labelFor("a.lisp", "(defclass point () ((x) (y)))")).toBe("defclass point");
  });

  it("labels an Emacs Lisp define-minor-mode with its hyphenated name", () => {
    expect(labelFor("init.el", "(define-minor-mode my-cool-mode \"doc\")"))
      .toBe("define-minor-mode my-cool-mode");
  });

  it("labels Clojure defmulti/defmethod/defonce (previously fell back to raw line)", () => {
    expect(labelFor("a.clj", "(defmulti area :shape)")).toBe("defmulti area");
    expect(labelFor("a.clj", "(defmethod area :circle [c] 1)")).toBe("defmethod area");
    expect(labelFor("a.clj", "(defonce server (start))")).toBe("defonce server");
  });

  it("labels a Clojure ns form", () => {
    expect(labelFor("a.clj", "(ns my.app.core (:require [x]))")).toBe("ns my.app.core");
  });

  it("keeps the raw #lang line for Racket module headers", () => {
    expect(labelFor("a.rkt", "#lang racket")).toBe("#lang racket");
  });
});

describe("FileContext — CRLF line endings", () => {
  it("strips \\r so band content and labels are clean", () => {
    const ctx = new FileContext("a.ts", "export class Foo {}\r\nconst x = 1;\r\n");
    expect(ctx.lineCount).toBe(2);
    expect(ctx.lines[0]).toBe("export class Foo {}");
    const fine = ctx.queryWaveletContext(0, 10).bands.fine.content;
    expect(fine).not.toContain("\r");
  });
});

describe("FileContext — important positions skip blank-line troughs", () => {
  const scheme = `#lang racket
(require racket/list)

(define (make-stack) (stack '()))

(define (push s x)
  (set-stack-items! s (cons x (stack-items s))))

(define (pop s)
  (car (stack-items s)))

(define-syntax-rule (swap! a b)
  (let ([tmp a]) (set! a b) (set! b tmp)))
`;

  const typescript = `import { list } from "./list";

export function makeStack() { return []; }

export function push(s, x) { s.push(x); }

export function pop(s) {
  return s.pop();
}

export const swap = (a, b) => [b, a];
`;

  for (const [name, src] of [["stack.rkt", scheme], ["stack.ts", typescript]] as const) {
    describe(name, () => {
      const ctx = new FileContext(name, src);
      const positions = ctx.getImportantPositions(0.2, 10);

      it("returns at least one position", () => {
        expect(positions.length).toBeGreaterThan(0);
      });

      it("never anchors a position on a blank line", () => {
        for (const p of positions) {
          expect(ctx.lines[p.position].trim()).not.toBe("");
        }
      });

      it("returns only positive coefficients", () => {
        for (const p of positions) {
          expect(p.coefficient).toBeGreaterThan(0);
        }
      });

      it("produces no generic 'line N' labels", () => {
        for (const p of positions) {
          expect(p.label).not.toMatch(/^line \d+$/);
        }
      });
    });
  }

  it("still anchors on the real definition lines (Scheme)", () => {
    const ctx = new FileContext("stack.rkt", scheme);
    const labels = ctx.getImportantPositions(0.2, 10).map((p) => p.label);
    expect(labels.some((l) => l.startsWith("define"))).toBe(true);
  });
});

describe("FileContext — band assembly still uses both peak signs", () => {
  const lines: string[] = [];
  for (let i = 0; i < 200; i++) lines.push("");
  for (const i of [20, 60, 100, 140]) lines[i] = `export function f${i}() {}`;
  const ctx = new FileContext("wide.ts", lines.join("\n"));

  it("getSummaryAtScale still summarizes a region containing troughs", () => {
    const summary = ctx.getSummaryAtScale(0, 199);
    expect(summary.length).toBeGreaterThan(0);
  });

  it("queryWaveletContext still returns coarse-band structure", () => {
    const ctx2 = ctx.queryWaveletContext(100, 200);
    expect(ctx2.bands.coarse.content.length).toBeGreaterThan(0);
    expect(ctx2.bands.medium.content.length).toBeGreaterThan(0);
  });
});
