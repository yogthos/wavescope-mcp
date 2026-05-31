/**
 * Entropy analysis: combine Haar DWT with libwce bit-cost estimation
 * to produce a multi-scale "complexity heatmap" of a 1D signal.
 *
 * Pipeline:
 *   1. Compute per-line structural signal (from signal.ts)
 *   2. Multi-level Haar DWT on the signal
 *   3. For each detail band: quantize → compute BPC entropy via wce
 *   4. Higher bit cost = more structural irregularity at that scale
 */

import { haarDecompose, HaarDecomposition } from "./haar.js";
import { computeBandEntropy, BandEntropy as WceBandEntropy } from "./wce.js";

const I32_MAX = 2147483647;
const I32_MIN = -2147483648;

/** Fixed scale factor for converting float details to i32 range */
const DETAIL_SCALE = 32768; // 2^15

export interface EntropyBand {
  /** Decomposition level (0 = finest) */
  level: number;
  /** Line span this detail band covers (2^(level+1) original lines per coefficient) */
  span: number;
  /** Estimated bit cost for encoding this band's detail coefficients */
  bitCost: number;
  /** Optimal Rice k (0–6) */
  riceK: number;
  /** Best predictor mode */
  predictor: "running" | "zero";
  /** Whether sparse-block skip was beneficial */
  sparseFlag: boolean;
  /** Number of coefficient groups (detail length / 4, padded) */
  numGroups: number;
  /** Raw BPC values per group */
  bpcs: Uint8Array;
}

export interface ComplexityHeatmap {
  /** Per-band entropy metrics, finest first */
  bands: EntropyBand[];
  /** Sum of bit costs across all bands */
  totalEntropy: number;
  /** Signal length (number of lines) */
  signalLength: number;
  /** Per-line irregularity scores (higher = more entropic) */
  perLineIrregularity: number[];
}

/**
 * Quantize a detail band's floating-point coefficients to i32,
 * padded to a multiple of 4 for wce's group-of-4 requirement.
 */
function quantizeDetails(detail: number[]): number[] {
  const result: number[] = [];
  for (const d of detail) {
    let v = Math.round(d * DETAIL_SCALE);
    if (v > I32_MAX) v = I32_MAX;
    if (v < I32_MIN) v = I32_MIN;
    result.push(v);
  }
  while (result.length & 3) result.push(0);
  return result;
}

/**
 * Analyze a multi-level Haar decomposition for entropy across scales.
 *
 * Each detail band is quantized, then run through libwce's BPC
 * entropy estimation. The resulting bit cost is a language-agnostic
 * measure of structural irregularity at that scale.
 *
 * @param decomp — result of haarDecompose on the per-line signal
 * @param lossyBits — LSBs to drop before BPC computation (0 = full precision)
 */
export function analyzeDecomposition(
  decomp: HaarDecomposition,
  lossyBits: number = 0,
): EntropyBand[] {
  const bands: EntropyBand[] = [];

  for (let lev = 0; lev < decomp.levels.length; lev++) {
    const { detail } = decomp.levels[lev];
    const coeffs = quantizeDetails(detail);
    const ent = computeBandEntropy(coeffs, lossyBits);

    bands.push({
      level: lev,
      span: 1 << (lev + 1),  // detail at level lev covers 2^(lev+1) original lines
      bitCost: ent.bitCost,
      riceK: ent.riceK,
      predictor: ent.predictor,
      sparseFlag: ent.sparseFlag,
      numGroups: ent.numGroups,
      bpcs: ent.bpcs,
    });
  }

  return bands;
}

/**
 * Compute a full complexity heatmap from a per-line numeric signal.
 *
 * This is the main entry point for turning a structural signal
 * (from signal.ts) into multi-scale entropy metrics.
 *
 * @param signal — per-line importance scores (from signal.ts's computeSignal)
 * @param lossyBits — quantization LSBs to drop (default 0)
 * @returns ComplexityHeatmap with per-band entropy breakdown
 */
export function computeComplexityHeatmap(
  signal: number[],
  lossyBits: number = 0,
): ComplexityHeatmap {
  if (signal.length === 0) {
    return { bands: [], totalEntropy: 0, signalLength: 0, perLineIrregularity: [] };
  }

  // Determine max levels based on signal length
  const maxLevels = Math.floor(Math.log2(signal.length));
  const levels = Math.min(maxLevels, 8); // cap at 8 levels (span up to 128)

  const decomp = haarDecompose(signal, levels);
  const bands = analyzeDecomposition(decomp, lossyBits);

  let totalEntropy = 0;
  for (const b of bands) totalEntropy += b.bitCost;

  const scores = perLineIrregularity(decomp, bands, signal.length);

  return {
    bands,
    totalEntropy,
    signalLength: signal.length,
    perLineIrregularity: scores,
  };
}

/**
 * Estimate per-line irregularity by back-projecting detail band
 * entropy to individual line positions.
 *
 * Each detail coefficient covers a span of 2^level lines. The bit
 * cost contributed by that detail coefficient is approximated as
 * the per-group average, distributed across the lines it covers.
 */
export function perLineIrregularity(
  decomp: HaarDecomposition,
  bands: EntropyBand[],
  totalLines: number,
): number[] {
  const scores = new Array<number>(totalLines).fill(0);

  for (let lev = 0; lev < bands.length; lev++) {
    const band = bands[lev];
    const { detail } = decomp.levels[lev];
    if (band.numGroups === 0) continue;

    // Average bit cost per detail coefficient
    const costPerCoeff = band.bitCost / Math.max(1, detail.length);
    const span = band.span;

    // Distribute to covered lines
    for (let di = 0; di < detail.length; di++) {
      const weight = Math.abs(detail[di]);
      const startLine = di * span;
      const endLine = Math.min(startLine + span, totalLines);
      const contrib = costPerCoeff * weight / span;
      for (let li = startLine; li < endLine; li++) {
        scores[li] += contrib;
      }
    }
  }

  return scores;
}
