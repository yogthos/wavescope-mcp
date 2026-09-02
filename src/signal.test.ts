import { describe, it, expect } from "vitest";
import { computeSignal } from "./signal.js";
import { detectLanguage, configs } from "./language.js";

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
      // Methods sit one level in, so they attenuate below a top-level def
      // while staying far above the surrounding statement lines.
      expect(signal[3]).toBeGreaterThan(0.8);
      expect(signal[3]).toBeLessThan(signal[2]);
      expect(signal[4]).toBeLessThan(0.5);
      expect(signal[5]).toBeGreaterThan(0.8);
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

    it("indentation attenuates signal proportionally", () => {
      // Was asserted the other way round. Additive indent let a line with
      // no structural content outscore a real declaration; nesting depth
      // now scales the score down instead.
      const lines = [
        "pass",
        "    pass",
        "        pass",
        "            pass",
      ];
      const signal = computeSignal(lines, pyLang);
      expect(signal[0]).toBeGreaterThan(signal[1]);
      expect(signal[1]).toBeGreaterThan(signal[2]);
      expect(signal[2]).toBeGreaterThan(signal[3]);
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

  describe("string-literal awareness", () => {
    it("does not enter block-comment state from /* inside a TS string", () => {
      const lines = [
        'const s = "/* not a real comment */";',
        "const x = 1;",
      ];
      const signal = computeSignal(lines, tsLang);
      expect(signal[1]).toBeGreaterThan(0);
    });

    it("does not strip code at // inside a URL string", () => {
      const lines = [
        'export const url = "https://example.com";',
      ];
      const signal = computeSignal(lines, tsLang);
      expect(signal[0]).toBeGreaterThan(0.5);
    });

    it("does not enter block-comment state from /* inside a template literal", () => {
      const lines = [
        "const t = `/* nope */`;",
        "function next() {}",
      ];
      const signal = computeSignal(lines, tsLang);
      expect(signal[1]).toBeGreaterThan(0.5);
    });
  });

  describe("tab indentation", () => {
    it("expands tabs as 4 spaces for indent scoring (Go)", () => {
      const tabLines = ["\t\tfmt.Println(\"x\")"];
      const spaceLines = ["        fmt.Println(\"x\")"];
      const tabSignal = computeSignal(tabLines, goLang);
      const spaceSignal = computeSignal(spaceLines, goLang);
      expect(tabSignal[0]).toBeCloseTo(spaceSignal[0], 5);
    });
  });

  describe("member-access keyword leak", () => {
    it("does not score 'class' when used as Python attribute access", () => {
      // Every line of real code now carries a small base score, so the
      // assertion is that `class` (1.0) was not counted — matching the
      // sibling TS member-access test below.
      const lines = ["x = obj.class"];
      const signal = computeSignal(lines, pyLang);
      expect(signal[0]).toBeLessThan(0.3);
    });

    it("does not score 'def' when used as TS member access", () => {
      const lines = ["return obj.def;"];
      const signal = computeSignal(lines, tsLang);
      expect(signal[0]).toBeLessThan(0.3);
    });
  });

  describe("Python async def", () => {
    it("async def does not exceed class-line signal", () => {
      const classLine = ["class Foo:"];
      const asyncDef = ["async def foo():"];
      const classSig = computeSignal(classLine, pyLang)[0];
      const asyncSig = computeSignal(asyncDef, pyLang)[0];
      expect(asyncSig).toBeLessThanOrEqual(classSig);
    });
  });

  describe("PHP 8 attributes", () => {
    it("does not score #[Route(...)] as a comment", () => {
      const phpLang = detectLanguage("test.php");
      const lines = ["#[Route('/x')]", "function handler() {}"];
      const signal = computeSignal(lines, phpLang);
      expect(signal[0]).toBeGreaterThan(0);
    });

    it("still treats plain # as a comment in PHP", () => {
      const phpLang = detectLanguage("test.php");
      const lines = ["# real comment"];
      const signal = computeSignal(lines, phpLang);
      expect(signal[0]).toBe(0);
    });
  });

  describe("JavaScript as a distinct language", () => {
    it("detectLanguage returns 'javascript' for .js files", () => {
      expect(detectLanguage("foo.js").name).toBe("javascript");
      expect(detectLanguage("foo.jsx").name).toBe("javascript");
      expect(detectLanguage("foo.mjs").name).toBe("javascript");
      expect(detectLanguage("foo.cjs").name).toBe("javascript");
    });

    it("detectLanguage returns 'typescript' for .ts files", () => {
      expect(detectLanguage("foo.ts").name).toBe("typescript");
      expect(detectLanguage("foo.tsx").name).toBe("typescript");
    });

    it("JS config does not have TS-only keywords like interface/type/enum", () => {
      const jsLang = detectLanguage("foo.js");
      expect(jsLang.structuralKeywords.interface).toBeUndefined();
      expect(jsLang.structuralKeywords.enum).toBeUndefined();
    });
  });

  describe("generic config", () => {
    it("does not claim .edn extension", () => {
      const lang = detectLanguage("foo.edn");
      expect(lang.name).not.toBe("generic");
    });

    it("does not treat ';' as comment prefix (PHP-style fall-through)", () => {
      const lang = detectLanguage("foo.unknownext");
      expect(lang.commentPrefixes).not.toContain(";");
      expect(lang.commentPrefixes).not.toContain("//");
    });
  });

  describe("Clojure structural forms", () => {
    it("recognizes defmulti, defonce, letfn, reify, extend-type, extend-protocol", () => {
      const cljLang = detectLanguage("test.clj");
      const lines = [
        "(defmulti area :shape)",
        "(defonce server (start))",
        "(letfn [(helper [x] x)] ...)",
        "(reify Foo (bar [_] 1))",
        "(extend-type String Foo (bar [_] 1))",
        "(extend-protocol Foo String (bar [_] 1))",
      ];
      const signal = computeSignal(lines, cljLang);
      for (const s of signal) {
        expect(s).toBeGreaterThan(0.3);
      }
    });
  });

  describe("Java inline annotations", () => {
    it("scores public @Nullable String foo() as a decorator-bearing line", () => {
      const javaLang = detectLanguage("test.java");
      const withAnnotation = ["public @Nullable String foo() {}"];
      const withoutAnnotation = ["public String foo() {}"];
      const a = computeSignal(withAnnotation, javaLang)[0];
      const b = computeSignal(withoutAnnotation, javaLang)[0];
      expect(a).toBeGreaterThan(b);
    });
  });

  describe("extension detection", () => {
    it("recognizes .pyi as Python", () => {
      expect(detectLanguage("stubs.pyi").name).toBe("python");
    });

    it("recognizes Rakefile and Gemfile as Ruby", () => {
      expect(detectLanguage("Rakefile").name).toBe("ruby");
      expect(detectLanguage("Gemfile").name).toBe("ruby");
    });
  });

  describe("single-quote is not a string delimiter in Rust/Clojure (Round 3)", () => {
    it("does not mask code after a Rust lifetime apostrophe", () => {
      const rustLang = detectLanguage("test.rs");
      // The lifetime `'a` must not swallow the `for` keyword that follows.
      const signal = computeSignal(["impl<'a> Foo for Bar<'a> {"], rustLang);
      // impl (0.9) + for (0.3) survive; with the bug only impl is counted.
      expect(signal[0]).toBeGreaterThanOrEqual(1.0);
    });

    it("does not mask code after a Clojure quote", () => {
      const cljLang = detectLanguage("test.clj");
      // The quote `'[...]` must not swallow the trailing defn form.
      const signal = computeSignal(
        ["(def things '[a b c]) (defn realfn [] 1)"],
        cljLang,
      );
      // def (0.7) + defn (0.9) survive; with the bug only def is counted.
      expect(signal[0]).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe("Object.prototype key collisions", () => {
    it("does not produce NaN for tokens that name inherited Object keys", () => {
      // `constructor`, `toString`, `hasOwnProperty`, `valueOf` are inherited
      // properties on a plain object, so a naive `keywords[token] !== undefined`
      // lookup resolves them to functions and poisons the score with NaN.
      const lines = [
        "  constructor(filename: string, content: string) {",
        "  toString() {",
        "  hasOwnProperty(k: string) {",
        "  valueOf() {",
      ];
      const signal = computeSignal(lines, tsLang);
      for (const s of signal) {
        expect(Number.isNaN(s)).toBe(false);
        expect(Number.isFinite(s)).toBe(true);
      }
    });
  });
});

describe("block comment / docstring terminators are not hidden by string masking", () => {
  const tsLang = detectLanguage("test.ts");
  const pyLang = detectLanguage("test.py");

  it("closes a single-line block comment containing an apostrophe (TS)", () => {
    const lines = [
      "/** Returns the user's name */",
      "export class Foo {}",
      "function bar() {}",
    ];
    const signal = computeSignal(lines, tsLang);
    expect(signal[0]).toBe(0);
    expect(signal[1]).toBeGreaterThanOrEqual(1.0);
    expect(signal[2]).toBeGreaterThanOrEqual(0.9);
  });

  it("closes an inline block comment containing an apostrophe (TS)", () => {
    const lines = ["foo(); /* it's */ bar();", "export class Foo {}"];
    const signal = computeSignal(lines, tsLang);
    expect(signal[1]).toBeGreaterThanOrEqual(1.0);
  });

  it("closes a multi-line block comment whose last line has an apostrophe (TS)", () => {
    const lines = ["/*", " * don't */", "export class Foo {}"];
    const signal = computeSignal(lines, tsLang);
    expect(signal[0]).toBe(0);
    expect(signal[1]).toBe(0);
    expect(signal[2]).toBeGreaterThanOrEqual(1.0);
  });

  it("closes a multi-line docstring whose last line has an apostrophe (Python)", () => {
    const lines = [
      "def f():",
      '    """',
      "    Don't.\"\"\"",
      "    return 1",
      "class X: pass",
    ];
    const signal = computeSignal(lines, pyLang);
    expect(signal[1]).toBe(0);
    expect(signal[2]).toBe(0);
    expect(signal[3]).toBeGreaterThan(0);
    expect(signal[4]).toBeGreaterThanOrEqual(1.0);
  });

  it("still scores code after the closing delimiter on the same line", () => {
    const lines = ["/* it's */ export class Foo {}"];
    const signal = computeSignal(lines, tsLang);
    expect(signal[0]).toBeGreaterThanOrEqual(1.0);
  });
});

describe("inline comment stripping picks the earliest prefix", () => {
  it("does not score keywords inside a PHP # comment that also contains //", () => {
    const phpLang = detectLanguage("test.php");
    const signal = computeSignal(["$x = 1; # class // foo"], phpLang);
    expect(signal[0]).toBeLessThan(0.5);
  });
});

describe("Clojure reader syntax", () => {
  const cljLang = detectLanguage("test.clj");

  it("does not treat syntax-quote backtick as a string delimiter", () => {
    const signal = computeSignal(
      ["(defmacro m [x] `(let [y# ~x] (defn z [] y#)))"],
      cljLang,
    );
    // defmacro (0.9) + let (0.2) + defn (0.9) → capped at 2.0
    expect(signal[0]).toBeGreaterThanOrEqual(1.5);
  });

  it("does not open a string at the \\\" character literal", () => {
    const signal = computeSignal(
      ['(defn f [] (str \\" (defn g [] 1)))'],
      cljLang,
    );
    expect(signal[0]).toBeGreaterThanOrEqual(1.5);
  });

  it("does not start a comment at the \\; character literal", () => {
    const signal = computeSignal(["(def sep \\;) (defn g [] 1)"], cljLang);
    expect(signal[0]).toBeGreaterThanOrEqual(1.5);
  });

  it("does not treat (commentary ...) as a (comment ...) form", () => {
    const signal = computeSignal(["(commentary 1)", "(defn foo [] 1)"], cljLang);
    expect(signal[1]).toBeGreaterThanOrEqual(0.9);
  });

  it("ignores \\( and \\) character literals when tracking (comment ...) depth", () => {
    const lines = ["(comment (str \\())", "(defn foo [] 1)"];
    const signal = computeSignal(lines, cljLang);
    expect(signal[0]).toBe(0);
    expect(signal[1]).toBeGreaterThanOrEqual(0.9);
  });
});

describe("Scheme", () => {
  const scm = detectLanguage("test.scm");

  it("is detected from Scheme and Racket extensions", () => {
    for (const ext of [".scm", ".ss", ".sld", ".sls", ".sps", ".rkt"]) {
      expect(detectLanguage(`foo${ext}`).name).toBe("scheme");
    }
  });

  it("scores definition forms highly", () => {
    const lines = [
      "(define (square x) (* x x))",
      "(define-syntax swap! (syntax-rules () ((_ a b) (let ((tmp a)) (set! a b) (set! b tmp)))))",
      "(define-record-type point (make-point x y) point? (x point-x) (y point-y))",
      "(define-values (q r) (floor/ 7 2))",
      "(struct posn (x y))",
      "(define-library (my lib) (export f) (import (scheme base)))",
    ];
    const signal = computeSignal(lines, scm);
    for (const s of signal) expect(s).toBeGreaterThanOrEqual(0.7);
  });

  it("treats ; as a line comment and #| |# as a block comment", () => {
    const lines = [
      "; a comment",
      "#| block",
      "   comment |#",
      "(define x 1)",
    ];
    const signal = computeSignal(lines, scm);
    expect(signal[0]).toBe(0);
    expect(signal[1]).toBe(0);
    expect(signal[2]).toBe(0);
    expect(signal[3]).toBeGreaterThanOrEqual(0.9);
  });

  it("handles nested #| |# block comments", () => {
    const lines = [
      "#| outer #| inner |# still comment",
      "(define hidden 1) |#",
      "(define visible 1)",
    ];
    const signal = computeSignal(lines, scm);
    expect(signal[0]).toBe(0);
    expect(signal[1]).toBe(0);
    expect(signal[2]).toBeGreaterThanOrEqual(0.9);
  });

  it("does not treat quote or quasiquote as string delimiters", () => {
    const signal = computeSignal(
      ["(define xs '(a b)) (define ys `(c ,d)) (define z 1)"],
      scm,
    );
    // three defines → 2.7, capped at 2.0
    expect(signal[0]).toBe(2.0);
  });

  it("does not open a string at the #\\\" character literal", () => {
    const signal = computeSignal(['(define q #\\") (define z 1)'], scm);
    expect(signal[0]).toBeGreaterThanOrEqual(1.8);
  });

  it("scores #lang as a module header", () => {
    const signal = computeSignal(["#lang racket"], scm);
    expect(signal[0]).toBeGreaterThan(0.3);
  });
});

describe("Common Lisp", () => {
  const lisp = detectLanguage("test.lisp");

  it("is detected from Common Lisp extensions", () => {
    for (const ext of [".lisp", ".lsp", ".cl", ".asd"]) {
      expect(detectLanguage(`foo${ext}`).name).toBe("lisp");
    }
  });

  it("scores definition forms highly", () => {
    const lines = [
      "(defun square (x) (* x x))",
      "(defmacro with-foo (&body body) `(progn ,@body))",
      "(defclass point () ((x :accessor point-x) (y :accessor point-y)))",
      "(defstruct node value next)",
      "(defgeneric area (shape))",
      "(defmethod area ((c circle)) (* pi (circle-r c) (circle-r c)))",
      "(defpackage :my-app (:use :cl))",
      "(defvar *counter* 0)",
      "(define-condition my-error (error) ())",
    ];
    const signal = computeSignal(lines, lisp);
    for (const s of signal) expect(s).toBeGreaterThanOrEqual(0.6);
  });

  it("treats ; as a line comment and #| |# as a nested block comment", () => {
    const lines = [
      ";;; header",
      "#| outer #| inner |# tail",
      "(defun hidden () 1) |#",
      "(defun visible () 1)",
    ];
    const signal = computeSignal(lines, lisp);
    expect(signal[0]).toBe(0);
    expect(signal[1]).toBe(0);
    expect(signal[2]).toBe(0);
    expect(signal[3]).toBeGreaterThanOrEqual(0.9);
  });

  it("does not treat quote as a string delimiter", () => {
    const signal = computeSignal(["(defvar *xs* '(a b)) (defun f () 1)"], lisp);
    // defvar (0.7) + defun (0.9)
    expect(signal[0]).toBeGreaterThanOrEqual(1.5);
  });
});

describe("Emacs Lisp", () => {
  const el = detectLanguage("init.el");

  it("is detected from .el", () => {
    expect(el.name).toBe("elisp");
  });

  it("scores definition forms highly", () => {
    const lines = [
      "(defun my-fn () (interactive) 1)",
      "(defcustom my-opt nil \"doc\" :type 'boolean)",
      "(defvar my-var 1)",
      "(define-minor-mode my-mode \"doc\" :lighter \" M\")",
      "(use-package magit :ensure t)",
      "(cl-defun my-cl-fn (&key a) a)",
    ];
    const signal = computeSignal(lines, el);
    for (const s of signal) expect(s).toBeGreaterThanOrEqual(0.7);
  });

  it("does not open a string at the ?\\\" character literal", () => {
    const signal = computeSignal(['(defconst q ?\\") (defun z () 1)'], el);
    expect(signal[0]).toBeGreaterThanOrEqual(1.5);
  });
});

describe("block comment opener inside a line comment", () => {
  it("does not open a block comment from /* inside a // comment (TS)", () => {
    const tsLang = detectLanguage("test.ts");
    const lines = ["foo(); // see /* this", "export class Foo {}"];
    const signal = computeSignal(lines, tsLang);
    expect(signal[1]).toBeGreaterThanOrEqual(1.0);
  });

  it("does not open a docstring from triple quotes inside a # comment (Python)", () => {
    const pyLang = detectLanguage("test.py");
    const lines = ['x = 1  # """', "class Foo: pass"];
    const signal = computeSignal(lines, pyLang);
    expect(signal[1]).toBeGreaterThanOrEqual(1.0);
  });
});

describe("indentation attenuates structural score, it does not create it", () => {
  const LANGS = ["a.ts", "a.py", "a.go", "a.rs", "a.java", "a.rb", "a.clj", "a.scm", "a.lisp"];

  it("a keyword-free line never outscores a top-level declaration, at any depth", () => {
    // Pre-fix, TypeScript scored a bare `zzz;` at 8 levels of indent as 1.20
    // — above `class` (1.0) and above a real `class AbortError ... {` line.
    for (const name of LANGS) {
      const lang = detectLanguage(name);
      const maxKeyword = Math.max(...Object.values(lang.structuralKeywords));
      const topDecl = maxKeyword;
      for (const depth of [1, 2, 4, 6, 8, 16]) {
        const filler = " ".repeat(depth * 4) + "zzz;";
        const score = computeSignal([filler], lang)[0];
        expect(score, `${lang.name} at depth ${depth}`).toBeLessThan(topDecl);
      }
    }
  });

  it("a keyword-free line stays well below the weakest structural keyword", () => {
    for (const name of LANGS) {
      const lang = detectLanguage(name);
      const minKeyword = Math.min(...Object.values(lang.structuralKeywords));
      const deep = computeSignal([" ".repeat(64) + "zzz;"], lang)[0];
      expect(deep, lang.name).toBeLessThan(minKeyword);
    }
  });

  it("the same declaration scores lower as nesting deepens", () => {
    const ts = detectLanguage("a.ts");
    const scores = [0, 1, 2, 4, 8].map(
      (d) => computeSignal([" ".repeat(d * 4) + "class Foo {"], ts)[0],
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
    // Attenuation is gradual — a deeply nested class is still a declaration.
    expect(scores[scores.length - 1]).toBeGreaterThan(scores[0] * 0.3);
  });

  it("a nested declaration still outranks a shallower non-declaration", () => {
    const ts = detectLanguage("a.ts");
    const nestedDecl = computeSignal(["        class Foo {"], ts)[0];
    const shallowFiller = computeSignal(["    zzz;"], ts)[0];
    expect(nestedDecl).toBeGreaterThan(shallowFiller);
  });

  it("blank and comment lines remain exactly zero", () => {
    for (const name of LANGS) {
      const lang = detectLanguage(name);
      const prefix = lang.commentPrefixes[0];
      const signal = computeSignal(
        ["", "      ", `${prefix} c`, `        ${prefix} c`],
        lang,
      );
      expect(signal, lang.name).toEqual([0, 0, 0, 0]);
    }
  });

  it("the keyword-less generic config still produces a non-zero code signal", () => {
    const generic = detectLanguage("a.unknownext");
    expect(generic.name).toBe("generic");
    const signal = computeSignal(["alpha beta", "    gamma delta"], generic);
    for (const s of signal) expect(s).toBeGreaterThan(0);
  });
});

describe("peaks anchor on declarations, not nested statement bodies", () => {
  it("ranks a top-level declaration above a deeply nested statement plateau", () => {
    const ts = detectLanguage("a.ts");
    // Mirrors the real shape in project.ts: a small declaration followed by
    // a long, deeply indented plateau of ordinary statements.
    const lines = ["export class Registry {"];
    for (let i = 0; i < 30; i++) lines.push("          results.push(item);");
    const signal = computeSignal(lines, ts);
    for (let i = 1; i < signal.length; i++) {
      expect(signal[i]).toBeLessThan(signal[0]);
    }
  });
});

describe("docstring bodies are prose, not code", () => {
  const py = detectLanguage("a.py");

  it("does not score keywords inside a single-line docstring", () => {
    // Pre-fix these scored 1.10 and 2.00 — a prose line ranking at or above
    // a real `class Foo:` declaration.
    expect(computeSignal(['"""Returns a class"""'], py)[0]).toBe(0);
    expect(
      computeSignal(['"""Handle the class registry for each def"""'], py)[0],
    ).toBe(0);
  });

  it("does not score keywords inside a multi-line docstring body", () => {
    const lines = ['"""', "Handle the class registry.", "Each def is stored.", '"""'];
    expect(computeSignal(lines, py)).toEqual([0, 0, 0, 0]);
  });

  it("still scores real code that follows a closing docstring on the same line", () => {
    const signal = computeSignal(['"""doc""" class Foo:'], py);
    expect(signal[0]).toBeGreaterThanOrEqual(1.0);
  });

  it("still scores real code that precedes an opening docstring", () => {
    const signal = computeSignal(['class Foo: """doc'], py);
    expect(signal[0]).toBeGreaterThanOrEqual(1.0);
  });
});

describe("syntactic declaration detection for brace languages", () => {
  const ts = detectLanguage("a.ts");
  const js = detectLanguage("a.js");
  const java = detectLanguage("a.java");
  const generic = detectLanguage("a.cs");

  const score = (line: string, lang = ts) => computeSignal([line], lang)[0];

  describe("recognises declarations that carry no definition keyword", () => {
    const DECLARATIONS: [string, ReturnType<typeof detectLanguage>][] = [
      ["  add(item: string): void {", ts],
      ["  async process(data) {", ts],
      ["  get value() {", ts],
      ["  set value(v) {", ts],
      ["  constructor(private config: Config) {}", ts],
      ["  private helper(x: number): string {", ts],
      ["  static create(): Foo {", ts],
      ["  handle(req, res) {", js],
      ["    public List<String> scan() {", java],
      ["    void helper() {", java],
      ["    public Repo() {", java],
      ["    protected <T> T map(T in) throws IOException {", java],
      ["    public void Run() {", generic],
    ];

    for (const [line, lang] of DECLARATIONS) {
      it(`scores as a declaration: ${line.trim()}`, () => {
        // Pre-fix a keyword-less method scored 0.047 — below a plain field.
        expect(score(line, lang)).toBeGreaterThan(0.6);
      });
    }

    it("ranks a method above a field in the same class", () => {
      expect(score("  add(item: string): void {")).toBeGreaterThan(
        score("  private items: string[] = [];"),
      );
      expect(score("    void helper() {", java)).toBeGreaterThan(
        score("    private String root;", java),
      );
    });

    it("recognises an abstract or interface method ending in a semicolon", () => {
      expect(score("    void scan();", java)).toBeGreaterThan(0.6);
      expect(score("  abstract render(): void;", ts)).toBeGreaterThan(0.6);
    });

    it("recognises a signature whose parameter list opens on the next line", () => {
      expect(score("  public static void main(", java)).toBeGreaterThan(0.6);
    });
  });

  describe("does not mistake calls and control flow for declarations", () => {
    const NOT_DECLARATIONS = [
      "    this.items.push(item);",
      "    results.push({",
      "    console.log('processing');",
      "    if (f == null) {",
      "    for (const f of files) {",
      "    while (cursor < pending.length) {",
      "    switch (kind) {",
      "    } catch (e) {",
      "    } else if (ready) {",
      "    do {",
      "    return compute(a);",
      "    throw new Error('x');",
      "    doThing();",
      "    super(a, b);",
      "    const x = compute(a, b);",
      "    this.value = make(a);",
      "    describe('a group', () => {",
      "    it('does a thing', async () => {",
      "    useEffect(() => {",
      "    new Thread(() -> {",
      "    }).then(() => {",
      "    await load(path);",
    ];

    for (const line of NOT_DECLARATIONS) {
      it(`is not a declaration: ${line.trim()}`, () => {
        expect(score(line)).toBeLessThan(0.6);
      });
    }
  });

  it("does not fire on a callback nested inside an argument list", () => {
    // Tested in Java, where `function` is not a keyword, so the score
    // reflects the syntactic detector alone. In TS/JS the same line is
    // scored by the `function` keyword, which is correct on its own terms.
    expect(score("    register(handle(a, b) {", java)).toBeLessThan(0.3);
    expect(score("    schedule(task(a) {", java)).toBeLessThan(0.3);
  });

  describe("does not inflate lines that already declare via a keyword", () => {
    it("leaves a top-level function at its keyword score", () => {
      const withKeyword = score("export function foo() {");
      const bare = score("function foo() {");
      expect(withKeyword).toBeGreaterThan(bare);
      // 0.6 export + 0.9 function + 0.05 base, not stacked with a bonus
      expect(withKeyword).toBeCloseTo(1.55, 2);
      expect(bare).toBeCloseTo(0.95, 2);
    });

    it("leaves languages with a definition keyword untouched", () => {
      const py = detectLanguage("a.py");
      const go = detectLanguage("a.go");
      const clj = detectLanguage("a.clj");
      expect(computeSignal(["def foo():"], py)[0]).toBeCloseTo(0.95, 2);
      expect(computeSignal(["func main() {"], go)[0]).toBeCloseTo(0.95, 2);
      expect(computeSignal(["(defn foo [] 1)"], clj)[0]).toBeCloseTo(0.95, 2);
    });
  });

  describe("does not fire inside comments or strings", () => {
    it("ignores a declaration written inside a comment", () => {
      expect(computeSignal(["// void scan() {"], ts)[0]).toBe(0);
      expect(computeSignal(["/* void scan() { */"], ts)[0]).toBe(0);
    });

    it("ignores a declaration written inside a string", () => {
      expect(score('  const s = "void scan() {";')).toBeLessThan(0.6);
    });
  });
});

describe("configs only score keywords their language actually has", () => {
  // The shared cLike/tsLike bases were spread wholesale into languages that
  // lack many of those keywords, so an ordinary identifier scored as
  // structure: Go rated `class` at 1.0, its highest weight, for a language
  // with no classes, and Java rated `function` at 0.9.
  const ALIEN: Record<string, string[]> = {
    go: ["class", "export", "let", "async", "try", "catch", "finally", "while", "throw", "do"],
    rust: ["class", "export"],
    java: ["function", "let", "async", "export", "type"],
    php: ["let", "async", "export"],
    swift: ["export", "finally"],
    kotlin: ["export", "switch", "case", "default", "static"],
    scala: ["let", "async", "switch", "default", "static", "public"],
  };

  for (const [langName, alien] of Object.entries(ALIEN)) {
    const cfg = configs.find((c) => c.name === langName)!;
    it(`${langName} does not define keywords it lacks`, () => {
      for (const word of alien) {
        expect(Object.hasOwn(cfg.structuralKeywords, word), `${langName}.${word}`)
          .toBe(false);
      }
    });

    it(`${langName} scores those words as ordinary identifiers`, () => {
      for (const word of alien) {
        const score = computeSignal([`${word} = 1`], cfg)[0];
        expect(score, `${langName}: ${word}`).toBeLessThan(0.3);
      }
    });
  }

  it("Go still scores its own keywords, including type and interface", () => {
    const go = configs.find((c) => c.name === "go")!;
    for (const [line, min] of [
      ["type Repo struct {", 1.0],
      ["type Scanner interface {", 1.0],
      ["func main() {", 0.9],
      ["package main", 0.3],
      ["for i := range xs {", 0.3],
    ] as const) {
      expect(computeSignal([line], go)[0], line).toBeGreaterThanOrEqual(min);
    }
  });

  it("keeps the keywords each language really has", () => {
    const has = (name: string, words: string[]) => {
      const cfg = configs.find((c) => c.name === name)!;
      for (const w of words) {
        expect(Object.hasOwn(cfg.structuralKeywords, w), `${name}.${w}`).toBe(true);
      }
    };
    has("java", ["class", "interface", "enum", "package", "extends", "implements", "try", "catch"]);
    has("go", ["func", "struct", "package", "import", "defer", "go"]);
    has("rust", ["fn", "impl", "trait", "struct", "enum", "mod", "use"]);
    has("php", ["function", "class", "interface", "trait", "namespace"]);
    has("swift", ["func", "protocol", "extension", "struct", "class"]);
    has("kotlin", ["fun", "class", "object", "val", "suspend"]);
    has("scala", ["def", "trait", "object", "val", "case"]);
  });
});
