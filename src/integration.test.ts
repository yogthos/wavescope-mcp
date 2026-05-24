import { describe, it, expect } from "vitest";
import { FileContext } from "./context.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSelfFile(name: string): string {
  return readFileSync(join(__dirname, name), "utf-8");
}

describe("integration: self-analysis", () => {
  it("analyzes wavelet.ts and finds its own functions", () => {
    const content = loadSelfFile("wavelet.ts");
    const ctx = new FileContext("wavelet.ts", content);

    const positions = ctx.getImportantPositions(0.15, 15);
    expect(positions.length).toBeGreaterThan(0);

    const labels = positions.map((p) => p.label);
    const hasExport = labels.some(
      (l) => l.includes("export") || l.includes("function"),
    );
    expect(hasExport).toBe(true);
  });

  it("context query on context.ts returns fine band with content", () => {
    const content = loadSelfFile("context.ts");
    const ctx = new FileContext("context.ts", content);

    const classLine = content.split("\n").findIndex(
      (l) => l.includes("export class FileContext"),
    );
    expect(classLine).toBeGreaterThan(0);

    const result = ctx.queryWaveletContext(classLine, 200);
    expect(result.bands.fine.content).toContain("FileContext");
    expect(result.bands.medium.content.length).toBeGreaterThan(0);
    expect(result.bands.coarse.content.length).toBeGreaterThan(0);
  });

  it("summary at scale gives non-empty result on signal.ts", () => {
    const content = loadSelfFile("signal.ts");
    const ctx = new FileContext("signal.ts", content);

    const summary = ctx.getSummaryAtScale(0, ctx.lineCount - 1, 16);
    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
  });

  it("project index on src directory finds all source files", async () => {
    const { ProjectIndex } = await import("./project.js");
    const project = await ProjectIndex.load(__dirname);

    const files = project.listFiles();
    expect(files.length).toBeGreaterThanOrEqual(6);

    // Should find the main source files (relative paths)
    expect(files).toContain("signal.ts");
    expect(files).toContain("wavelet.ts");
    expect(files).toContain("context.ts");
  });
});

describe("edge cases", () => {
  it("handles empty file", () => {
    const ctx = new FileContext("empty.py", "");
    expect(ctx.lineCount).toBe(0);
    expect(ctx.signal.length).toBe(0);
    expect(ctx.coefficients.scales.length).toBe(8);
    expect(ctx.coefficients.coefficients.every((c) => c.length === 0)).toBe(true);

    const positions = ctx.getImportantPositions(0.3, 10);
    expect(positions).toEqual([]);
  });

  it("handles single-line file", () => {
    const ctx = new FileContext("single.py", "x = 1");
    expect(ctx.lineCount).toBe(1);
    const result = ctx.queryWaveletContext(0, 50);
    expect(result.bands.fine.content).toBe("x = 1");
  });

  it("handles file with only comments", () => {
    const content = "# comment 1\n# comment 2\n# comment 3\n";
    const ctx = new FileContext("comments.py", content);
    const positions = ctx.getImportantPositions(0.1, 10);
    expect(positions).toEqual([]);
  });

  it("handles file with only blank lines", () => {
    const content = "\n\n\n";
    const ctx = new FileContext("blanks.py", content);
    const positions = ctx.getImportantPositions(0.1, 10);
    expect(positions).toEqual([]);
  });

  it("handles inline block comments with code before and after", () => {
    const content = "import { /* Foo */ Bar } from 'module';\n";
    const ctx = new FileContext("inline.ts", content);
    // "import" keyword should still be detected
    const signal = ctx.signal;
    expect(signal[0]).toBeGreaterThan(0.5);
  });

  it("handles keywords with adjacent punctuation", () => {
    const content = "function(arg) { for(const x of y) { if(!x)return; } }";
    const ctx = new FileContext("punct.js", content);
    const signal = ctx.signal;
    // Should detect function, for, const, if keywords despite adjacent parens
    expect(signal[0]).toBeGreaterThan(0.8);
  });
});
