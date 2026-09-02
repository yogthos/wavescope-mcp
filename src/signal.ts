import { LanguageConfig } from "./language.js";

const DEFAULT_STRING_DELIMITERS = ['"', "'", "`"];

/**
 * Floor score for any line of real code, before indent attenuation. Keeps
 * the keyword-less generic config (unknown file extensions) producing a
 * usable signal that still separates code from blank and comment lines.
 */
const CODE_LINE_BASE = 0.05;

/** Indent depth, in 4-space levels, beyond which attenuation stops growing. */
const MAX_INDENT_DEPTH = 8;

/**
 * Words that introduce a parenthesised clause that is not a declaration.
 * `if (...)`, `catch (...)`, `return f(...)`, `new Foo(...)` and friends all
 * look like `name(` without declaring anything.
 */
const NON_DECLARING_HEADS = new Set([
  "if", "else", "for", "while", "switch", "catch", "do", "try", "finally",
  "with", "return", "new", "throw", "case", "default", "await", "yield",
  "typeof", "instanceof", "delete", "in", "of", "assert", "match", "using",
  "lock", "when", "where", "sizeof", "alignof", "super", "this",
]);

/**
 * Recognise a function or method declaration that carries no definition
 * keyword. Java, C#, C and C++ have no such keyword at all, and a
 * TypeScript or JavaScript class method does not need one either, so
 * keyword scoring alone rated `add(item: string): void {` at 0.047 —
 * below a plain field — and made methods invisible in those languages.
 *
 * `code` must already have string literals masked and comments stripped,
 * so a declaration written inside a comment or a string cannot match.
 *
 * The shape sought is `name(params)` with an optional return type or
 * `throws` clause, terminated by `{` (a body), `;` (abstract or interface),
 * or `(` (a signature continuing on the next line). Everything that merely
 * resembles it — calls, control flow, callbacks — is excluded by four
 * rules: the name may not follow a `.`, the name itself may not be a
 * non-declaring head, no non-declaring head or `=` may precede it, and the
 * parameter list must close on the same line, which is what separates
 * `add(item) {` from `describe("x", () => {`.
 */
function isCallableDeclaration(code: string): boolean {
  if (!code) return false;

  // `foo() {}` — an empty body still terminates the signature at the brace.
  let text = code.endsWith("{}") ? code.slice(0, -1) : code;
  const last = text[text.length - 1];
  const terminator =
    last === "{" ? "brace" : last === ";" ? "semi" : last === "(" ? "open" : null;
  if (terminator === null) return false;

  // First `name(` whose name is a standalone token, not a member access.
  const re = /([A-Za-z_$][\w$]*)\s*\(/g;
  let name = "";
  let nameStart = -1;
  let parenIdx = -1;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const prev = m.index > 0 ? text[m.index - 1] : "";
    if (prev === "." || /[\w$]/.test(prev)) continue;
    name = m[1];
    nameStart = m.index;
    parenIdx = m.index + m[0].length - 1;
    break;
  }
  if (nameStart === -1 || NON_DECLARING_HEADS.has(name)) return false;

  // `x = make(a)`, `return f(a)`, `new Foo(a)` — the head is not a declaration.
  const before = text.slice(0, nameStart);
  if (before.includes("=")) return false;
  for (const token of before.split(/[^\w$]+/)) {
    if (token && NON_DECLARING_HEADS.has(token)) return false;
  }
  // An unclosed paren ahead of the name means this sits inside someone
  // else's argument list — `arr.map(function (x) {` declares a callback,
  // not a member of the enclosing structure.
  let openBefore = 0;
  for (const ch of before) {
    if (ch === "(") openBefore++;
    else if (ch === ")") openBefore--;
  }
  if (openBefore > 0) return false;
  const hasLeadingToken = before.trim().length > 0;

  // A signature continued on the next line is ambiguous with a bare call,
  // so require a modifier or return type ahead of the name.
  if (terminator === "open") return hasLeadingToken;

  let depth = 0;
  let closeIdx = -1;
  for (let i = parenIdx; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) {
      closeIdx = i;
      break;
    }
  }
  // Unclosed parameters mean the `{` belongs to a callback argument.
  if (closeIdx === -1) return false;

  // Between `)` and the terminator only a return type or throws clause may
  // appear — no further call, arrow, or assignment.
  const tail = text.slice(closeIdx + 1, text.length - 1);
  if (!/^[\w\s,<>[\].:?&|*~-]*$/.test(tail)) return false;

  // `doThing();` is a call; `void scan();` is a declaration.
  return terminator === "brace" ? true : hasLeadingToken;
}

