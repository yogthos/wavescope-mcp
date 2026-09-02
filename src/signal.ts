import { LanguageConfig } from "./language.js";

const DEFAULT_STRING_DELIMITERS = ['"', "'", "`"];

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
        const hasClosing = after.includes(delim);

        if (hasClosing) {
          const real = [before, after.replaceAll(delim, "").trim()]
            .filter(Boolean).join("; ");
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

  // Indent: expand tabs as 4 spaces so tab-indented files (Go, etc.)
  // score comparably to space-indented ones.
  const leading = raw.slice(0, rawIndent);
  let expandedIndent = 0;
  for (const ch of leading) expandedIndent += ch === "\t" ? 4 : 1;
  const indentLevel = Math.min(expandedIndent / 4, 8);
  score += indentLevel * lang.indentWeight;

  const tokens = tokenize(codeOnly);
  for (const token of tokens) {
    if (!token) continue;
    // Use hasOwn, not a `!== undefined` check: tokens like `constructor`,
    // `toString`, `valueOf` resolve to inherited Object.prototype functions
    // on a plain object, which would add a function to the score → NaN.
    if (!Object.hasOwn(lang.structuralKeywords, token)) continue;
    score += lang.structuralKeywords[token];
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

  return Math.min(score, 2.0);
}
