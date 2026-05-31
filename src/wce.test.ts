import { describe, it, expect } from "vitest";
import {
  BitWriter,
  BitReader,
  zigzagEncode,
  zigzagDecode,
  writeRice,
  readRice,
  riceCost,
  computeBpcs,
  pickRiceKForBpcs,
  encodeBpcsDpcm,
  decodeBpcsDpcm,
  packCoeffs,
  unpackCoeffs,
  quantize,
  quantizeCoeff,
  estimateLaplacianScale,
  computeAllComboCosts,
  modeSelect,
  encode,
  decode,
  encodeWithOptions,
  computeBandEntropy,
  RICE_MAX_QUOTIENT,
  PREDICTOR_RUNNING,
  PREDICTOR_ZERO,
  FORMAT_VERSION,
  HEADER_SIZE,
} from "./wce.js";

const I32_MAX = 2147483647;
const I32_MIN = -2147483648;
const U32_MAX = 4294967295;

// ── Helpers ─────────────────────────────────────────────────

function roundtrip(coeffs: number[], lossyBits: number): void {
  const buf = new Uint8Array(16384);
  const outLen = encode(coeffs, lossyBits, buf);
  expect(outLen).toBeGreaterThanOrEqual(HEADER_SIZE);
  const decoded = new Array<number>(coeffs.length).fill(0);
  const lb = decode(new Uint8Array(buf.buffer, 0, outLen), decoded);
  expect(lb).toBe(lossyBits);
  for (let i = 0; i < coeffs.length; i++) {
    expect(decoded[i]).toBe(quantizeCoeff(coeffs[i], lossyBits));
  }
}

// ── bit I/O ─────────────────────────────────────────────────

describe("BitWriter / BitReader", () => {
  it("write single bit", () => {
    const buf = new Uint8Array(1);
    const bw = new BitWriter(buf);
    bw.writeBits(1, 1);
    bw.flush();
    expect(bw.bytesWritten()).toBe(1);
    expect(buf[0]).toBe(0x01);
  });

  it("LSB-first ordering", () => {
    const buf = new Uint8Array(2);
    const bw = new BitWriter(buf);
    bw.writeBits(0xA, 4);
    bw.writeBits(0xB, 4);
    bw.writeBits(0xC, 4);
    bw.writeBits(0xD, 4);
    bw.flush();
    expect(buf[0]).toBe(0xBA);
    expect(buf[1]).toBe(0xDC);
  });

  it("roundtrip assorted widths", () => {
    const vals = [0, 1, 31, 1023, 0x12345678, 7, 0, 0xFFFFFFFF];
    const widths = [1, 2, 5, 10, 32, 3, 7, 32];
    const buf = new Uint8Array(64);
    const bw = new BitWriter(buf);
    for (let i = 0; i < vals.length; i++) bw.writeBits(vals[i], widths[i]);
    bw.flush();
    expect(bw.isOverflow()).toBe(false);
    const br = new BitReader(new Uint8Array(buf.buffer, 0, bw.bytesWritten()));
    for (let i = 0; i < vals.length; i++) {
      expect(br.readBits(widths[i])).toBe(vals[i]);
    }
    expect(br.isTruncated()).toBe(false);
  });

  it("overflow flag", () => {
    const buf = new Uint8Array(2);
    const bw = new BitWriter(buf);
    bw.writeBits(0xFFFF, 16);
    bw.writeBits(1, 1);
    bw.flush();
    expect(bw.isOverflow()).toBe(true);
  });

  it("truncated returns zero", () => {
    const br = new BitReader(new Uint8Array([0x55]));
    expect(br.readBits(8)).toBe(0x55);
    expect(br.readBits(8)).toBe(0);
    expect(br.isTruncated()).toBe(true);
  });

  it("zero n is noop", () => {
    const br = new BitReader(new Uint8Array([0xFF]));
    expect(br.readBits(0)).toBe(0);
    expect(br.readBits(8)).toBe(0xFF);
  });

  it("byte align", () => {
    const br = new BitReader(new Uint8Array([0xF0, 0x55]));
    br.readBits(3);
    br.byteAlign();
    expect(br.readBits(8)).toBe(0x55);
  });

  it("bytes consumed", () => {
    const br = new BitReader(new Uint8Array([1, 2, 3, 4]));
    expect(br.bytesConsumed()).toBe(0);
    br.readBits(8);
    expect(br.bytesConsumed()).toBe(1);
    br.readBits(4);
    expect(br.bytesConsumed()).toBe(2); // readBits of 4 crosses byte boundary
  });
});