/**
 * Mask the interior of single-line string and char literals with spaces
 * so that downstream comment / token detection ignores their contents.
 * Which characters delimit a string comes from `lang.stringDelimiters`
 * (default: double-quote, single-quote, backtick). Backslash escapes are
 * honoured inside strings; with `lang.backslashCharLiterals` a backslash
 * *outside* a string also blanks itself and the next character so Lisp
 * char literals (`\"`, `#\(`, `?\;`) can't open a phantom string or
 * comment. Multi-line strings are out of scope — caller passes a single
 * physical line.
 */
function maskStringLiterals(line: string, lang: LanguageConfig): string {
  const delims = lang.stringDelimiters ?? DEFAULT_STRING_DELIMITERS;
  const chars = line.split("");
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (lang.backslashCharLiterals && c === "\\") {
      chars[i] = " ";
      if (i + 1 < chars.length) chars[i + 1] = " ";
      i += 2;
      continue;
    }
    if (delims.includes(c)) {
      const quote = c;
      let j = i + 1;
      while (j < chars.length) {
        if (chars[j] === "\\" && j + 1 < chars.length) {
          chars[j] = " ";
          chars[j + 1] = " ";
          j += 2;
          continue;
        }
        if (chars[j] === quote) break;
        chars[j] = " ";
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return chars.join("");
}

/**
 * Index of the earliest single-line comment prefix in an already
 * string-masked line, or -1. PHP 8 attributes (`#[...]`) are not comments.
 */
function findLineCommentStart(masked: string, lang: LanguageConfig): number {
  let best = -1;
  for (const prefix of lang.commentPrefixes) {
    let from = 0;
    while (from < masked.length) {
      const idx = masked.indexOf(prefix, from);
      if (idx === -1) break;
      if (prefix === "#" && masked[idx + 1] === "[") {
        from = idx + 1;
        continue;
      }
      if (best === -1 || idx < best) best = idx;
      break;
    }
  }
  return best;
}

/**
 * Index of a block comment opener in an already string-masked line, or -1.
 * For paren-depth languages the opener (`(comment`) must be a whole symbol
 * so `(commentary ...)` is not mistaken for a comment form.
 */
function findBlockCommentStart(masked: string, lang: LanguageConfig): number {
  const start = lang.blockCommentStart;
  if (lang.blockCommentAtLineStart) {
    return masked.startsWith(start) ? 0 : -1;
  }
  let from = 0;
  while (from <= masked.length - start.length) {
    const idx = masked.indexOf(start, from);
    if (idx === -1) return -1;
    if (!lang.blockCommentUsesParenDepth) return idx;
    const next = masked[idx + start.length];
    if (next === undefined || /[\s)\]}]/.test(next)) return idx;
    from = idx + 1;
  }
  return -1;
}

/** Tokens that raise / lower block-comment depth for this language. */
function blockCommentTokens(lang: LanguageConfig): { open: string | null; close: string } {
  if (lang.blockCommentUsesParenDepth) return { open: "(", close: ")" };
  if (lang.blockCommentNests) return { open: lang.blockCommentStart, close: lang.blockCommentEnd };
  return { open: null, close: lang.blockCommentEnd };
}

/**
 * Scan `text` for the close token that brings an already-open block
 * comment from `depth` down to 0. `open` (when non-null) re-raises depth
 * for nested comments. Returns the index of that close token, or -1 and
 * the depth carried over to the next line.
 */
function scanBlockCommentClose(
  text: string,
  open: string | null,
  close: string,
  depth: number,
): { closeIdx: number; depth: number } {
  let i = 0;
  while (i < text.length) {
    if (open !== null && text.startsWith(open, i)) {
      depth++;
      i += open.length;
      continue;
    }
    if (text.startsWith(close, i)) {
      depth--;
      if (depth === 0) return { closeIdx: i, depth: 0 };
      i += close.length;
      continue;
    }
    i++;
  }
  return { closeIdx: -1, depth };
}

/**
 * NOTE: callers must pass a complete file (all lines), not a slice.
 * `inBlockComment` / `inDocString` state spans lines but is initialized
 * fresh per call, so a partial file would yield incorrect comment
 * classification.
 */
