/**
 * libwce TypeScript port — Bit-Plane Count entropy coder.
 *
 * Direct port of github.com/yogthos/libwce (500-line Rust stdlib-only lib).
 * Ports the full codec for roundtrip-testing correctness, then exposes
 * cost-estimation helpers for entropy-analysis use in wavescope.
 *
 * JS-specific notes:
 * - BitWriter/BitReader use BigInt for the internal 64-bit register.
 * - u32 ops use >>> 0 (unsigned), >> 0 (signed i32 cast).
 * - leading_zeros → Math.clz32.
 * - unsigned_abs → Math.abs(v) >>> 0.
 */

// ── Constants ────────────────────────────────────────────────

export const FORMAT_VERSION = 4;
export const HEADER_SIZE = 12;
const BLOCK_GROUPS = 8;
const MAX_INLINE_GROUPS = 16384;
export const RICE_MAX_QUOTIENT = 256;

export const PREDICTOR_RUNNING = 0;
export const PREDICTOR_ZERO = 1;

const PICK_K_MAX = 6;
const HIST_RUN_BINS = 65;
const HIST_ZERO_BINS = 33;

const I32_MAX = 2147483647;
const I32_MIN = -2147483648;
const U32_MAX = 4294967295;

// ── Bit I/O ──────────────────────────────────────────────────

export class BitWriter {
  data: Uint8Array;
  pos = 0;
  reg = 0n;
  bitsHeld = 0;
  overflow = false;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  writeBits(value: number, n: number): void {
    if (this.overflow) return;
    if (n > 32) n = 32;
    if (n === 0) return;
    const mask = n === 32 ? 0xFFFFFFFFn : (1n << BigInt(n)) - 1n;
    this.reg |= (BigInt(value >>> 0) & mask) << BigInt(this.bitsHeld);
    this.bitsHeld += n;
    while (this.bitsHeld >= 8) {
      if (this.pos < this.data.length) {
        this.data[this.pos] = Number(this.reg & 0xFFn);
        this.pos++;
      } else {
        this.overflow = true;
      }
      this.reg >>= 8n;
      this.bitsHeld -= 8;
    }
  }

  flush(): void {
    if (this.bitsHeld > 0) {
      if (this.pos < this.data.length) {
        this.data[this.pos] = Number(this.reg & 0xFFn);
        this.pos++;
      } else {
        this.overflow = true;
      }
      this.reg = 0n;
      this.bitsHeld = 0;
    }
  }

  isOverflow(): boolean { return this.overflow; }
  setOverflow(): void { this.overflow = true; }
  bytesWritten(): number { return this.pos; }
}

export class BitReader {
  data: Uint8Array;
  pos = 0;
  reg = 0n;
  bitsHeld = 0;
  truncated = false;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  private refill(minBits: number): void {
    while (this.bitsHeld < minBits && this.bitsHeld <= 56) {
      if (this.pos < this.data.length) {
        this.reg |= BigInt(this.data[this.pos]) << BigInt(this.bitsHeld);
        this.pos++;
      } else {
        this.truncated = true;
      }
      this.bitsHeld += 8;
    }
  }

  readBits(n: number): number {
    if (n > 32) n = 32;
    if (n === 0) return 0;
    if (this.bitsHeld < n) this.refill(n);
    const mask = n === 32 ? 0xFFFFFFFFn : (1n << BigInt(n)) - 1n;
    const v = Number(this.reg & mask);
    this.reg >>= BigInt(n);
    this.bitsHeld -= n;
    return v >>> 0;
  }

  byteAlign(): void {
    const drop = this.bitsHeld & 7;
    this.reg >>= BigInt(drop);
    this.bitsHeld -= drop;
  }

  isTruncated(): boolean { return this.truncated; }
  bytesConsumed(): number { return this.pos; }
}

// ── Zigzag ───────────────────────────────────────────────────

export function zigzagEncode(v: number): number {
  const uv = v >>> 0;
  return ((uv << 1) ^ ((0 - (uv >>> 31)) >>> 0)) >>> 0;
}

