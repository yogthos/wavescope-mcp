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
}

export interface BandResult {
  range: [number, number];
  content: string;
}

export interface WaveletContextResult {
  center: number;
  clamped: boolean;
  bands: {
    fine: BandResult;
    medium: BandResult;
    coarse: BandResult;
  };
  waveletPeaks: ImportantPosition[];
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
    this._allPeaks = detectPeaks(this.coefficients, 0.0, 500);
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
    const cl = Math.max(0, Math.min(center, this.lineCount - 1));
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

    return {
      center: cl,
      clamped: center !== cl,
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
  }

  /**
   * Compressed/summarized view of a region using wavelet peaks at a given scale.
   */
  getSummaryAtScale(
    start: number,
    end: number,
    scale?: number,
  ): string {
    let s = Math.max(0, start);
    let e = Math.min(this.lines.length - 1, end);
    if (s > e) [s, e] = [e, s];

    const allPeaks = this.getAllPeaks();

    // Filter peaks in range, optionally matching closest scale
    const resolvedScale = scale !== undefined
      ? this.findClosestScale(scale)
      : undefined;

    const peaksInRange = allPeaks.filter(
      (p) =>
        p.position >= s &&
        p.position <= e &&
        (resolvedScale === undefined || p.scale === resolvedScale),
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
  ): number[] {
    const resolvedScale = this.findClosestScale(scale);
    const scaleIdx = this.coefficients.scales.indexOf(resolvedScale);

    const coeffs = this.coefficients.coefficients[scaleIdx];
    let s = Math.max(0, start);
    let e = Math.min(coeffs.length - 1, end);

    // Guard inverted range
    if (s > e) [s, e] = [e, s];

    return coeffs.slice(s, e + 1);
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
    if (!line) return `line ${pos + 1}`;

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
      if (wsTokens[0] === "@") return `decorator ${wsTokens[0].slice(1)}`;
      if (line.startsWith("if __name__")) return "main guard";
    } else {
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
      if (tokens.includes("impl")) {
        return `impl ${tokens[tokens.indexOf("impl") + 1]?.split("(")[0]}`;
      }
      if (tokens.includes("protocol")) {
        return `protocol ${tokens[tokens.indexOf("protocol") + 1]}`;
      }
      if (tokens.includes("extension")) {
        return `extension ${tokens[tokens.indexOf("extension") + 1]}`;
      }
      if (wsTokens[0] === "import") return `import ${wsTokens.slice(1).join(" ")}`;
      if (wsTokens[0] === "export") {
        const rest = wsTokens.slice(1).join(" ");
        return `export ${rest.substring(0, 40)}`;
      }
      if (wsTokens[0] === "@") return `decorator ${wsTokens[0].slice(1)}`;
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