export function computeSignal(
  lines: string[],
  lang: LanguageConfig,
): number[] {
  const signal: number[] = new Array(lines.length);
  const { open: bcOpen, close: bcClose } = blockCommentTokens(lang);
  let inBlockComment = false;
  let blockCommentDepth = 0;
  let inDocString = false;
  let docStringDelim: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    const indent = raw.length - trimmed.length;
    const stripped = trimmed.trimEnd();
    // String-masked version used for comment/keyword detection; original
    // line drives indent/length calculations.
    const masked = maskStringLiterals(stripped, lang);

    // ── Handle multiline comments / docstrings (continued from previous line) ──
    if (inBlockComment) {
      // Comment text is not code, so search the raw line for the close
      // token — an apostrophe in "don't */" must not mask the terminator.
      // Clojure (comment ...) bodies *are* code, so keep string masking
      // there so parens inside string literals don't skew the depth.
      const text = lang.blockCommentUsesParenDepth ? masked : stripped;
      const { closeIdx, depth } = scanBlockCommentClose(
        text, bcOpen, bcClose, blockCommentDepth,
      );
      if (closeIdx !== -1) {
        inBlockComment = false;
        blockCommentDepth = 0;
        const after = stripped.slice(closeIdx + bcClose.length).trim();
        signal[i] = after ? scoreLine(raw, after, indent, lang) : 0;
      } else {
        blockCommentDepth = depth;
        signal[i] = 0;
      }
      continue;
    }

    if (inDocString) {
      const endIdx = stripped.indexOf(docStringDelim!);
      if (endIdx !== -1) {
        inDocString = false;
        const after = stripped.slice(endIdx + docStringDelim!.length).trim();
        docStringDelim = null;
        signal[i] = after ? scoreLine(raw, after, indent, lang) : 0;
      } else {
        signal[i] = 0;
      }
      continue;
    }

    const lcIdx = findLineCommentStart(masked, lang);

    // ── Detect new Python docstrings (triple quotes) ──
    // Python's triple quotes are scanned on the unmasked stripped line
    // because maskStringLiterals would have consumed them as regular
    // strings — but only up to any line comment, so `x = 1  # """` doesn't
    // open a docstring.
    if (lang.name === "python") {
      const codePart = lcIdx === -1 ? stripped : stripped.slice(0, lcIdx);
      const dqIdx = Math.min(
        codePart.indexOf('"""') === -1 ? Infinity : codePart.indexOf('"""'),
        codePart.indexOf("'''") === -1 ? Infinity : codePart.indexOf("'''"),
      );
      if (Number.isFinite(dqIdx)) {
        const delim = codePart.slice(dqIdx, dqIdx + 3);
        const before = codePart.slice(0, dqIdx).trim();
        const after = codePart.slice(dqIdx + 3);
        const closeIdx = after.indexOf(delim);

        if (closeIdx !== -1) {
          // Code resumes after the *closing* delimiter. Scoring the text
          // between the delimiters would score the docstring's prose as
          // code: `"""Returns a class"""` scored the same as `class Foo:`,
          // and `"""Handle the class registry for each def"""` hit the 2.0
          // ceiling — pure prose ranked as the file's strongest structure.
          const trailing = after.slice(closeIdx + delim.length).trim();
          const real = [before, trailing].filter(Boolean).join("; ");
          signal[i] = real ? scoreLine(raw, real, indent, lang) : 0;
          continue;
        }
        inDocString = true;
        docStringDelim = delim;
        signal[i] = before ? scoreLine(raw, before, indent, lang) : 0;
        continue;
      }
    }

    // ── Detect block comment start (anywhere on line, including inline) ──
    // An opener that sits inside a line comment (`// see /* this`) is
    // just comment text and must not open a block comment.
    let bcStartIdx = findBlockCommentStart(masked, lang);
    if (bcStartIdx !== -1 && lcIdx !== -1 && lcIdx < bcStartIdx) bcStartIdx = -1;
    if (bcStartIdx !== -1) {
      const before = stripped.slice(0, bcStartIdx).trim();
      const bodyStart = bcStartIdx + lang.blockCommentStart.length;
      const body = (lang.blockCommentUsesParenDepth ? masked : stripped).slice(bodyStart);
      const { closeIdx, depth } = scanBlockCommentClose(body, bcOpen, bcClose, 1);

      if (closeIdx !== -1) {
        const after = stripped.slice(bodyStart + closeIdx + bcClose.length).trim();
        const real = [before, after].filter(Boolean).join("; ");
        signal[i] = real ? scoreLine(raw, real, indent, lang) : 0;
        continue;
      }
      inBlockComment = true;
      blockCommentDepth = depth;
      signal[i] = before ? scoreLine(raw, before, indent, lang) : 0;
      continue;
    }

    // ── Single-line comments ──
    if (lcIdx === 0 || masked.length === 0) {
      signal[i] = 0;
      continue;
    }

    signal[i] = scoreLine(raw, stripped, indent, lang);
  }

  return signal;
}