export function zigzagDecode(u: number): number {
  u = u >>> 0;
  return ((u >>> 1) ^ ((0 - (u & 1)) >>> 0)) >> 0;
}

// ── Rice coding ──────────────────────────────────────────────

export function writeRice(bw: BitWriter, value: number, k: number): void {
  k = Math.min(k, 16);
  let q = (value >>> 0) >>> k;
  if (q >= RICE_MAX_QUOTIENT) { bw.setOverflow(); return; }
  while (q >= 31) { bw.writeBits(0x7FFFFFFF >>> 0, 31); q -= 31; }
  if (q > 0) { bw.writeBits((1 << q) - 1, q); }
  bw.writeBits(0, 1);
  if (k > 0) { bw.writeBits(value & ((1 << k) - 1), k); }
}

export function readRice(br: BitReader, k: number): number {
  k = Math.min(k, 16);
  let q = 0;
  while (q < RICE_MAX_QUOTIENT) {
    if (br.readBits(1) === 0) break;
    q++;
  }
  if (q === RICE_MAX_QUOTIENT) return U32_MAX;
  const r = k > 0 ? br.readBits(k) : 0;
  return ((q << k) | r) >>> 0;
}

/**
 * Estimated bit cost for encoding a single value with Rice parameter k.
 * q unary + 1 stop bit + k remainder bits.
 */
export function riceCost(value: number, k: number): number {
  k = Math.min(k, 16);
  const q = (value >>> 0) >>> k;
  return q + 1 + k;
}

// ── BPC ──────────────────────────────────────────────────────

function ceilLog2Plus1(v: number): number {
  v = v >>> 0;
  if (v === 0) return 0;
  return Math.min(32, 32 - Math.clz32(v));
}

function unsignedAbs(x: number): number {
  return Math.abs(x) >>> 0;
}

export function computeBpcs(coeffs: number[], lossyBits: number): Uint8Array {
  const numGroups = coeffs.length >> 2;
  const bpcs = new Uint8Array(numGroups);
  const lossy = Math.min(lossyBits, 31);
  for (let g = 0; g < numGroups; g++) {
    let maxAbs = 0;
    for (let i = 0; i < 4; i++) {
      maxAbs = Math.max(maxAbs, unsignedAbs(coeffs[g * 4 + i]));
    }
    bpcs[g] = Math.min(Math.max(ceilLog2Plus1(maxAbs), lossy), 32);
  }
  return bpcs;
}

export function pickRiceKForBpcs(bpcs: Uint8Array, kMax: number): number {
  kMax = Math.min(kMax, 16);
  if (bpcs.length < 2) return 0;
  let bestK = 0;
  let bestBits = Number.MAX_SAFE_INTEGER;
  for (let k = 0; k <= kMax; k++) {
    let total = 0;
    let ok = true;
    for (let i = 1; i < bpcs.length; i++) {
      const d = bpcs[i] - bpcs[i - 1];
      const q = zigzagEncode(d) >>> k;
      if (q >= RICE_MAX_QUOTIENT) { ok = false; break; }
      total += q + 1 + k;
    }
    if (ok && total < bestBits) { bestBits = total; bestK = k; }
  }
  return bestK;
}

// ── BPC DPCM encode/decode ──────────────────────────────────

export function encodeBpcsDpcm(bw: BitWriter, bpcs: Uint8Array, k: number): void {
  for (let i = 1; i < bpcs.length; i++) {
    const d = bpcs[i] - bpcs[i - 1];
    writeRice(bw, zigzagEncode(d), k);
  }
}

export function decodeBpcsDpcm(
  br: BitReader, numGroups: number, initial: number, k: number, out: Uint8Array,
): void {
  if (numGroups === 0) return;
  out[0] = Math.min(initial, 32);
  let prev = out[0];
  for (let i = 1; i < numGroups; i++) {
    const u = readRice(br, k);
    if (u === U32_MAX) {
      for (let j = i; j < numGroups; j++) out[j] = prev;
      return;
    }
    prev = Math.min(Math.max(prev + zigzagDecode(u), 0), 32);
    out[i] = prev;
  }
}