// ── zigzag ──────────────────────────────────────────────────

describe("zigzag", () => {
  it("small values", () => {
    expect(zigzagEncode(0)).toBe(0);
    expect(zigzagEncode(-1)).toBe(1);
    expect(zigzagEncode(1)).toBe(2);
    expect(zigzagEncode(-2)).toBe(3);
    expect(zigzagEncode(2)).toBe(4);
  });

  it("extremes", () => {
    expect(zigzagEncode(I32_MAX)).toBe(0xFFFFFFFE);
    expect(zigzagEncode(I32_MIN)).toBe(0xFFFFFFFF);
  });

  it("roundtrip", () => {
    for (const v of [0, 1, -1, 100, -100, I32_MAX, I32_MIN, -42, 0x1234567, -0x1234567]) {
      expect(zigzagDecode(zigzagEncode(v))).toBe(v);
    }
  });
});

// ── rice ────────────────────────────────────────────────────

describe("rice", () => {
  it("k=0 unary", () => {
    const buf = new Uint8Array(8);
    const bw = new BitWriter(buf);
    writeRice(bw, 3, 0);
    bw.flush();
    const br = new BitReader(buf);
    expect(readRice(br, 0)).toBe(3);
  });

  it("k=2 split", () => {
    const buf = new Uint8Array(4);
    const bw = new BitWriter(buf);
    writeRice(bw, 11, 2);
    bw.flush();
    const br = new BitReader(buf);
    expect(readRice(br, 2)).toBe(11);
  });

  it("roundtrip many", () => {
    const vals = [0, 1, 2, 5, 10, 31, 63, 100, 200, 1024, 65535];
    const buf = new Uint8Array(1024);
    for (let k = 0; k <= 12; k++) {
      const filtered = vals.filter(v => (v >>> k) < RICE_MAX_QUOTIENT);
      const bw = new BitWriter(buf);
      for (const v of filtered) writeRice(bw, v, k);
      bw.flush();
      expect(bw.isOverflow()).toBe(false);
      const br = new BitReader(new Uint8Array(buf.buffer, 0, bw.bytesWritten()));
      for (const e of filtered) expect(readRice(br, k)).toBe(e);
    }
  });

  it("large k=16", () => {
    const buf = new Uint8Array(64);
    const bw = new BitWriter(buf);
    writeRice(bw, 0x123456, 16);
    bw.flush();
    const br = new BitReader(new Uint8Array(buf.buffer, 0, bw.bytesWritten()));
    expect(readRice(br, 16)).toBe(0x123456);
  });

  it("all ones returns U32_MAX", () => {
    const br = new BitReader(new Uint8Array(64).fill(0xFF));
    expect(readRice(br, 4)).toBe(U32_MAX);
    expect(br.isTruncated()).toBe(false);
    expect(br.bytesConsumed()).toBe(32);
  });

  it("q=255 boundary", () => {
    const tests: [number, number][] = [
      [255, 0], [255 << 1, 1], [255 << 2, 2], [255 << 4, 4], [255 << 8, 8],
    ];
    const buf = new Uint8Array(512);
    for (const [val, k] of tests) {
      const bw = new BitWriter(buf);
      writeRice(bw, val, k);
      bw.flush();
      expect(bw.isOverflow()).toBe(false);
      const br = new BitReader(new Uint8Array(buf.buffer, 0, bw.bytesWritten()));
      expect(readRice(br, k)).toBe(val);
    }
    const bw2 = new BitWriter(buf);
    writeRice(bw2, 256, 0);
    bw2.flush();
    expect(bw2.isOverflow()).toBe(true);
    expect(bw2.bytesWritten()).toBe(0);
  });

  it("truncated", () => {
    const br = new BitReader(new Uint8Array(0));
    expect(readRice(br, 3)).toBe(0);
    expect(br.isTruncated()).toBe(true);
  });

  it("riceCost matches writeRice bit count", () => {
    const vals = [0, 1, 3, 7, 15, 100, 1024, 0x12345];
    const buf = new Uint8Array(1024);
    for (let k = 0; k <= 6; k++) {
      for (const v of vals) {
        if ((v >>> k) >= RICE_MAX_QUOTIENT) continue;
        const bw = new BitWriter(buf);
        const before = bw.bytesWritten();
        writeRice(bw, v, k);
        bw.flush();
        const written = bw.bytesWritten() - before;
        expect(riceCost(v, k)).toBeLessThanOrEqual(written * 8 + 7);
        // Cost should be close to actual bits written
        expect(Math.abs(riceCost(v, k) - written * 8)).toBeLessThanOrEqual(7);
      }
    }
  });
});

