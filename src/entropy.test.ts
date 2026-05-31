import { describe, it, expect } from "vitest";
import {
  analyzeDecomposition,
  computeComplexityHeatmap,
  perLineIrregularity,
  EntropyBand,
  ComplexityHeatmap,
} from "./entropy.js";
import { haarDecompose } from "./haar.js";

describe("analyzeDecomposition", () => {
  it("produces one band per decomposition level", () => {
    const signal = [1, 2, 3, 4, 5, 6, 7, 8];
    const decomp = haarDecompose(signal, 3);
    const bands = analyzeDecomposition(decomp);
    expect(bands.length).toBe(3);
    for (const b of bands) {
      expect(b.bitCost).toBeGreaterThan(0);
      expect(b.riceK).toBeGreaterThanOrEqual(0);
      expect(b.riceK).toBeLessThanOrEqual(6);
      expect(["running", "zero"]).toContain(b.predictor);
      expect(typeof b.sparseFlag).toBe("boolean");
      expect(b.numGroups).toBeGreaterThanOrEqual(1);
    }
  });

  it("spans increase with level", () => {
    const signal = new Array(32).fill(0).map((_, i) => i);
    const decomp = haarDecompose(signal, 4);
    const bands = analyzeDecomposition(decomp);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].span).toBe(bands[i - 1].span * 2);
    }
  });

  it("constant signal → low entropy", () => {
    const signal = new Array(16).fill(5);
    const decomp = haarDecompose(signal, 4);
    const bands = analyzeDecomposition(decomp);
    for (const b of bands) {
      expect(b.bitCost).toBeLessThan(100);
    }
  });

  it("irregular signal → higher entropy than constant", () => {
    const constant = new Array(16).fill(5);
    const irregular = [1, 10, -5, 20, 3, -15, 7, -2, 12, -8, 0, 5, -3, 18, -1, 6];
    const constBands = analyzeDecomposition(haarDecompose(constant, 4));
    const irrBands = analyzeDecomposition(haarDecompose(irregular, 4));
    const constTotal = constBands.reduce((s, b) => s + b.bitCost, 0);
    const irrTotal = irrBands.reduce((s, b) => s + b.bitCost, 0);
    expect(irrTotal).toBeGreaterThan(constTotal);
  });

  it("lossyBits > 0 reduces entropy", () => {
    const signal = [1, 10, -5, 20, 3, -15, 7, -2, 12, -8, 0, 5, -3, 18, -1, 6];
    const decomp = haarDecompose(signal, 4);
    const lossless = analyzeDecomposition(decomp, 0);
    const lossy = analyzeDecomposition(decomp, 4);
    const losslessTotal = lossless.reduce((s, b) => s + b.bitCost, 0);
    const lossyTotal = lossy.reduce((s, b) => s + b.bitCost, 0);
    expect(lossyTotal).toBeLessThanOrEqual(losslessTotal);
  });

  it("bpcs array matches numGroups", () => {
    const signal = new Array(16).fill(3);
    const decomp = haarDecompose(signal, 4);
    const bands = analyzeDecomposition(decomp);
    for (const b of bands) {
      expect(b.bpcs.length).toBe(b.numGroups);
    }
  });

  it("handles single-level decomposition", () => {
    const signal = [1, 2];
    const decomp = haarDecompose(signal, 1);
    const bands = analyzeDecomposition(decomp);
    expect(bands.length).toBe(1);
    expect(bands[0].level).toBe(0);
    expect(bands[0].span).toBe(2);
  });
});

describe("computeComplexityHeatmap", () => {
  it("returns empty result for empty signal", () => {
    const result = computeComplexityHeatmap([]);
    expect(result.bands).toEqual([]);
    expect(result.totalEntropy).toBe(0);
    expect(result.signalLength).toBe(0);
  });

  it("returns valid heatmap for simple signal", () => {
    const signal = [1, 0, 1, 0, 1, 0, 1, 0];
    const result = computeComplexityHeatmap(signal);
    expect(result.signalLength).toBe(8);
    expect(result.bands.length).toBeGreaterThanOrEqual(1);
    expect(result.totalEntropy).toBeGreaterThan(0);
  });

  it("caps levels at 8", () => {
    const signal = new Array(1024).fill(0).map((_, i) => Math.sin(i * 0.1));
    const result = computeComplexityHeatmap(signal);
    expect(result.bands.length).toBeLessThanOrEqual(8);
  });

  it("alternating signal has entropy in finest bands", () => {
    // Alternating: every pair has high detail
    const signal = [1, -1, 1, -1, 1, -1, 1, -1];
    const result = computeComplexityHeatmap(signal);
    // Finest band (level 0) should have significant entropy
    const level0 = result.bands[0];
    expect(level0.bitCost).toBeGreaterThan(0);
    expect(level0.level).toBe(0);
  });

  it("respects lossyBits parameter", () => {
    const signal = [1, 2, 3, 4, 5, 6, 7, 8];
    const precise = computeComplexityHeatmap(signal, 0);
    const coarse = computeComplexityHeatmap(signal, 8);
    expect(coarse.totalEntropy).toBeLessThanOrEqual(precise.totalEntropy);
  });

  it("returns consistent results for same input", () => {
    const signal = [0.5, 1.2, 0.8, 2.1, 0.3, 1.7, 0.9, 1.5];
    const a = computeComplexityHeatmap(signal);
    const b = computeComplexityHeatmap(signal);
    expect(a.totalEntropy).toBe(b.totalEntropy);
    expect(a.bands.length).toBe(b.bands.length);
    for (let i = 0; i < a.bands.length; i++) {
      expect(a.bands[i].bitCost).toBe(b.bands[i].bitCost);
      expect(a.bands[i].riceK).toBe(b.bands[i].riceK);
    }
  });
});

describe("perLineIrregularity", () => {
  it("returns array of correct length", () => {
    const signal = [1, 2, 3, 4, 5, 6, 7, 8];
    const decomp = haarDecompose(signal, 3);
    const bands = analyzeDecomposition(decomp);
    const scores = perLineIrregularity(decomp, bands, signal.length);
    expect(scores.length).toBe(signal.length);
  });

  it("gives zero scores for constant signal", () => {
    const signal = new Array(8).fill(3);
    const decomp = haarDecompose(signal, 3);
    const bands = analyzeDecomposition(decomp);
    const scores = perLineIrregularity(decomp, bands, signal.length);
    for (const s of scores) expect(s).toBe(0);
  });

  it("higher scores near irregular regions", () => {
    // Create a signal with a spike at position 4
    const signal = [0, 0, 0, 0, 10, 0, 0, 0];
    const decomp = haarDecompose(signal, 3);
    const bands = analyzeDecomposition(decomp);
    const scores = perLineIrregularity(decomp, bands, signal.length);
    // The spike region should have higher scores
    expect(scores[4]).toBeGreaterThan(scores[0]);
    expect(scores[4]).toBeGreaterThan(scores[7]);
  });
});