// ── Pack / unpack coefficients ──────────────────────────────

export function packCoeffs(
  bw: BitWriter, coeffs: number[], coeffsOffset: number,
  bpcs: Uint8Array, bpcsOffset: number,
  lossyBits: number, numGroups: number,
): void {
  const lossy = Math.min(lossyBits, 31);
  for (let g = 0; g < numGroups; g++) {
    const nbits = Math.max(0, Math.min(bpcs[bpcsOffset + g] - lossy, 32));
    for (let i = 0; i < 4; i++) {
      const c = coeffs[coeffsOffset + g * 4 + i];
      const m = unsignedAbs(c) >>> lossy;
      if (nbits > 0) bw.writeBits(m, nbits);
      if (m !== 0) bw.writeBits(c < 0 ? 1 : 0, 1);
    }
  }
}

export function unpackCoeffs(
  br: BitReader, bpcs: Uint8Array, bpcsOffset: number,
  lossyBits: number, numGroups: number, out: number[], outOffset: number,
): void {
  const lossy = Math.min(lossyBits, 31);
  for (let g = 0; g < numGroups; g++) {
    const nbits = Math.max(0, Math.min(bpcs[bpcsOffset + g] - lossy, 32));
    for (let i = 0; i < 4; i++) {
      const m = nbits > 0 ? br.readBits(nbits) : 0;
      // `m << lossy` is a signed i32 shift in JS; coerce to u32 so the
      // `mag > I32_MAX` saturation branch below is reachable for
      // magnitudes in (2^31, 2^32). The encoder guarantees bpc ≤ 32, so
      // mag = m << lossy always fits in u32 (no meaningful bits lost).
      const mag = (m << lossy) >>> 0;
      const idx = outOffset + g * 4 + i;
      if (m === 0) {
        out[idx] = 0;
      } else {
        const sign = br.readBits(1);
        if (mag > I32_MAX) {
          out[idx] = sign ? I32_MIN : I32_MAX;
        } else if (sign) {
          out[idx] = (0 - mag) >> 0;
        } else {
          out[idx] = mag;
        }
      }
    }
  }
}

// ── Quantize ─────────────────────────────────────────────────

export function quantize(coeffs: number[], lossyBits: number): void {
  if (lossyBits === 0) return;
  if (lossyBits >= 32) { coeffs.fill(0); return; }
  const mask = ~((1 << lossyBits) - 1);
  for (let i = 0; i < coeffs.length; i++) {
    const c = coeffs[i];
    if (c > 0) {
      coeffs[i] = ((c >>> 0) & mask) >> 0;
    } else if (c < 0) {
      const abs = (0 - (c >>> 0)) >>> 0;
      coeffs[i] = (0 - (abs & mask)) >> 0;
    }
  }
}

export function quantizeCoeff(c: number, lossyBits: number): number {
  if (lossyBits >= 32) return 0;
  const mag = (((Math.abs(c) >>> 0) >>> lossyBits) << lossyBits) >>> 0;
  return c >= 0 ? mag >> 0 : (0 - mag) >> 0;
}

// ── Laplacian scale estimation ──────────────────────────────

export function estimateLaplacianScale(coeffs: number[]): number {
  if (coeffs.length === 0) return 0;
  let sum = 0;
  for (const c of coeffs) sum += unsignedAbs(c);
  return sum / coeffs.length;
}

// ── Mode selection ──────────────────────────────────────────

function isSparse(bpcs: Uint8Array, g0: number, gEnd: number, lossyBits: number): boolean {
  for (let g = g0; g < gEnd; g++) {
    if (bpcs[g] !== lossyBits) return false;
  }
  return true;
}

/**
 * Cost matrix: costs[combo][k] where:
 *   combo 0 = RUNNING predictor, sparse OFF
 *   combo 1 = RUNNING predictor, sparse ON
 *   combo 2 = ZERO predictor, sparse OFF
 *   combo 3 = ZERO predictor, sparse ON
 */
