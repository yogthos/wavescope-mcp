import { describe, it, expect } from "vitest";
import {
  haarFwd1d,
  haarDecompose,
  haarInv1d,
  haarReconstruct,
} from "./haar.js";

describe("haarFwd1d", () => {
  it("handles empty signal", () => {
    const { approx, detail } = haarFwd1d([]);
    expect(approx).toEqual([]);
    expect(detail).toEqual([]);
  });

  it("handles length-1 signal", () => {
    const { approx, detail } = haarFwd1d([5]);
    expect(approx).toEqual([5]);
    expect(detail).toEqual([]);
  });

  it("constant signal → zero detail", () => {
    const { approx, detail } = haarFwd1d([3, 3, 3, 3]);
    expect(approx).toEqual([3, 3]);
    for (const d of detail) expect(d).toBe(0);
  });

  it("step signal → detail captures the edge", () => {
    const { approx, detail } = haarFwd1d([0, 1]);
    expect(approx[0]).toBeCloseTo(0.5, 6);
    expect(detail[0]).toBe(-1);
  });

  it("linear ramp", () => {
    const { approx, detail } = haarFwd1d([1, 2, 3, 4]);
    expect(approx[0]).toBeCloseTo(1.5, 6);
    expect(approx[1]).toBeCloseTo(3.5, 6);
    expect(detail[0]).toBe(-1);
    expect(detail[1]).toBe(-1);
  });

  it("alternating signal", () => {
    const { approx, detail } = haarFwd1d([1, -1, 1, -1]);
    expect(approx).toEqual([0, 0]);
    expect(detail).toEqual([2, 2]);
  });
});

describe("haarDecompose", () => {
  it("two levels on power-of-2 signal", () => {
    const signal = [1, 2, 3, 4, 5, 6, 7, 8];
    const decomp = haarDecompose(signal, 3);

    expect(decomp.levels.length).toBe(3);

    // Level 0 (finest): detail of pairs
    expect(decomp.levels[0].detail).toEqual([-1, -1, -1, -1]);
    expect(decomp.levels[0].approx).toEqual([1.5, 3.5, 5.5, 7.5]);

    // Level 1: detail of 4-element blocks
    expect(decomp.levels[1].detail).toEqual([-2, -2]);

    // Level 2: final approximation
    expect(decomp.finalApprox).toEqual([4.5]);
  });

  it("stops when signal too short", () => {
    const decomp = haarDecompose([1, 2], 10);
    expect(decomp.levels.length).toBe(1);
    expect(decomp.finalApprox).toEqual([1.5]);
  });

  it("empty signal", () => {
    const decomp = haarDecompose([], 3);
    expect(decomp.levels).toEqual([]);
    expect(decomp.finalApprox).toEqual([]);
  });

  it("length-1 signal", () => {
    const decomp = haarDecompose([7], 5);
    expect(decomp.levels).toEqual([]);
    expect(decomp.finalApprox).toEqual([7]);
  });
});

describe("haarInv1d", () => {
  it("inverse of forward roundtrip", () => {
    const signal = [1, 2, 3, 4, 5, 6, 7, 8];
    const { approx, detail } = haarFwd1d(signal);
    const reconstructed = haarInv1d(approx, detail);
    for (let i = 0; i < signal.length; i++) {
      expect(reconstructed[i]).toBeCloseTo(signal[i], 10);
    }
  });

  it("single element roundtrip", () => {
    const { approx, detail } = haarFwd1d([5]);
    const reconstructed = haarInv1d(approx, detail);
    expect(reconstructed).toEqual([5]);
  });
});

describe("haarReconstruct", () => {
  it("perfect reconstruction from full decomposition", () => {
    const signal = [1, 3, 5, 7, 9, 11, 13, 15];
    const decomp = haarDecompose(signal, 3);
    const reconstructed = haarReconstruct(decomp);
    for (let i = 0; i < signal.length; i++) {
      expect(reconstructed[i]).toBeCloseTo(signal[i], 10);
    }
  });

  it("perfect reconstruction with different length", () => {
    const signal = [2, 4, 6, 8];
    const decomp = haarDecompose(signal, 2);
    const reconstructed = haarReconstruct(decomp);
    for (let i = 0; i < signal.length; i++) {
      expect(reconstructed[i]).toBeCloseTo(signal[i], 10);
    }
  });

  it("perfect reconstruction with random signal", () => {
    const signal = [0.5, -1.2, 3.7, 2.1, -0.8, 4.4, 1.1, -2.3];
    const decomp = haarDecompose(signal, 3);
    const reconstructed = haarReconstruct(decomp);
    for (let i = 0; i < signal.length; i++) {
      expect(reconstructed[i]).toBeCloseTo(signal[i], 10);
    }
  });
});
