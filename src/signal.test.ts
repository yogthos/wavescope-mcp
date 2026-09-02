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
      const lines = ["x = obj.class"];
      const signal = computeSignal(lines, pyLang);
      expect(signal[0]).toBe(0);
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
