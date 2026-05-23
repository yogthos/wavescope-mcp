import { describe, it, expect } from "vitest";
import {
  rickerWavelet,
  computeCWT,
  detectPeaks,
  WaveletCoefficients,
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
    expect(result.coefficients.length).toBe(0);
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
});
