import { describe, it, expect } from "vitest";
import {
  rickerWavelet,
  computeCWT,
  detectPeaks,
  Peak,
} from "./wavelet.js";

describe("rickerWavelet", () => {
  it("has value 1 at t=0", () => {
    expect(rickerWavelet(0)).toBeCloseTo(1.0, 5);
  });

  it("is symmetric: ψ(t) = ψ(-t)", () => {
    for (const t of [0.5, 1.0, 2.0, 3.0]) {
      expect(rickerWavelet(t)).toBeCloseTo(rickerWavelet(-t), 8);
    }
  });

  it("decays to near zero beyond |t| > 5", () => {
    expect(Math.abs(rickerWavelet(5))).toBeLessThan(0.01);
    expect(Math.abs(rickerWavelet(8))).toBeLessThan(0.001);
  });

  it("has negative lobes and zero crossings at t=±1", () => {
    expect(rickerWavelet(2)).toBeLessThan(0);
    expect(rickerWavelet(1)).toBeCloseTo(0, 5);
    expect(rickerWavelet(-1)).toBeCloseTo(0, 5);
  });
});

describe("computeCWT", () => {
  it("returns coefficient matrix with correct dimensions", () => {
    const signal = new Array(100).fill(0);
    const scales = [1, 2, 4, 8];
    const result = computeCWT(signal, scales);
    expect(result.scales).toEqual(scales);
    expect(result.coefficients.length).toBe(scales.length);
    expect(result.coefficients[0].length).toBe(signal.length);
  });

  it("handles empty signal gracefully", () => {
    const result = computeCWT([], [1, 2, 4]);
    expect(result.scales).toEqual([1, 2, 4]);
    expect(result.coefficients.length).toBe(result.scales.length);
    expect(result.coefficients.every((c) => c.length === 0)).toBe(true);
  });

  it("detects a single spike at the correct position", () => {
    const signal = new Array(100).fill(0);
    signal[50] = 1.0;

    const result = computeCWT(signal, [1, 2, 4]);

    const scale0Coeffs = result.coefficients[0];
    const peakIdx = scale0Coeffs.reduce(
      (maxIdx: number, val: number, idx: number, arr: number[]) =>
        Math.abs(val) > Math.abs(arr[maxIdx]) ? idx : maxIdx,
      0,
    );
    expect(peakIdx).toBeGreaterThanOrEqual(48);
    expect(peakIdx).toBeLessThanOrEqual(52);
  });

  it("gives stronger response for larger signals", () => {
    const signalSmall = new Array(100).fill(0);
    signalSmall[50] = 0.5;
    const signalLarge = new Array(100).fill(0);
    signalLarge[50] = 1.5;

    const resultSmall = computeCWT(signalSmall, [2]);
    const resultLarge = computeCWT(signalLarge, [2]);

    expect(Math.abs(resultLarge.coefficients[0][50])).toBeGreaterThan(
      Math.abs(resultSmall.coefficients[0][50]),
    );
  });

  it("smooth signal has low coefficients away from boundaries", () => {
    const MARGIN = 64;
    const signal = new Array(200).fill(0.5);
    const result = computeCWT(signal, [1, 4, 16]);
    for (const coeffs of result.coefficients) {
      for (let i = MARGIN; i < coeffs.length - MARGIN; i++) {
        expect(Math.abs(coeffs[i])).toBeLessThan(0.05);
      }
    }
  });
});