export function computeAllComboCosts(
  bpcs: Uint8Array, numGroups: number, lossyBits: number,
): number[][] {
  const histRunOff = new Uint32Array(HIST_RUN_BINS);
  const histRunOn = new Uint32Array(HIST_RUN_BINS);
  const histZero = new Uint32Array(HIST_ZERO_BINS);
  let prevOff = lossyBits;
  let prevOn = lossyBits;
  let numBlocks = 0;
  let sparseCount = 0;

  let g0 = 0;
  while (g0 < numGroups) {
    const gEnd = Math.min(g0 + BLOCK_GROUPS, numGroups);
    numBlocks++;
    const sparse = isSparse(bpcs, g0, gEnd, lossyBits);
    if (sparse) {
      sparseCount += gEnd - g0;
      for (let g = g0; g < gEnd; g++) {
        const zz = zigzagEncode(bpcs[g] - prevOff);
        if (zz < HIST_RUN_BINS) histRunOff[zz]++;
        const zd = bpcs[g] - lossyBits;
        if (zd >= 0 && zd < HIST_ZERO_BINS) histZero[zd]++;
        prevOff = bpcs[g];
      }
      prevOn = lossyBits;
    } else {
      for (let g = g0; g < gEnd; g++) {
        const zzOff = zigzagEncode(bpcs[g] - prevOff);
        const zzOn = zigzagEncode(bpcs[g] - prevOn);
        if (zzOff < HIST_RUN_BINS) histRunOff[zzOff]++;
        if (zzOn < HIST_RUN_BINS) histRunOn[zzOn]++;
        const zd = bpcs[g] - lossyBits;
        if (zd >= 0 && zd < HIST_ZERO_BINS) histZero[zd]++;
        prevOff = bpcs[g];
        prevOn = bpcs[g];
      }
    }
    g0 = gEnd;
  }

  const total = numGroups;
  const nonSparse = numGroups - sparseCount;
  const blocks = numBlocks;
  const costs: number[][] = [];
  for (let c = 0; c < 4; c++) costs.push(new Array(PICK_K_MAX + 1).fill(0));

  for (let k = 0; k <= PICK_K_MAX; k++) {
    let sRunOff = 0, sRunOn = 0, sZero = 0;
    for (let v = 0; v < HIST_RUN_BINS; v++) {
      sRunOff += histRunOff[v] * (v >>> k);
      sRunOn += histRunOn[v] * (v >>> k);
    }
    for (let v = 0; v < HIST_ZERO_BINS; v++) {
      sZero += histZero[v] * (v >>> k);
    }
    const k1 = 1 + k;
    costs[0][k] = k1 * total + sRunOff;
    costs[1][k] = blocks + k1 * nonSparse + sRunOn;
    costs[2][k] = k1 * total + sZero;
    costs[3][k] = blocks + k1 * nonSparse + sZero;
  }
  return costs;
}

export interface ModeSelectResult {
  /** true = ZERO predictor, false = RUNNING */
  predictor: boolean;
  sparseFlag: boolean;
  riceK: number;
  bestCost: number;
}

/**
 * Pick the cheapest (combo, k) pair from a precomputed cost matrix.
 * Split out so callers that already hold the matrix (e.g.
 * {@link computeBandEntropy}) avoid recomputing it.
 */
export function selectFromComboCosts(costs: number[][]): ModeSelectResult {
  let bestCost = Number.MAX_SAFE_INTEGER;
  let bestCombo = 0;
  let bestK = 0;
  for (let c = 0; c < 4; c++) {
    for (let k = 0; k <= PICK_K_MAX; k++) {
      if (costs[c][k] < bestCost) {
        bestCost = costs[c][k];
        bestCombo = c;
        bestK = k;
      }
    }
  }
  return {
    predictor: (bestCombo & 2) !== 0,
    sparseFlag: (bestCombo & 1) !== 0,
    riceK: bestK,
    bestCost,
  };
}

export function modeSelect(
  bpcs: Uint8Array, numGroups: number, lossyBits: number,
): ModeSelectResult {
  if (numGroups === 0) return { predictor: false, sparseFlag: false, riceK: 0, bestCost: 0 };
  return selectFromComboCosts(computeAllComboCosts(bpcs, numGroups, lossyBits));
}