// ── BPC ─────────────────────────────────────────────────────

describe("BPC", () => {
  it("all zero", () => {
    const result = computeBpcs([0, 0, 0, 0, 0, 0, 0, 0], 0);
    expect([...result]).toEqual([0, 0]);
  });

  it("lossy floor", () => {
    expect(computeBpcs([0, 0, 0, 0], 3)[0]).toBe(3);
  });

  it("correct widths", () => {
    const c = [1, 0, 0, 0, 0, 0, 3, 0, -7, 1, 0, -2, 0, -1024, 0, 100];
    const b = computeBpcs(c, 0);
    expect([...b]).toEqual([1, 2, 3, 11]);
  });

  it("I32_MIN", () => {
    expect(computeBpcs([I32_MIN, 0, 0, 0], 0)[0]).toBe(32);
  });
});

// ── DPCM ────────────────────────────────────────────────────

function dpcmRoundtrip(bpcs: number[]): void {
  const arr = new Uint8Array(bpcs);
  const k = pickRiceKForBpcs(arr, 6);
  expect(k).toBeLessThanOrEqual(6);
  const buf = new Uint8Array(1024);
  const bw = new BitWriter(buf);
  encodeBpcsDpcm(bw, arr, k);
  bw.flush();
  expect(bw.isOverflow()).toBe(false);
  const out = new Uint8Array(arr.length);
  decodeBpcsDpcm(
    new BitReader(new Uint8Array(buf.buffer, 0, bw.bytesWritten())),
    arr.length, arr[0], k, out,
  );
  expect([...out]).toEqual([...arr]);
}