describe("detectPeaks", () => {
  it("finds peaks above threshold", () => {
    const signal = new Array(200).fill(0);
    signal[50] = 1.0;
    signal[100] = 1.0;
    signal[150] = 0.3;

    const result = computeCWT(signal, [1, 2, 4, 8, 16, 32]);
    const peaks = detectPeaks(result, 0.5);

    expect(peaks.length).toBeGreaterThan(0);

    const positions = peaks.map((p: Peak) => p.position);
    const hasNear50 = positions.some((p: number) => p >= 48 && p <= 52);
    const hasNear100 = positions.some((p: number) => p >= 98 && p <= 102);

    expect(hasNear50).toBe(true);
    expect(hasNear100).toBe(true);
  });

  it("returns empty array when no peaks above threshold", () => {
    const signal = new Array(50).fill(0.1);
    const result = computeCWT(signal, [1, 2, 4]);
    const peaks = detectPeaks(result, 10.0);
    expect(peaks).toEqual([]);
  });

  it("peaks are sorted by coefficient magnitude descending", () => {
    const signal = new Array(100).fill(0);
    signal[30] = 0.5;
    signal[60] = 2.0;
    signal[80] = 1.0;

    const result = computeCWT(signal, [1, 2, 4]);
    const peaks = detectPeaks(result, 0.3);

    for (let i = 1; i < peaks.length; i++) {
      expect(Math.abs(peaks[i - 1].coefficient)).toBeGreaterThanOrEqual(
        Math.abs(peaks[i].coefficient),
      );
    }
  });

  it("includes scale information in peaks", () => {
    const signal = new Array(100).fill(0);
    signal[40] = 1.0;

    const result = computeCWT(signal, [1, 4, 16]);
    const peaks = detectPeaks(result, 0.5);

    for (const peak of peaks) {
      expect(peak.scale).toBeGreaterThanOrEqual(1);
      expect(typeof peak.position).toBe("number");
      expect(typeof peak.coefficient).toBe("number");
    }
  });

  it("collapses cross-scale ridges to a single peak per position", () => {
    const signal = new Array(200).fill(0);
    signal[100] = 1.0;

    const result = computeCWT(signal, [1, 2, 4, 8, 16, 32, 64, 128]);
    const peaks = detectPeaks(result, 0.1);

    const nearSpike = peaks.filter((p) => Math.abs(p.position - 100) <= 2);
    expect(nearSpike.length).toBe(1);
  });
});

describe("computeCWT — kernel correctness at large scales", () => {
  it("constant signal produces near-zero coefficients at scale 128 on a 4096-sample signal", () => {
    const signal = new Array(4096).fill(0.5);
    const result = computeCWT(signal, [128]);
    const coeffs = result.coefficients[0];
    const MARGIN = 1024;
    for (let i = MARGIN; i < coeffs.length - MARGIN; i++) {
      expect(Math.abs(coeffs[i])).toBeLessThan(0.01);
    }
  });
});

describe("computeCWT — input validation", () => {
  it("throws on NaN scale", () => {
    expect(() => computeCWT([1, 2, 3], [NaN])).toThrow();
  });

  it("throws on Infinity scale", () => {
    expect(() => computeCWT([1, 2, 3], [Infinity])).toThrow();
  });

  it("deduplicates repeated scales in input", () => {
    const signal = new Array(50).fill(0);
    signal[25] = 1;
    const result = computeCWT(signal, [1, 1, 2, 2, 4]);
    expect(result.scales).toEqual([1, 2, 4]);
    expect(result.coefficients.length).toBe(3);
  });
});

describe("computeCWT — boundary handling", () => {
  it("constant signal at the boundary gives near-zero coefficient under default (reflect)", () => {
    const signal = new Array(200).fill(0.5);
    const result = computeCWT(signal, [4, 8, 16]);
    for (const coeffs of result.coefficients) {
      expect(Math.abs(coeffs[0])).toBeLessThan(0.05);
      expect(Math.abs(coeffs[coeffs.length - 1])).toBeLessThan(0.05);
    }
  });

  it("opt-in zero boundary still works (back-compat)", () => {
    const signal = new Array(200).fill(0.5);
    const result = computeCWT(signal, [16], { boundary: "zero" });
    expect(result.coefficients[0].length).toBe(200);
  });
});

describe("detectPeaks — disable collapse (ridgeWindow < 0)", () => {
  it("preserves cross-scale peaks at a position when collapse is disabled", () => {
    const signal = new Array(200).fill(0);
    signal[100] = 1.0;

    const result = computeCWT(signal, [1, 2, 4, 8, 16, 32, 64, 128]);
    const collapsed = detectPeaks(result, 0.1);
    const all = detectPeaks(result, 0.1, 1000, -1);

    const nearCollapsed = collapsed.filter((p) => Math.abs(p.position - 100) <= 2);
    const nearAll = all.filter((p) => Math.abs(p.position - 100) <= 2);

    // Default collapses the ridge to one peak; disabled keeps every scale.
    expect(nearCollapsed.length).toBe(1);
    expect(nearAll.length).toBeGreaterThan(1);
    expect(new Set(nearAll.map((p) => p.scale)).size).toBeGreaterThan(1);
  });
});