// ── Full codec (for roundtrip testing) ──────────────────────

export interface EncodeOptions {
  predictor: number;  // PREDICTOR_RUNNING (0) or PREDICTOR_ZERO (1)
  sparseFlag: boolean;
  riceK: number;
}

export function encodeWithOptions(
  coeffs: number[], lossyBits: number,
  opts: EncodeOptions | null, out: Uint8Array,
): number {
  if (lossyBits > 31) throw new Error("BadInput");
  if (out.length < HEADER_SIZE) throw new Error("NoSpace");
  if ((coeffs.length & 3) !== 0) throw new Error("BadInput");
  const numGroups = coeffs.length >> 2;
  if (numGroups > MAX_INLINE_GROUPS) throw new Error("BadInput");

  const bpcs = computeBpcs(coeffs, lossyBits);

  let predictor: boolean, useFlag: boolean, riceK: number;
  if (opts) {
    if (opts.riceK > 16) throw new Error("BadInput");
    if (opts.predictor !== PREDICTOR_RUNNING && opts.predictor !== PREDICTOR_ZERO) {
      throw new Error("BadInput");
    }
    predictor = opts.predictor === PREDICTOR_ZERO;
    useFlag = opts.sparseFlag;
    riceK = opts.riceK;
  } else {
    const sel = modeSelect(bpcs, numGroups, lossyBits);
    predictor = sel.predictor;
    useFlag = sel.sparseFlag;
    riceK = sel.riceK;
  }

  const payload = new Uint8Array(out.buffer, out.byteOffset + HEADER_SIZE, out.length - HEADER_SIZE);
  const bw = new BitWriter(payload);
  let prev = lossyBits;
  let g0 = 0;
  while (g0 < numGroups) {
    const gEnd = Math.min(g0 + BLOCK_GROUPS, numGroups);
    if (useFlag) {
      const sparse = isSparse(bpcs, g0, gEnd, lossyBits);
      bw.writeBits(sparse ? 1 : 0, 1);
      if (sparse) { prev = lossyBits; g0 = gEnd; continue; }
    }
    for (let g = g0; g < gEnd; g++) {
      const u = predictor
        ? Math.max(0, bpcs[g] - lossyBits) >>> 0
        : zigzagEncode(bpcs[g] - prev);
      writeRice(bw, u, riceK);
      prev = bpcs[g];
    }
    packCoeffs(bw, coeffs, g0 * 4, bpcs, g0, lossyBits, gEnd - g0);
    g0 = gEnd;
  }
  bw.flush();
  if (bw.isOverflow()) throw new Error("NoSpace");
  const payloadLen = bw.bytesWritten();

  // Write header
  out[0] = 87; out[1] = 67; out[2] = 69; out[3] = 0; // "WCE\0"
  out[4] = numGroups & 0xFF;
  out[5] = (numGroups >>> 8) & 0xFF;
  out[6] = (numGroups >>> 16) & 0xFF;
  out[7] = (numGroups >>> 24) & 0xFF;
  out[8] = FORMAT_VERSION;
  out[9] = lossyBits;
  out[10] = (riceK & 0x1F) | (predictor ? 0x40 : 0) | (useFlag ? 0x80 : 0);
  out[11] = lossyBits;
  return HEADER_SIZE + payloadLen;
}

export function encode(coeffs: number[], lossyBits: number, out: Uint8Array): number {
  return encodeWithOptions(coeffs, lossyBits, null, out);
}