describe("DPCM", () => {
  it("smooth", () => dpcmRoundtrip([5, 5, 5, 6, 6, 6, 7, 7, 8, 8]));
  it("jumpy", () => dpcmRoundtrip([0, 8, 0, 16, 4, 12, 2, 20, 1, 5]));
  it("long constant", () => dpcmRoundtrip(new Array(100).fill(7)));

  it("single group", () => {
    const buf = new Uint8Array(16);
    const bw = new BitWriter(buf);
    encodeBpcsDpcm(bw, new Uint8Array([5]), 0);
    bw.flush();
    expect(bw.bytesWritten()).toBe(0);
    // decode with zero groups of DPCM data
    decodeBpcsDpcm(new BitReader(new Uint8Array(0)), 1, 5, 0, new Uint8Array(1));
  });

  it("caps out of range", () => {
    const out = new Uint8Array(1);
    decodeBpcsDpcm(new BitReader(new Uint8Array(0)), 1, 99, 0, out);
    expect(out[0]).toBe(32);
  });

  it("clamps negative delta", () => {
    const buf = new Uint8Array(16);
    const bw = new BitWriter(buf);
    encodeBpcsDpcm(bw, new Uint8Array([2, 0, 0]), 0);
    bw.flush();
    const out = new Uint8Array(3);
    decodeBpcsDpcm(
      new BitReader(new Uint8Array(buf.buffer, 0, bw.bytesWritten())),
      3, 2, 0, out,
    );
    expect([...out]).toEqual([2, 0, 0]);
  });

  it("rice corruption", () => {
    const out = new Uint8Array(5);
    decodeBpcsDpcm(new BitReader(new Uint8Array(64).fill(0xFF)), 5, 7, 0, out);
    expect([...out]).toEqual([7, 7, 7, 7, 7]);
  });
});

// ── pick rice k ─────────────────────────────────────────────

describe("pickRiceKForBpcs", () => {
  it("constant → k=0", () => {
    expect(pickRiceKForBpcs(new Uint8Array(20).fill(5), 6)).toBe(0);
  });

  it("big jumps → k >= 3", () => {
    expect(pickRiceKForBpcs(new Uint8Array([0, 16, 0, 16, 0, 16, 0, 16]), 6))
      .toBeGreaterThanOrEqual(3);
  });
});

// ── pack / unpack ───────────────────────────────────────────

function packRoundtrip(coeffs: number[], lossyBits: number): void {
  const numGroups = coeffs.length / 4;
  const bpcs = computeBpcs(coeffs, lossyBits);
  const buf = new Uint8Array(8192);
  const bw = new BitWriter(buf);
  packCoeffs(bw, coeffs, 0, bpcs, 0, lossyBits, numGroups);
  bw.flush();
  expect(bw.isOverflow()).toBe(false);
  const out = new Array<number>(coeffs.length).fill(0);
  unpackCoeffs(
    new BitReader(new Uint8Array(buf.buffer, 0, bw.bytesWritten())),
    bpcs, 0, lossyBits, numGroups, out, 0,
  );
  for (let i = 0; i < coeffs.length; i++) {
    expect(out[i]).toBe(quantizeCoeff(coeffs[i], lossyBits));
  }
}