describe("detectPeaks — positiveOnly", () => {
  it("returns only positive-coefficient peaks when enabled", () => {
    const signal = new Array(200).fill(0);
    signal[50] = 1.0;
    signal[120] = 2.0;

    const result = computeCWT(signal, [1, 2, 4, 8, 16, 32]);
    const all = detectPeaks(result, 0.1, 1000, 2, false);
    const positive = detectPeaks(result, 0.1, 1000, 2, true);

    expect(all.some((p) => p.coefficient < 0)).toBe(true);
    expect(positive.every((p) => p.coefficient > 0)).toBe(true);
    expect(positive.length).toBeGreaterThan(0);
  });

  it("filters before ridge collapse so a positive peak is not suppressed by a stronger adjacent negative one", () => {
    // A lone spike: the Ricker negative lobes flank the positive centre
    // closely at fine scales. Post-filtering would let a stronger negative
    // lobe ridge-collapse the positive peak out of existence.
    const signal = new Array(200).fill(0);
    signal[100] = 1.0;

    const positive = detectPeaks(result(signal), 0.05, 1000, 8, true);
    expect(positive.some((p) => Math.abs(p.position - 100) <= 2)).toBe(true);

    function result(s: number[]) {
      return computeCWT(s, [1, 2, 4, 8, 16, 32, 64, 128]);
    }
  });

  it("defaults to keeping negative peaks", () => {
    const signal = new Array(200).fill(0);
    signal[100] = 1.0;
    const result = computeCWT(signal, [1, 2, 4, 8, 16, 32]);
    expect(detectPeaks(result, 0.1, 1000, -1)).toEqual(
      detectPeaks(result, 0.1, 1000, -1, false),
    );
  });
});

describe("computeCWT — kernel stays zero-mean when truncated", () => {
  // A wavelet has zero mean by definition, so a signal with no variation
  // must transform to zero. Truncating the kernel to the signal length used
  // to clip away the negative lobes, leaving a box filter with a large DC
  // response: a flat signal produced 6.53 at scale 128 on 200 samples.
  for (const N of [33, 60, 100, 200, 512]) {
    it(`constant signal produces near-zero coefficients at every scale (N=${N})`, () => {
      const flat = new Array(N).fill(0.5);
      const result = computeCWT(flat);
      for (let si = 0; si < result.scales.length; si++) {
        const mid = result.coefficients[si][Math.floor(N / 2)];
        expect(Math.abs(mid), `scale ${result.scales[si]}`).toBeLessThan(0.05);
      }
    });
  }

  it("holds for a non-zero constant at any offset", () => {
    const flat = new Array(80).fill(2.0);
    const result = computeCWT(flat);
    for (let si = 0; si < result.scales.length; si++) {
      for (const pos of [20, 40, 60]) {
        expect(Math.abs(result.coefficients[si][pos])).toBeLessThan(0.2);
      }
    }
  });

  it("still responds to a real spike at coarse scales", () => {
    // The fix must not flatten genuine structure into nothing.
    const signal = new Array(200).fill(0);
    signal[100] = 1.0;
    const result = computeCWT(signal, [32, 64]);
    for (let si = 0; si < result.scales.length; si++) {
      expect(Math.abs(result.coefficients[si][100])).toBeGreaterThan(0.01);
    }
  });

  it("still separates a step change from a flat region", () => {
    const signal = [...new Array(100).fill(0), ...new Array(100).fill(1)];
    const result = computeCWT(signal, [16]);
    const atStep = Math.abs(result.coefficients[0][100]);
    const inFlat = Math.abs(result.coefficients[0][40]);
    expect(atStep).toBeGreaterThan(inFlat);
  });
});
