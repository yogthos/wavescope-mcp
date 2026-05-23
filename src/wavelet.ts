/**
 * Ricker (Mexican hat) wavelet: ψ(t) = (1 - t²) · exp(-t²/2)
 */
export function rickerWavelet(t: number): number {
  const t2 = t * t;
  return (1 - t2) * Math.exp(-t2 / 2);
}

/**
 * Generate wavelet kernel values for scale a, centered at 0.
 * Truncated to ±4a (but capped at the signal length to avoid
 * oversized kernels for large scales on small signals).
 * Includes 1/√a normalization to keep coefficient magnitudes
 * comparable across scales.
 */
function makeKernel(a: number, numPoints: number): number[] {
  if (a <= 0) throw new Error(`Invalid scale: ${a}`);
  // Cap kernel half-width: 4*a but no more than half the signal
  const halfWidth = Math.ceil(4 * a);
  const half = Math.min(halfWidth, Math.ceil(numPoints / 2), 256);
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
}

const DEFAULT_SCALES = [1, 2, 4, 8, 16, 32, 64, 128];

/**
 * Compute the Continuous Wavelet Transform (Ricker) over the signal.
 *
 * For each scale a, the wavelet ψ_a(t) = (1/√a)·ψ(t/a) is convolved
 * with the signal. The result for scale a at position b is:
 *   W(a, b) = Σ_t ψ_a(t-b) · signal[t]
 *
 * Boundary handling: signal is zero-padded outside its domain.
 */
export function computeCWT(
  signal: number[],
  scales: number[] = DEFAULT_SCALES,
): WaveletCoefficients {
  const N = signal.length;
  const coefficients: number[][] = [];
  const usedScales: number[] = [];

  // Early return for empty signal
  if (N === 0) {
    return { scales: [...scales], coefficients };
  }

  for (const a of scales) {
    const kernel = makeKernel(a, N);
    const halfKernel = Math.floor(kernel.length / 2);
    const coeffs: number[] = new Array(N);

    for (let pos = 0; pos < N; pos++) {
      let sum = 0;
      for (let k = 0; k < kernel.length; k++) {
        const signalIdx = pos + k - halfKernel;
        if (signalIdx >= 0 && signalIdx < N) {
          sum += kernel[k] * signal[signalIdx];
        }
      }
      coeffs[pos] = sum;
    }

    coefficients.push(coeffs);
    usedScales.push(a);
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
 */
export function detectPeaks(
  cwt: WaveletCoefficients,
  threshold: number,
  maxPeaks: number = 100,
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

      const leftOk = pos === 0 || mag > Math.abs(coeffs[pos - 1]);
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

  // Sort by absolute coefficient magnitude descending
  peaks.sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient));

  return peaks.slice(0, maxPeaks);
}