describe("packCoeffs / unpackCoeffs", () => {
  it("all zero", () => {
    packRoundtrip([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0);
    packRoundtrip([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3);
  });

  it("small lossless", () => {
    packRoundtrip([1, -1, 2, -2, 0, 7, -7, 100], 0);
  });

  it("lossy", () => {
    const c = [1, -1, 7, -8, 16, -16, 100, -100, 0, 0, 0, 0, 1024, -1024, 5000, -5000];
    packRoundtrip(c, 3);
    packRoundtrip(c, 5);
  });

  it("I32 extremes", () => {
    packRoundtrip([I32_MAX, I32_MIN, 0, 1], 0);
    packRoundtrip([I32_MAX, I32_MIN, 0, 1], 5);
  });

  it("lossy kills small", () => {
    const c = [7, -7, 4, -4];
    const bpcs = computeBpcs(c, 3);
    expect(bpcs[0]).toBe(3);
    const buf = new Uint8Array(64);
    const bw = new BitWriter(buf);
    packCoeffs(bw, c, 0, bpcs, 0, 3, 1);
    bw.flush();
    const out = [0, 0, 0, 0];
    unpackCoeffs(
      new BitReader(new Uint8Array(buf.buffer, 0, bw.bytesWritten())),
      bpcs, 0, 3, 1, out, 0,
    );
    expect(out).toEqual([0, 0, 0, 0]);
  });

  it("clamps magnitude above I32_MAX", () => {
    // Craft a stream whose reconstructed magnitude lands in (2^31, 2^32):
    // bpc=32, lossy=0 → nbits=32, m=0xC0000000 (3.2B) with a negative sign.
    // The magnitude exceeds I32_MAX, so it must saturate to I32_MIN.
    const bpcs = new Uint8Array([32]);
    const buf = new Uint8Array(64);
    const bw = new BitWriter(buf);
    bw.writeBits(0xC0000000, 32); // coeff 0 magnitude > 2^31
    bw.writeBits(1, 1);           // coeff 0 sign = negative
    for (let i = 0; i < 3; i++) bw.writeBits(0, 32); // coeffs 1-3 are zero
    bw.flush();
    const out = [0, 0, 0, 0];
    unpackCoeffs(
      new BitReader(new Uint8Array(buf.buffer, 0, bw.bytesWritten())),
      bpcs, 0, 0, 1, out, 0,
    );
    expect(out).toEqual([I32_MIN, 0, 0, 0]);
  });

  it("no signs for zeros", () => {
    const c = [16, 0, 0, -16];
    const bpcs = computeBpcs(c, 3);
    expect(bpcs[0]).toBe(5);
    const buf = new Uint8Array(64);
    const bw = new BitWriter(buf);
    packCoeffs(bw, c, 0, bpcs, 0, 3, 1);
    bw.flush();
    expect(bw.bytesWritten()).toBe(2);
  });

  it("large roundtrip", () => {
    const c = new Array<number>(256);
    for (let i = 0; i < 256; i++) {
      if (i < 4) {
        c[i] = [I32_MAX, I32_MIN, 0x7FFFFFFF, 0x80000001 >> 0][i];
      } else {
        const v = i * 13 + 1;
        c[i] = (i & 1) ? -v : (i % 7 === 0 ? 0 : v);
      }
    }
    packRoundtrip(c, 0);
    packRoundtrip(c, 2);
    packRoundtrip(c, 5);
  });

  it("lossy bits 31", () => {
    const c = [I32_MIN, I32_MAX, -1, 1, 0, 0x40000000, -0x40000000, 42];
    packRoundtrip(c, 31);
  });

  it("saturates I32_MAX", () => {
    const c = [I32_MAX - 1, I32_MAX, I32_MIN + 1, I32_MIN];
    const bpcs = computeBpcs(c, 1);
    expect(bpcs[0]).toBe(32);
    const buf = new Uint8Array(256);
    const bw = new BitWriter(buf);
    packCoeffs(bw, c, 0, bpcs, 0, 1, 1);
    bw.flush();
    expect(bw.isOverflow()).toBe(false);
    const out = new Array<number>(4).fill(0);
    unpackCoeffs(
      new BitReader(new Uint8Array(buf.buffer, 0, bw.bytesWritten())),
      bpcs, 0, 1, 1, out, 0,
    );
    expect(out).toEqual([2147483646, 2147483646, -2147483646, I32_MIN]);
  });
});

// ── quantize ────────────────────────────────────────────────

describe("quantize", () => {
  it("lossy=0 noop", () => {
    const a = [0, 7, -3, 1000, -16000];
    quantize(a, 0);
    expect(a).toEqual([0, 7, -3, 1000, -16000]);
  });

  it("lossy=32 zeros all", () => {
    const a = [7, -3, I32_MIN];
    quantize(a, 32);
    expect(a).toEqual([0, 0, 0]);
  });

  it("lossy=31 keeps min", () => {
    const a = [0, 1, -1, I32_MIN, I32_MAX];
    quantize(a, 31);
    expect(a[3]).toBe(I32_MIN);
    expect(a[4]).toBe(0);
  });

  it("truncates positive", () => {
    const a = [0, 1, 2, 3, 4, 7];
    quantize(a, 2);
    expect(a).toEqual([0, 0, 0, 0, 4, 4]);
  });

  it("truncates negative", () => {
    const a = [-1, -2, -3, -4, -7, -8];
    quantize(a, 2);
    expect(a).toEqual([0, 0, 0, -4, -4, -8]);
  });

  it("I32_MIN no UB", () => {
    const a = [I32_MIN];
    quantize(a, 3);
    expect(a[0]).toBe(I32_MIN);
  });

  it("zero stays zero", () => {
    const a = [0];
    quantize(a, 5);
    expect(a[0]).toBe(0);
  });

  it("lands on grid", () => {
    const a = [0, 1, 7, 8, 9, 15, 16, -17];
    quantize(a, 3);
    for (const v of a) expect(v & 7).toBe(0);
  });
});

// ── Laplacian scale ────────────────────────────────────────

describe("estimateLaplacianScale", () => {
  it("empty", () => {
    expect(estimateLaplacianScale([])).toBe(0);
  });

  it("mean abs", () => {
    expect(estimateLaplacianScale([10, -10, 20, -20, 0])).toBeCloseTo(12, 5);
  });
});

// ── Codec roundtrip ────────────────────────────────────────

describe("codec roundtrip", () => {
  it("tiny", () => roundtrip([0, 0, 0, 0], 0));

  it("lossless", () => {
    const c = new Array<number>(16);
    for (let i = 0; i < 16; i++) {
      c[i] = (i & 1) ? -(i * 7) : i * 5;
    }
    roundtrip(c, 0);
  });

  it("lossy levels", () => {
    const c = new Array<number>(64);
    for (let i = 0; i < 64; i++) {
      c[i] = (i * 97 - 1024) * ((i & 1) ? -1 : 1);
    }
    roundtrip(c, 2);
    roundtrip(c, 5);
  });

  it("I32 extremes", () => {
    roundtrip([I32_MAX, I32_MIN, 0, -1, 1, -2, 2, 1234567], 0);
    roundtrip([I32_MAX, I32_MIN, 0, -1, 1, -2, 2, 1234567], 5);
  });

  it("larger", () => {
    const c = new Array<number>(2048);
    for (let i = 0; i < 2048; i++) {
      const v = ((i * 13 + 7) & 0xFFF);
      c[i] = (i & 1) ? -v : v;
    }
    roundtrip(c, 0);
    roundtrip(c, 3);
  });

  it("rejects unaligned", () => {
    const buf = new Uint8Array(64);
    expect(() => encode([0, 0, 0, 0, 0], 0, buf)).toThrow("BadInput");
  });

  it("rejects bad lossy", () => {
    const buf = new Uint8Array(64);
    expect(() => encode([0, 0, 0, 0], 32, buf)).toThrow("BadInput");
    expect(() => encode([0, 0, 0, 0], 99, buf)).toThrow("BadInput");
  });

  it("rejects small cap", () => {
    const buf = new Uint8Array(4);
    expect(() => encode([0, 0, 0, 0], 0, buf)).toThrow("NoSpace");
  });

  it("rejects bad magic", () => {
    expect(() => decode(new Uint8Array(12), [0, 0, 0, 0])).toThrow("BadMagic");
  });

  it("rejects bad version", () => {
    const buf = new Uint8Array(12);
    buf[0] = 87; buf[1] = 67; buf[2] = 69; buf[3] = 0; // "WCE\0"
    buf[4] = 1; // numGroups = 1
    buf[8] = FORMAT_VERSION + 99;
    expect(() => decode(buf, [0, 0, 0, 0])).toThrow("BadVersion");
  });

  it("rejects size mismatch", () => {
    const buf = new Uint8Array(64);
    const n = encode([1, 2, 3, 4], 0, buf);
    expect(() => decode(new Uint8Array(buf.buffer, 0, n), new Array(8).fill(0)))
      .toThrow("BadInput");
  });

  it("truncated", () => {
    const c = [100, -200, 300, -400, 500, -600, 700, -800];
    const buf = new Uint8Array(128);
    const n = encode(c, 0, buf);
    const half = HEADER_SIZE + Math.floor((n - HEADER_SIZE) / 2);
    expect(() => decode(new Uint8Array(buf.buffer, 0, half), new Array(8).fill(0)))
      .toThrow("Truncated");
  });

  it("empty band", () => {
    const buf = new Uint8Array(64);
    const n = encode([], 0, buf);
    expect(decode(new Uint8Array(buf.buffer, 0, n), [])).toBe(0);
  });

  it("forced mode roundtrip", () => {
    const c = new Array<number>(64);
    for (let i = 0; i < 64; i++) {
      c[i] = (i * 97 - 1024) * ((i & 1) ? -1 : 1);
    }
    const modes: [number, boolean][] = [
      [PREDICTOR_RUNNING, false], [PREDICTOR_RUNNING, true],
      [PREDICTOR_ZERO, false], [PREDICTOR_ZERO, true],
    ];
    for (const [pred, flag] of modes) {
      for (const rk of [0, 3, 6]) {
        const b = new Uint8Array(4096);
        const n = encodeWithOptions(c, 3, { predictor: pred, sparseFlag: flag, riceK: rk }, b);
        const out = new Array<number>(64).fill(0);
        expect(decode(new Uint8Array(b.buffer, 0, n), out)).toBe(3);
        for (let i = 0; i < c.length; i++) {
          expect(out[i]).toBe(quantizeCoeff(c[i], 3));
        }
      }
    }
  });

  it("sparse block mix", () => {
    const c = new Array<number>(256).fill(0);
    c[0] = 1024;
    c[1] = -512;
    c[128] = 256;
    c[129] = -128;
    roundtrip(c, 3);
  });

  it("partial final block", () => {
    const c = new Array<number>(40);
    for (let i = 0; i < 40; i++) {
      c[i] = (i * 7) * ((i & 1) ? -1 : 1);
    }
    roundtrip(c, 0);
  });

  it("corrupt rice", () => {
    const c = new Array<number>(32);
    for (let i = 0; i < 32; i++) {
      c[i] = ((i + 1) * 100) * ((i & 1) ? -1 : 1);
    }
    const buf = new Uint8Array(2048);
    const n = encode(c, 0, buf);
    // Corrupt the payload
    for (let i = HEADER_SIZE; i < n; i++) buf[i] = 0xFF;
    expect(() => decode(new Uint8Array(buf.buffer, 0, n), new Array(32).fill(0)))
      .toThrow("Corrupt");
  });

  it("forced bad input", () => {
    const c = [1, 2, 3, 4];
    const b = new Uint8Array(256);
    expect(() => encodeWithOptions(c, 0, { predictor: 99, sparseFlag: false, riceK: 0 }, b))
      .toThrow("BadInput");
    expect(() => encodeWithOptions(c, 0, {
      predictor: PREDICTOR_RUNNING, sparseFlag: false, riceK: 17,
    }, b)).toThrow("BadInput");
    expect(() => encodeWithOptions(c, 0, {
      predictor: PREDICTOR_RUNNING, sparseFlag: false, riceK: 99,
    }, b)).toThrow("BadInput");
  });

  it("decode bad lossy", () => {
    const h = new Uint8Array(12);
    h[0] = 87; h[1] = 67; h[2] = 69; h[3] = 0;
    h[4] = 1; h[8] = FORMAT_VERSION; h[9] = 33;
    expect(() => decode(h, [0, 0, 0, 0])).toThrow("BadInput");
  });

  it("initial prev mismatch", () => {
    const c = [1, 2, 3, 4];
    const b = new Uint8Array(256);
    const n = encode(c, 3, b);
    b[11] = 99;
    expect(() => decode(new Uint8Array(b.buffer, 0, n), [0, 0, 0, 0])).toThrow("BadInput");
  });
});

// ── Mode selection ─────────────────────────────────────────

describe("modeSelect / computeAllComboCosts", () => {
  it("empty numGroups", () => {
    const bpcs = new Uint8Array(0);
    const sel = modeSelect(bpcs, 0, 3);
    expect(sel.predictor).toBe(false);
    expect(sel.sparseFlag).toBe(false);
    expect(sel.riceK).toBe(0);
    expect(sel.bestCost).toBe(0);
  });

  it("constant BPCs favor RUNNING, k=0", () => {
    const bpcs = new Uint8Array(20).fill(5);
    const sel = modeSelect(bpcs, 20, 0);
    expect(sel.riceK).toBeLessThanOrEqual(1);
    // Running should be cheaper than zero for constant input
    const costs = computeAllComboCosts(bpcs, 20, 0);
    expect(costs[0][sel.riceK]).toBeLessThanOrEqual(costs[2][sel.riceK]);
  });

  it("sparse blocks favor sparseFlag", () => {
    // All-zero BPCs — sparse should win
    const bpcs = new Uint8Array(16).fill(0);
    const costs = computeAllComboCosts(bpcs, 16, 0);
    // Combo 1 (RUNNING + sparse) or 3 (ZERO + sparse) should be cheaper
    // than 0 or 2 for k=0
    expect(Math.min(costs[1][0], costs[3][0]))
      .toBeLessThanOrEqual(Math.min(costs[0][0], costs[2][0]));
  });

  it("costs matrix has correct shape", () => {
    const bpcs = new Uint8Array(40).fill(3);
    const costs = computeAllComboCosts(bpcs, 40, 5);
    expect(costs.length).toBe(4);
    for (const row of costs) {
      expect(row.length).toBe(7); // 0..PICK_K_MAX
    }
  });
});

// ── computeBandEntropy ─────────────────────────────────────

describe("computeBandEntropy", () => {
  it("empty coeffs", () => {
    const result = computeBandEntropy([], 0);
    expect(result.bitCost).toBe(0);
    expect(result.numGroups).toBe(0);
    expect(result.predictor).toBe("running");
  });

  it("all-zero coeffs → low bit cost", () => {
    const coeffs = new Array(16).fill(0);
    const result = computeBandEntropy(coeffs, 0);
    expect(result.bitCost).toBeGreaterThan(0);
    expect(result.numGroups).toBe(4);
    // All-zero should pick sparse mode
    expect(result.sparseFlag).toBe(true);
  });

  it("irregular coeffs → higher bit cost", () => {
    const regular = new Array(16).fill(0);
    const irregular = [100, -200, 300, -400, 0, 0, 0, 0, 50, -60, 70, -80, 0, 0, 0, 0];
    const regEntropy = computeBandEntropy(regular, 0);
    const irrEntropy = computeBandEntropy(irregular, 0);
    // Irregular signal should cost more bits
    expect(irrEntropy.bitCost).toBeGreaterThan(regEntropy.bitCost);
  });

  it("returns valid riceK and predictor", () => {
    const coeffs = [1, -2, 3, -4, 5, -6, 7, -8, 9, -10, 11, -12];
    const result = computeBandEntropy(coeffs, 0);
    expect(result.riceK).toBeGreaterThanOrEqual(0);
    expect(result.riceK).toBeLessThanOrEqual(6);
    expect(["running", "zero"]).toContain(result.predictor);
    expect(typeof result.sparseFlag).toBe("boolean");
    expect(result.costs.length).toBe(4);
    expect(result.bpcs).toBeInstanceOf(Uint8Array);
    expect(result.bpcs.length).toBe(result.numGroups);
  });

  it("lossyBits > 0 increases sparsity", () => {
    const coeffs = [1, -1, 2, -2, 7, -7, 8, -8];
    const lossless = computeBandEntropy(coeffs, 0);
    const lossy = computeBandEntropy(coeffs, 3);
    // Lossy should have equal or lower bit cost (small values zeroed out)
    expect(lossy.bitCost).toBeLessThanOrEqual(lossless.bitCost);
  });
});
