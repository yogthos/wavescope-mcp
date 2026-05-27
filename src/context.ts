import { detectLanguage, LanguageConfig } from "./language.js";
import { computeSignal } from "./signal.js";
import {
  computeCWT,
  detectPeaks,
  WaveletCoefficients,
  Peak,
} from "./wavelet.js";

export interface ImportantPosition {
  position: number;
  coefficient: number;
  scale: number;
  label: string;
  filename?: string;
}

export interface BandResult {
  range: [number, number];
  content: string;
}

export interface WaveletContextResult {
  center: number;
  clamped: boolean;
  /** Original `center` requested by caller, present only when clamped. */
  clampedFrom?: number;
  bands: {
    fine: BandResult;
    medium: BandResult;
    coarse: BandResult;
  };
  waveletPeaks: ImportantPosition[];
}

export interface WaveletCoefficientsResult {
  /** The actual scale used (may differ from `requestedScale`). */
  scale: number;
  /** The scale originally requested by the caller. */
  requestedScale: number;
  /** Raw coefficient slice. */
  coefficients: number[];
  /** True when the requested range was clamped to the valid coefficient bounds. */
  clamped: boolean;
  /** Original {start, end} requested by caller, present only when clamped. */
  clampedFrom?: { start: number; end: number };
}

/** Band scale ranges used by buildMediumBand / buildCoarseBand. */
const BAND_SCALES = {
  fine: [1, 2] as const,
  medium: [4, 16] as const,
  coarse: [32, 128] as const,
};

/**
 * FileContext holds the wavelet index for a single file and provides
 * multi-resolution query methods.
 */
export class FileContext {
  readonly filename: string;
  readonly lines: string[];
  readonly language: LanguageConfig;
  readonly signal: number[];
  readonly coefficients: WaveletCoefficients;

  get lineCount(): number { return this.lines.length; }

  // Cached peak set — lazily computed once
  private _allPeaks: Peak[] | null = null;

  constructor(filename: string, content: string) {
    this.filename = filename;
    this.lines = content.split("\n");

    // Preserve trailing newline: if content ends with \n, ignore the empty last line
    if (content.endsWith("\n") && this.lines[this.lines.length - 1] === "") {
      this.lines.pop();
    }

    // Handle truly empty content
    if (this.lines.length === 1 && this.lines[0] === "") {
      this.lines = [];
    }

    this.language = detectLanguage(filename);
    this.signal = computeSignal(this.lines, this.language);
    this.coefficients = computeCWT(this.signal);
  }

  // ─── Cached peak access ──────────────────────────────────

  /**
   * Returns all peaks (lazy, cached). Multi-scale peaks at the same
   * position are preserved so that band assembly can filter by scale range.
   */
  private getAllPeaks(): Peak[] {
    if (this._allPeaks) return this._allPeaks;
    this._allPeaks = detectPeaks(this.coefficients, 0.0, 1000);
    return this._allPeaks;
  }

  // ─── Public API ──────────────────────────────────────────