/**
 * Token splitter: splits on whitespace, brackets, braces, parens, commas,
 * semicolons, colons, quotes, backticks, arithmetic, logical, and bitwise
 * operators. Does NOT split on `.`, `-`, `?`, `!` — so:
 *  - `obj.class` stays one token (preventing member-access keyword leaks);
 *  - `extend-type`, `defmulti`, `defined?`, `set!` survive as single tokens.
 */
function tokenize(line: string): string[] {
  return line.split(/[\s()[\]{},;:'"`=<>+*/&|^~%@#\\]+/);
}

/**
 * Score a single line of actual code (no comments).
 */
function scoreLine(
  raw: string,
  stripped: string,
  rawIndent: number,
  lang: LanguageConfig,
): number {
  let score = 0;

  // Strip string literals first so quoted `//` URLs and quoted `/*` don't
  // confuse keyword / inline-comment scanning.
  let codeOnly = maskStringLiterals(stripped, lang);

  // Strip inline single-line comment suffix at the earliest prefix.
  const commentIdx = findLineCommentStart(codeOnly, lang);
  if (commentIdx !== -1) {
    codeOnly = codeOnly.slice(0, commentIdx).trim();
  }

  const tokens = tokenize(codeOnly);
  for (const token of tokens) {
    if (!token) continue;
    // Use hasOwn, not a `!== undefined` check: tokens like `constructor`,
    // `toString`, `valueOf` resolve to inherited Object.prototype functions
    // on a plain object, which would add a function to the score → NaN.
    if (!Object.hasOwn(lang.structuralKeywords, token)) continue;
    score += lang.structuralKeywords[token];
  }

  // Raise a keyword-less declaration to declaration level. Deliberately a
  // floor rather than a bonus: `export function foo() {` already scores as
  // a declaration through its keywords and must not be inflated further.
  // Applied before the decorator so an annotated method still outranks a
  // bare one rather than both landing on the floor.
  if (lang.declarationWeight && isCallableDeclaration(codeOnly)) {
    score = Math.max(score, lang.declarationWeight);
  }

  // Decorators / annotations: line-start `@`, Rust `#[...]`, PHP 8 `#[...]`,
  // or inline `@Annotation` (e.g. Java `public @Nullable String foo()`).
  if (lang.decoratorWeight > 0) {
    const startsWithAt = codeOnly.startsWith("@");
    const rustAttr = lang.name === "rust" && codeOnly.startsWith("#[");
    const phpAttr = lang.name === "php" && codeOnly.startsWith("#[");
    const inlineAt = /(^|\s)@[A-Za-z_]/.test(codeOnly);
    if (startsWithAt || rustAttr || phpAttr || inlineAt) {
      score += lang.decoratorWeight;
    }
  }

  // Indentation attenuates structural prominence rather than adding to it.
  //
  // It used to be additive, which let depth manufacture structure out of
  // nothing: in TypeScript a line containing no keyword at all scored
  // 8 * 0.15 = 1.20 at eight levels of indent, above `class` (1.0) and
  // above a real top-level class declaration. A broad plateau of such
  // lines then integrated to a larger coarse-scale CWT coefficient than an
  // isolated declaration spike, so peaks anchored on `}` and `continue;`
  // inside nested helpers instead of on the declarations around them.
  //
  // Nesting depth is evidence against being a landmark, not for it, so it
  // now scales the score down. `indentWeight` is the per-level decay rate;
  // a line that declares nothing stays near zero at every depth.
  //
  // Tabs expand to 4 spaces so tab-indented files (Go, etc.) attenuate
  // comparably to space-indented ones.
  const leading = raw.slice(0, rawIndent);
  let expandedIndent = 0;
  for (const ch of leading) expandedIndent += ch === "\t" ? 4 : 1;
  const depth = Math.min(expandedIndent / 4, MAX_INDENT_DEPTH);
  const attenuation = 1 / (1 + depth * lang.indentWeight);

  return Math.min((score + CODE_LINE_BASE) * attenuation, 2.0);
}