export function decode(input: Uint8Array, out: number[]): number {
  if (input.length < HEADER_SIZE) throw new Error("Truncated");
  if (input[0] !== 87 || input[1] !== 67 || input[2] !== 69 || input[3] !== 0) {
    throw new Error("BadMagic");
  }
  if (input[8] !== FORMAT_VERSION) throw new Error("BadVersion");

  const numGroups = input[4] | (input[5] << 8) | (input[6] << 16) | (input[7] << 24);
  const lossy = input[9];
  const flags = input[10];
  const riceK = flags & 0x1F;
  const predictor = (flags & 0x40) !== 0;
  const useFlag = (flags & 0x80) !== 0;
  const initialPrev = input[11];

  if (lossy > 31 || riceK > 16 || (out.length & 3) !== 0 ||
      numGroups * 4 !== out.length || initialPrev !== lossy) {
    throw new Error("BadInput");
  }
  if (numGroups > MAX_INLINE_GROUPS) throw new Error("BadInput");
  if (numGroups === 0) return lossy;

  const br = new BitReader(
    new Uint8Array(input.buffer, input.byteOffset + HEADER_SIZE, input.length - HEADER_SIZE),
  );
  const bpcs = new Uint8Array(numGroups);
  let prev = Math.min(initialPrev, 32);
  let g0 = 0;
  while (g0 < numGroups) {
    const gEnd = Math.min(g0 + BLOCK_GROUPS, numGroups);
    if (useFlag && br.readBits(1) !== 0) {
      for (let g = g0; g < gEnd; g++) {
        bpcs[g] = lossy;
        out[g * 4] = out[g * 4 + 1] = out[g * 4 + 2] = out[g * 4 + 3] = 0;
      }
      prev = lossy;
    } else {
      for (let g = g0; g < gEnd; g++) {
        const u = readRice(br, riceK);
        if (u === U32_MAX) {
          for (let g2 = g; g2 < numGroups; g2++) {
            bpcs[g2] = prev;
            out[g2 * 4] = out[g2 * 4 + 1] = out[g2 * 4 + 2] = out[g2 * 4 + 3] = 0;
          }
          throw new Error("Corrupt");
        }
        prev = predictor
          ? Math.min(lossy + u, 32)
          : Math.min(Math.max(prev + zigzagDecode(u), 0), 32);
        bpcs[g] = prev;
      }
      unpackCoeffs(br, bpcs, g0, lossy, gEnd - g0, out, g0 * 4);
      if (br.isTruncated()) {
        for (let g = gEnd; g < numGroups; g++) {
          out[g * 4] = out[g * 4 + 1] = out[g * 4 + 2] = out[g * 4 + 3] = 0;
        }
        throw new Error("Truncated");
      }
    }
    g0 = gEnd;
  }
  return lossy;
}

// ── Entropy analysis helpers ────────────────────────────────

export interface BandEntropy {
  /** Total estimated bit cost for this band's BPC values */
  bitCost: number;
  /** Optimal Rice k (0–6) */
  riceK: number;
  /** Best predictor: "running" (DPCM) or "zero" */
  predictor: "running" | "zero";
  /** Whether sparse-block skip was chosen */
  sparseFlag: boolean;
  /** Bit cost per combo × k, for diagnostics */
  costs: number[][];
  /** Number of groups (coeffs.length / 4) */
  numGroups: number;
  /** Per-group BPC values */
  bpcs: Uint8Array;
}

/**
 * Compute entropy metrics for a band of wavelet coefficients.
 *
 * Groups coefficients by 4, computes BPC for each group, runs
 * full mode selection, and returns the estimated bit cost along
 * with the optimal encoding parameters.
 *
 * The bit cost is a language-agnostic measure of local structural
 * irregularity — higher values mean more "surprise" in the signal.
 */
export function computeBandEntropy(
  coeffs: number[], lossyBits: number,
): BandEntropy {
  const numGroups = coeffs.length >> 2;
  const bpcs = computeBpcs(coeffs, lossyBits);
  if (numGroups === 0) {
    return {
      bitCost: 0, riceK: 0, predictor: "running",
      sparseFlag: false, costs: [], numGroups: 0, bpcs,
    };
  }
  const costs = computeAllComboCosts(bpcs, numGroups, lossyBits);
  const sel = selectFromComboCosts(costs);
  return {
    bitCost: sel.bestCost,
    riceK: sel.riceK,
    predictor: sel.predictor ? "zero" : "running",
    sparseFlag: sel.sparseFlag,
    costs: costs.map(row => Array.from(row)),
    numGroups,
    bpcs,
  };
}