  /**
   * Find important structural positions (class/function boundaries, etc.)
   * sorted by wavelet coefficient magnitude.
   */
  getImportantPositions(
    minCoefficient: number = 0.3,
    limit: number = 20,
  ): ImportantPosition[] {
    const allPeaks = this.getAllPeaks();
    // Deduplicate by position: keep the peak with the largest |coefficient|
    const bestMap = new Map<number, Peak>();
    for (const p of allPeaks) {
      if (Math.abs(p.coefficient) < minCoefficient) continue;
      const existing = bestMap.get(p.position);
      if (!existing || Math.abs(p.coefficient) > Math.abs(existing.coefficient)) {
        bestMap.set(p.position, p);
      }
    }
    return [...bestMap.values()]
      .sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient))
      .slice(0, limit)
      .map((p: Peak) => ({
        position: p.position,
        coefficient: p.coefficient,
        scale: p.scale,
        label: this.inferLabel(p.position),
      }));
  }

  /**
   * Multi-resolution context centered at a position.
   *
   * Returns three bands:
   * - fine: raw lines in a narrow window (~radius/5)
   * - medium: peak-based summary in a medium window (~radius/2)
   * - coarse: section-level overview across the full radius
   */
  queryWaveletContext(
    center: number,
    radius: number,
  ): WaveletContextResult {
    if (this.lineCount === 0) {
      const empty: WaveletContextResult = {
        center: 0,
        clamped: center !== 0,
        bands: {
          fine: { range: [0, 0], content: "" },
          medium: { range: [0, 0], content: "" },
          coarse: { range: [0, 0], content: "" },
        },
        waveletPeaks: [],
      };
      if (empty.clamped) empty.clampedFrom = center;
      return empty;
    }
    const cl = Math.max(0, Math.min(center, this.lineCount - 1));
    const clamped = center !== cl;
    const total = this.lineCount;

    // Fine band: ±radius/5, minimum 10 lines
    const fineRadius = Math.max(10, Math.floor(radius / 5));
    const fineStart = Math.max(0, cl - fineRadius);
    const fineEnd = Math.min(total - 1, cl + fineRadius);

    // Medium band: ±radius/2
    const medRadius = Math.floor(radius / 2);
    const medStart = Math.max(0, cl - medRadius);
    const medEnd = Math.min(total - 1, cl + medRadius);

    // Coarse band: full radius
    const coarseStart = Math.max(0, cl - radius);
    const coarseEnd = Math.min(total - 1, cl + radius);

    // Get peaks in the full radius
    const allPeaks = this.getAllPeaks();
    const nearbyPeaks = allPeaks.filter(
      (p) => p.position >= coarseStart && p.position <= coarseEnd,
    );

    const result: WaveletContextResult = {
      center: cl,
      clamped,
      bands: {
        fine: {
          range: [fineStart, fineEnd],
          content: this.lines.slice(fineStart, fineEnd + 1).join("\n"),
        },
        medium: {
          range: [medStart, medEnd],
          content: this.buildMediumBand(medStart, medEnd, nearbyPeaks),
        },
        coarse: {
          range: [coarseStart, coarseEnd],
          content: this.buildCoarseBand(coarseStart, coarseEnd, nearbyPeaks),
        },
      },
      waveletPeaks: this.dedupPeaks(nearbyPeaks).slice(0, 10).map((p) => ({
        position: p.position,
        coefficient: p.coefficient,
        scale: p.scale,
        label: this.inferLabel(p.position),
      })),
    };
    if (clamped) result.clampedFrom = center;
    return result;
  }

  /**
   * Pick a representative scale for a region of the given size, matched
   * to the wavelength most useful for summarizing structure at that
   * resolution. Snaps to the closest available scale.
   *
   * Heuristic (region size in lines → target scale):
   *   ≤ 50    → 2
   *   ≤ 200   → 8
   *   ≤ 800   → 32
   *   > 800   → 128
   */
  autoScale(start: number, end: number): number {
    const size = Math.max(1, end - start + 1);
    let target: number;
    if (size <= 50) target = 2;
    else if (size <= 200) target = 8;
    else if (size <= 800) target = 32;
    else target = 128;
    return this.findClosestScale(target);
  }

  /**
   * Compressed/summarized view of a region using wavelet peaks at a given scale.
   */
  getSummaryAtScale(
    start: number,
    end: number,
    scale?: number,
  ): string {
    if (this.lines.length === 0) return "";
    const maxIdx = this.lines.length - 1;
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    // Fully out of range → empty, don't fabricate content from clamped boundary.
    if (lo > maxIdx || hi < 0) return "";
    const s = Math.max(0, lo);
    const e = Math.min(maxIdx, hi);

    const allPeaks = this.getAllPeaks();

    // Auto-select a representative scale when caller doesn't pin one.
    const resolvedScale = scale !== undefined
      ? this.findClosestScale(scale)
      : this.autoScale(s, e);

    const peaksInRange = allPeaks.filter(
      (p) =>
        p.position >= s &&
        p.position <= e &&
        p.scale === resolvedScale,
    );

    if (peaksInRange.length === 0) {
      return this.buildRangeSummary(s, e);
    }

    return this.buildPeakSummary(peaksInRange, s, e);
  }

  getWaveletCoefficients(
    start: number,
    end: number,
    scale: number,
  ): WaveletCoefficientsResult {
    if (this.coefficients.coefficients.length === 0) {
      return {
        scale,
        requestedScale: scale,
        coefficients: [],
        clamped: false,
      };
    }
    const resolvedScale = this.findClosestScale(scale);
    const scaleIdx = this.coefficients.scales.indexOf(resolvedScale);

    const coeffs = this.coefficients.coefficients[scaleIdx];
    if (!coeffs) {
      return {
        scale: resolvedScale,
        requestedScale: scale,
        coefficients: [],
        clamped: false,
      };
    }
    const maxIdx = coeffs.length - 1;
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    // Fully out of range — return empty, signal clamping rather than slice
    // to the boundary and return a misleading single coefficient.
    if (lo > maxIdx || hi < 0) {
      return {
        scale: resolvedScale,
        requestedScale: scale,
        coefficients: [],
        clamped: true,
        clampedFrom: { start, end },
      };
    }
    const s = Math.max(0, lo);
    const e = Math.min(maxIdx, hi);
    const clamped = s !== start || e !== end;
    const result: WaveletCoefficientsResult = {
      scale: resolvedScale,
      requestedScale: scale,
      coefficients: coeffs.slice(s, e + 1),
      clamped,
    };
    if (clamped) result.clampedFrom = { start, end };
    return result;
  }

  // ─── private helpers ──────────────────────────────────────

  private dedupPeaks(peaks: Peak[]): Peak[] {
    const bestMap = new Map<number, Peak>();
    for (const p of peaks) {
      const existing = bestMap.get(p.position);
      if (!existing || Math.abs(p.coefficient) > Math.abs(existing.coefficient)) {
        bestMap.set(p.position, p);
      }
    }
    return [...bestMap.values()];
  }

  /**
   * Snap `scale` to the nearest scale present in the wavelet index.
   * Ties (e.g. 3 → equidistant from 2 and 4) resolve to the lower scale
   * (insertion-order stable on Array.reduce).
   */
  private findClosestScale(scale: number): number {
    const scales = this.coefficients.scales;
    if (scales.length === 0) return scale;
    return scales.reduce((prev, curr) =>
      Math.abs(curr - scale) < Math.abs(prev - scale) ? curr : prev,
    );
  }

  private inferLabel(pos: number): string {
    if (pos < 0 || pos >= this.lines.length) return "unknown";

    const line = this.lines[pos].trim();
    if (!line) return `line ${pos}`;

    // Tokenize on code delimiters (same regex as signal.ts) so that
    // forms like "(defn foo" correctly produce token "defn"
    const tokens = line.split(/[\s()[\]{},;:'".=!<>+\-*/&|^~%@#`]+/).filter(Boolean);
    // Also keep whitespace-split tokens as fallback for label reading
    const wsTokens = line.split(/\s+/);

    if (this.language.name === "python") {
      if (wsTokens[0] === "class") return `class ${wsTokens[1]?.replace(":", "")}`;
      if (wsTokens[0] === "def") return `def ${wsTokens[1]?.split("(")[0]}`;
      if (wsTokens[0] === "import") return `import ${wsTokens.slice(1).join(" ")}`;
      if (wsTokens[0] === "from") return `from ${wsTokens.slice(1).join(" ")}`;
      if (line.startsWith("@")) return `decorator ${line.split(/[\s()]+/)[0].slice(1)}`;
      if (line.startsWith("if __name__")) return "main guard";
    } else {
      // Decorator detection (before keyword checks so "export @foo class" works)
      if (line.startsWith("@")) {
        const decorator = line.split(/[\s()]+/)[0];
        return `decorator ${decorator.slice(1)}`;
      }
      // Import/export at top (before keyword checks to capture "export class Foo")
      if (wsTokens[0] === "import") return `import ${wsTokens.slice(1).join(" ")}`;
      if (wsTokens[0] === "export") {
        const rest = wsTokens.slice(1).join(" ");
        return `export ${rest.substring(0, 40)}`;
      }
      // Use code-delimiter tokens for keyword matching
      if (tokens.includes("class")) {
        const idx = tokens.indexOf("class");
        return `class ${tokens[idx + 1]?.replace(/\{.*/, "").replace(/extends|implements/g, "").trim()}`;
      }
      if (tokens.includes("interface")) {
        const idx = tokens.indexOf("interface");
        return `interface ${tokens[idx + 1]?.replace(/\{.*/, "").trim()}`;
      }
      if (tokens.includes("enum")) {
        const idx = tokens.indexOf("enum");
        return `enum ${tokens[idx + 1]?.replace(/\{.*/, "").trim()}`;
      }
      if (tokens.includes("trait")) {
        const idx = tokens.indexOf("trait");
        return `trait ${tokens[idx + 1]?.replace(/\{.*/, "").trim()}`;
      }
      if (tokens.includes("struct")) {
        const idx = tokens.indexOf("struct");
        return `struct ${tokens[idx + 1]?.replace(/\{.*/, "").trim()}`;
      }
      if (tokens.includes("object")) {
        const idx = tokens.indexOf("object");
        return `object ${tokens[idx + 1]?.replace(/\{.*/, "").trim()}`;
      }
      if (tokens.includes("function")) {
        const idx = tokens.indexOf("function");
        return `function ${tokens[idx + 1]?.split("(")[0]}`;
      }
      if (tokens.includes("fn") && !tokens.includes("defn")) {
        // Rust — check defn first to avoid false match on Clojure
        return `fn ${tokens[tokens.indexOf("fn") + 1]?.split("(")[0]}`;
      }
      if (tokens.includes("fun")) {
        // Kotlin
        return `fun ${tokens[tokens.indexOf("fun") + 1]?.split("(")[0]}`;
      }
      if (tokens.includes("func")) {
        // Go
        return `func ${tokens[tokens.indexOf("func") + 1]?.split("(")[0]}`;
      }
      if (tokens.includes("def")) {
        // Scala
        return `def ${tokens[tokens.indexOf("def") + 1]?.split("(")[0]}`;
      }
      if (tokens.includes("defn")) {
        // Clojure
        return `defn ${tokens[tokens.indexOf("defn") + 1]}`;
      }
      if (tokens.includes("defmacro")) {
        return `defmacro ${tokens[tokens.indexOf("defmacro") + 1]}`;
      }
      if (tokens.includes("defprotocol")) {
        return `defprotocol ${tokens[tokens.indexOf("defprotocol") + 1]}`;
      }
      if (tokens.includes("defrecord")) {
        return `defrecord ${tokens[tokens.indexOf("defrecord") + 1]}`;
      }
      if (tokens.includes("deftype")) {
        return `deftype ${tokens[tokens.indexOf("deftype") + 1]}`;
      }
      if (tokens.includes("impl")) {
        return `impl ${tokens[tokens.indexOf("impl") + 1]?.split("(")[0]}`;
      }
      if (tokens.includes("protocol")) {
        return `protocol ${tokens[tokens.indexOf("protocol") + 1]}`;
      }
      if (tokens.includes("extension")) {
        return `extension ${tokens[tokens.indexOf("extension") + 1]}`;
      }
    }

    return line.substring(0, 50);
  }

  private buildMediumBand(
    start: number,
    end: number,
    peaks: Peak[],
  ): string {
    const medPeaks = peaks
      .filter(
        (p) =>
          p.position >= start &&
          p.position <= end &&
          p.scale >= BAND_SCALES.medium[0] &&
          p.scale <= BAND_SCALES.medium[1],
      )
      .sort((a, b) => a.position - b.position);

    if (medPeaks.length === 0) {
      return this.buildRangeSummary(start, end);
    }

    return this.buildPeakSummary(medPeaks, start, end);
  }

  private buildCoarseBand(
    start: number,
    end: number,
    peaks: Peak[],
  ): string {
    const coarsePeaks = peaks
      .filter(
        (p) =>
          p.position >= start &&
          p.position <= end &&
          p.scale >= BAND_SCALES.coarse[0] &&
          p.scale <= BAND_SCALES.coarse[1],
      )
      .sort((a, b) => a.position - b.position);

    if (coarsePeaks.length === 0) {
      const allInRange = peaks
        .filter((p) => p.position >= start && p.position <= end)
        .sort((a, b) => a.position - b.position);

      if (allInRange.length === 0) {
        return this.buildRangeSummary(start, end);
      }
      return this.buildSectionSummary(allInRange, start, end);
    }

    return this.buildSectionSummary(coarsePeaks, start, end);
  }

  private buildRangeSummary(start: number, end: number): string {
    if (start > end) return "";
    const previewLines = Math.min(5, end - start + 1);
    const parts: string[] = [];
    const step = Math.ceil((end - start + 1) / previewLines);
    for (let i = start; i <= end; i += step) {
      const line = this.lines[i].trim();
      if (line) {
        parts.push(`[${i}] ${line.substring(0, 80)}`);
      }
    }
    return parts.join("\n");
  }

  private buildPeakSummary(
    peaks: Peak[],
    rangeStart: number,
    rangeEnd: number,
  ): string {
    const parts: string[] = [];
    let prevEnd = rangeStart - 1;

    for (const peak of peaks) {
      if (peak.position > prevEnd + 1) {
        parts.push(`[${prevEnd + 1}-${peak.position - 1}] ...`);
      }
      parts.push(
        `[${peak.position}] ${this.lines[peak.position].trim().substring(0, 80)}`,
      );
      prevEnd = peak.position;
    }

    if (prevEnd < rangeEnd) {
      parts.push(`[${prevEnd + 1}-${rangeEnd}] ...`);
    }

    return parts.join("\n");
  }

  private buildSectionSummary(
    peaks: Peak[],
    rangeStart: number,
    rangeEnd: number,
  ): string {
    const parts: string[] = [];
    let prevPos = rangeStart;
    let currentSection = "";

    // Set the first section label BEFORE the loop so the initial
    // region [rangeStart, firstPeak-1] gets a label
    if (peaks.length > 0) {
      currentSection = this.inferLabel(peaks[0].position);
    }

    for (const peak of peaks) {
      if (currentSection && prevPos < peak.position) {
        parts.push(`[${prevPos}-${peak.position - 1}] ${currentSection}`);
      }
      currentSection = this.inferLabel(peak.position);
      prevPos = peak.position;
    }

    if (currentSection && prevPos <= rangeEnd) {
      parts.push(`[${prevPos}-${rangeEnd}] ${currentSection}`);
    }

    if (parts.length === 0) {
      parts.push(`[${rangeStart}-${rangeEnd}] (code region)`);
    }

    return parts.join("\n");
  }
}
