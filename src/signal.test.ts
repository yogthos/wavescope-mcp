import { describe, it, expect } from "vitest";
import { computeSignal } from "./signal.js";
import { detectLanguage } from "./language.js";

describe("computeSignal", () => {
  const pyLang = detectLanguage("test.py");
  const tsLang = detectLanguage("test.ts");
  const goLang = detectLanguage("test.go");

  describe("Python", () => {
    it("returns zero for blank lines and comments", () => {
      const lines = [
        "",
        "  ",
        "# this is a comment",
        "   # indented comment",
      ];
      const signal = computeSignal(lines, pyLang);
      expect(signal).toEqual([0, 0, 0, 0]);
    });

    it("returns zero for docstrings", () => {
      const lines = [
        '"""Module docstring"""',
        '"""',
        "Multi-line",
        "docstring",
        '"""',
        "def foo(): pass",
      ];
      const signal = computeSignal(lines, pyLang);
      expect(signal[0]).toBe(0);
      expect(signal[1]).toBe(0);
      expect(signal[2]).toBe(0);
      expect(signal[3]).toBe(0);
      expect(signal[4]).toBe(0);
    });

    it("detects class and def as high-signal lines", () => {
      const lines = [
        "import os",
        "",
        "class DataProcessor:",
        "    def __init__(self, config):",
        "        pass",
        "    def process(self, data):",
        "        return data",
        "",
        "if __name__ == '__main__':",
        "    main()",
      ];
      const signal = computeSignal(lines, pyLang);

      expect(signal[0]).toBeGreaterThan(0.5);
      expect(signal[0]).toBeLessThanOrEqual(2.0);
      expect(signal[1]).toBe(0);
      expect(signal[2]).toBeGreaterThanOrEqual(1.0);
      expect(signal[2]).toBeLessThanOrEqual(2.0);
      expect(signal[3]).toBeGreaterThan(0.9);
      expect(signal[3]).toBeLessThanOrEqual(2.0);
      expect(signal[4]).toBeLessThan(0.5);
      expect(signal[5]).toBeGreaterThan(0.9);
      expect(signal[6]).toBeGreaterThan(0.1);
      expect(signal[7]).toBe(0);
      expect(signal[8]).toBeGreaterThan(0.2);
    });

    it("detects decorators", () => {
      const lines = [
        "@staticmethod",
        "def helper():",
        "    pass",
      ];
      const signal = computeSignal(lines, pyLang);
      expect(signal[0]).toBeGreaterThan(0.4);
      expect(signal[0]).toBeLessThanOrEqual(2.0);
    });

    it("indentation increases signal proportionally", () => {
      const lines = [
        "pass",
        "    pass",
        "        pass",
        "            pass",
      ];
      const signal = computeSignal(lines, pyLang);
      expect(signal[0]).toBeLessThan(signal[1]);
      expect(signal[1]).toBeLessThan(signal[2]);
      expect(signal[2]).toBeLessThan(signal[3]);
    });

    it("handles function calls with parentheses touching keyword", () => {
      // "for(" should still be recognized as "for" keyword
      const lines = ["for(x in y):", "if(cond):", "while(True):"];
      const signal = computeSignal(lines, pyLang);
      for (const s of signal) {
        expect(s).toBeGreaterThanOrEqual(0.3);
      }
    });
  });

  describe("TypeScript", () => {
    it("returns zero for blank lines and comments", () => {
      const lines = [
        "",
        "  ",
        "// this is a comment",
        "   // indented comment",
      ];
      const signal = computeSignal(lines, tsLang);
      expect(signal).toEqual([0, 0, 0, 0]);
    });

    it("returns zero for block comments", () => {
      const lines = [
        "/* block comment */",
        "/* start",
        "middle",
        "end */",
        "const x = 1;",
      ];
      const signal = computeSignal(lines, tsLang);
      expect(signal[0]).toBe(0);
      expect(signal[1]).toBe(0);
      expect(signal[2]).toBe(0);
      expect(signal[3]).toBe(0);
      expect(signal[4]).toBeGreaterThan(0);
    });

    it("detects class, function, interface, enum as high-signal lines", () => {
      const lines = [
        "import { readFile } from 'fs';",
        "",
        "export class Service {",
        "  constructor(private config: Config) {}",
        "",
        "  public async process(data: unknown): Promise<Result> {",
        "    const result = await this.transform(data);",
        "    return result;",
        "  }",
        "}",
        "",
        "export interface Config {",
        "  host: string;",
        "}",
        "",
        "export enum Status {",
        "  Active,",
        "  Inactive,",
        "}",
      ];
      const signal = computeSignal(lines, tsLang);

      // import
      expect(signal[0]).toBeGreaterThan(0.5);

      // export class — has "export" + "class" => 0.6 + 1.0 = 1.6
      expect(signal[2]).toBeGreaterThanOrEqual(1.0);

      // method — "public async" => 0.3 + 0.3 + indent
      expect(signal[5]).toBeGreaterThan(0.5);

      // export interface — "export" + "interface" => 0.6 + 0.9 = 1.5
      expect(signal[11]).toBeGreaterThanOrEqual(0.9);

      // export enum — "export" + "enum" => 0.6 + 0.8 = 1.4
      expect(signal[15]).toBeGreaterThanOrEqual(0.8);
    });

    it("handles keyword-adjacent punctuation (function(, class{, if()", () => {
      const lines = [
        "export function foo(",
        "export class Bar{",
        "if(!ready)",
        "for(let x=0; x<10; x++)",
      ];
      const signal = computeSignal(lines, tsLang);
      // export + function should be ~1.5
      expect(signal[0]).toBeGreaterThanOrEqual(1.0);
      // export + class should be ~1.6
      expect(signal[1]).toBeGreaterThanOrEqual(1.0);
      // if should be ~0.3
      expect(signal[2]).toBeGreaterThan(0.2);
      // for should be ~0.3
      expect(signal[3]).toBeGreaterThan(0.2);
    });
  });

  describe("Go", () => {
    it("detects func keyword", () => {
      const lines = ["func main() {", "  fmt.Println(\"hello\")", "}"];
      const signal = computeSignal(lines, goLang);
      expect(signal[0]).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe("signal range", () => {
    it("all signals are within [0, 2]", () => {
      const lines: string[] = [];
      for (let i = 0; i < 100; i++) {
        lines.push(`${"    ".repeat(30)}class Foo:`);
      }
      const signal = computeSignal(lines, pyLang);
      for (const s of signal) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(2.0);
      }
    });
  });
});
