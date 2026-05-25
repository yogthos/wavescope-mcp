/**
 * Ricker (Mexican hat) wavelet: ψ(t) = (1 - t²) · exp(-t²/2)
 */
export function rickerWavelet(t: number): number {
  const t2 = t * t;
  return (1 - t2) * Math.exp(-t2 / 2);
}

/**
 * Generate wavelet kernel values for scale a, centered at 0.
 * Truncated to ±5a (covers ~99.99% of the Ricker energy) but bounded
 * by half the signal length to keep the kernel finite on short inputs.
 * Includes 1/√a normalization to keep coefficient magnitudes comparable
 * across scales.
 */
function makeKernel(a: number, numPoints: number): number[] {
  if (!Number.isFinite(a) || a <= 0) throw new Error(`Invalid scale: ${a}`);
  const halfWidth = Math.ceil(5 * a);
  const half = Math.min(halfWidth, Math.ceil(numPoints / 2));
  const invSqrtA = 1 / Math.sqrt(a);
  const kernel: number[] = [];
  for (let t = -half; t <= half; t++) {
    kernel.push(invSqrtA * rickerWavelet(t / a));
  }
  return kernel;
}

export interface WaveletCoefficients {
  scales: number[];
  coefficients: number[][]; // [scaleIndex][position]
}

export interface Peak {
  position: number;
  coefficient: number;
  scale: number;
  label?: string;
}

export type Boundary = "reflect" | "zero";

export interface CWTOptions {
  boundary?: Boundary;
}

const DEFAULT_SCALES = [1, 2, 4, 8, 16, 32, 64, 128];

/**
 * Reflect-index: mirror out-of-range indices back into [0, N-1].
 * Used to suppress boundary artifacts where the wavelet's negative
 * lobes would otherwise be clipped by zero-padding.
 */
function reflectIndex(idx: number, N: number): number {
  if (N === 1) return 0;
  const period = 2 * (N - 1);
  let i = idx % period;
  if (i < 0) i += period;
  return i >= N ? period - i : i;
}

/**
 * Compute the Continuous Wavelet Transform (Ricker) over the signal.
 *
 * For each scale a, the wavelet ψ_a(t) = (1/√a)·ψ(t/a) is convolved
 * with the signal. The result for scale a at position b is:
 *   W(a, b) = Σ_t ψ_a(t-b) · signal[t]
 *
 * Boundary handling defaults to symmetric reflection; pass
 * `{ boundary: "zero" }` for the older zero-pad behavior.
 */
export function computeCWT(
  signal: number[],
  scales: number[] = DEFAULT_SCALES,
  options: CWTOptions = {},
): WaveletCoefficients {
  const boundary = options.boundary ?? "reflect";
  const N = signal.length;
  const usedScales: number[] = [];
  for (const a of scales) {
    if (!usedScales.includes(a)) usedScales.push(a);
  }
  const coefficients: number[][] = [];

  if (N === 0) {
    return { scales: usedScales, coefficients: usedScales.map(() => []) };
  }

  for (const a of usedScales) {
    const kernel = makeKernel(a, N);
    const halfKernel = Math.floor(kernel.length / 2);
    const coeffs = new Array<number>(N);

    for (let pos = 0; pos < N; pos++) {
      let sum = 0;
      for (let k = 0; k < kernel.length; k++) {
        const signalIdx = pos + k - halfKernel;
        if (signalIdx >= 0 && signalIdx < N) {
          sum += kernel[k] * signal[signalIdx];
        } else if (boundary === "reflect") {
          sum += kernel[k] * signal[reflectIndex(signalIdx, N)];
        }
      }
      coeffs[pos] = sum;
    }

    coefficients.push(coeffs);
  }

  return { scales: usedScales, coefficients };
}

/**
 * Detect local maxima in wavelet coefficient magnitudes across all scales.
 *
 * Returns peaks sorted by |coefficient| descending. Each peak is a
 * local maximum in its scale band — meaning it's larger than its
 * immediate neighbors at the same scale.
 *
 * Plateau handling: >= left, > right — selects the rightmost element
 * of a flat plateau region.
 *
 * Cross-scale ridge collapse: a single structural feature produces local
 * maxima at the same position across multiple scales. After magnitude
 * sorting, peaks whose position is within `ridgeWindow` of an already-kept
 * stronger peak are dropped, so a single spike yields one peak (the
 * dominant scale) rather than one per scale.
 */
export function detectPeaks(
  cwt: WaveletCoefficients,
  threshold: number,
  maxPeaks: number = 250,
  ridgeWindow: number = 2,
): Peak[] {
  if (cwt.coefficients.length === 0) return [];

  const peaks: Peak[] = [];

  for (let si = 0; si < cwt.scales.length; si++) {
    const scale = cwt.scales[si];
    const coeffs = cwt.coefficients[si];
    const N = coeffs.length;

    for (let pos = 0; pos < N; pos++) {
      const mag = Math.abs(coeffs[pos]);
      if (mag < threshold) continue;

      const leftOk = pos === 0 || mag >= Math.abs(coeffs[pos - 1]);
      const rightOk = pos === N - 1 || mag > Math.abs(coeffs[pos + 1]);

      if (leftOk && rightOk) {
        peaks.push({
          position: pos,
          coefficient: coeffs[pos],
          scale,
        });
      }
    }
  }

  peaks.sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient));

  const kept: Peak[] = [];
  for (const peak of peaks) {
    let overlap = false;
    for (const k of kept) {
      if (Math.abs(k.position - peak.position) <= ridgeWindow) {
        overlap = true;
        break;
      }
    }
    if (!overlap) kept.push(peak);
    if (kept.length >= maxPeaks) break;
  }

  return kept;
}
