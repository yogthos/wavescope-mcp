/**
 * Haar Discrete Wavelet Transform — single-level and multi-level.
 *
 * The Haar wavelet is the simplest possible wavelet:
 *   forward:  approx_k = (x_{2k} + x_{2k+1}) / 2
 *             detail_k = x_{2k} - x_{2k+1}
 *   inverse:  x_{2k} = approx_k + detail_k / 2
 *             x_{2k+1} = approx_k - detail_k / 2
 *
 * Multi-level: repeatedly apply forward to the approximation band,
 * stacking all detail bands + final approximation.
 */

export interface HaarLevel {
  /** Approximation coefficients at this level */
  approx: number[];
  /** Detail coefficients at this level */
  detail: number[];
}

export interface HaarDecomposition {
  /** Detail bands from each level (finest first) */
  levels: HaarLevel[];
  /** Final approximation (single coarsest value) */
  finalApprox: number[];
}

/**
 * Single-level forward Haar transform.
 *
 * Odd-length signals: the last element is dropped (signal length must
 * be even for perfect reconstruction). Use power-of-2 signals or
 * pre-pad to even length.
 */
export function haarFwd1d(signal: number[]): { approx: number[]; detail: number[] } {
  const n = signal.length;
  if (n === 0) return { approx: [], detail: [] };
  if (n === 1) return { approx: [signal[0]], detail: [] };

  const halfLen = n >> 1;
  const approx = new Array<number>(halfLen);
  const detail = new Array<number>(halfLen);

  for (let i = 0; i < halfLen; i++) {
    const a = signal[2 * i];
    const b = signal[2 * i + 1];
    approx[i] = (a + b) / 2;
    detail[i] = a - b;
  }

  return { approx, detail };
}

/**
 * Multi-level Haar decomposition.
 *
 * Applies `levels` iterations of the forward transform, each time
 * operating on the previous level's approximation coefficients.
 * Returns detail bands from each level plus the final approximation.
 *
 * Signal length must be a power of 2 for the requested number of levels.
 * If it's not, decomposition stops early when the approximation band
 * reaches length < 2.
 */
export function haarDecompose(signal: number[], levels: number): HaarDecomposition {
  const result: HaarLevel[] = [];
  let approx = signal.slice();

  for (let lev = 0; lev < levels; lev++) {
    if (approx.length < 2) break;
    const { approx: nextApprox, detail } = haarFwd1d(approx);
    result.push({ approx: nextApprox, detail });
    approx = nextApprox;
  }

  return { levels: result, finalApprox: approx };
}

/**
 * Single-level inverse Haar transform.
 *
 * Reconstructs the original signal from approximation and detail
 * coefficients of a single level.
 */
export function haarInv1d(approx: number[], detail: number[]): number[] {
  if (approx.length === 0) return [];
  // Length-1 signal: haarFwd1d produces approx=[x], detail=[].
  // An empty detail array unambiguously signals original length 1,
  // whereas detail=[0] would be ambiguous with a constant pair.
  if (detail.length === 0) return [approx[0]];

  const n = approx.length * 2;
  const result = new Array<number>(n);

  for (let i = 0; i < approx.length; i++) {
    const halfDiff = detail[i] / 2;
    result[2 * i] = approx[i] + halfDiff;
    result[2 * i + 1] = approx[i] - halfDiff;
  }

  return result;
}

/**
 * Reconstruct the original signal from a full multi-level decomposition.
 */
export function haarReconstruct(decomp: HaarDecomposition): number[] {
  let approx = decomp.finalApprox;

  for (let lev = decomp.levels.length - 1; lev >= 0; lev--) {
    approx = haarInv1d(approx, decomp.levels[lev].detail);
  }

  return approx;
}
