import { LanguageConfig } from "./language.js";

/**
 * Mask the interior of single-line string and char literals with spaces
 * so that downstream comment / token detection ignores their contents.
 * Handles single-quote, double-quote, and backtick (template) literals
 * with backslash escapes. Multi-line strings are out of scope — caller
 * passes a single physical line.
 */
function maskStringLiterals(line: string, lang: LanguageConfig): string {
  // In Rust `'a` is a lifetime and in Clojure `'` is the quote reader macro —
  // neither is a string delimiter, so treating `'` as one would mask real
  // code through to end-of-line. Only `"` and backtick delimit strings there.
  const singleQuoteIsString = lang.name !== "rust" && lang.name !== "clojure";
  const chars = line.split("");
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '"' || c === "`" || (singleQuoteIsString && c === "'")) {
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
      if (lang.blockCommentUsesParenDepth) {
        let depth = blockCommentDepth;
        let closeIdx = -1;
        for (let ci = 0; ci < masked.length; ci++) {
          if (masked[ci] === "(") depth++;
          else if (masked[ci] === ")") {
            depth--;
            if (depth === 0) { closeIdx = ci; break; }
          }
        }
        if (closeIdx !== -1) {
          inBlockComment = false;
          blockCommentDepth = 0;
          const after = stripped.slice(closeIdx + 1);
          if (after.trim()) {
            signal[i] = scoreLine(raw, after.trim(), indent, lang);
          } else {
            signal[i] = 0;
          }
        } else {
          blockCommentDepth = depth;
          signal[i] = 0;
        }
      } else {
        const endIdx = masked.indexOf(lang.blockCommentEnd);
        if (endIdx !== -1) {
          inBlockComment = false;
          const after = stripped.slice(endIdx + lang.blockCommentEnd.length);
          if (after.trim()) {
            signal[i] = scoreLine(raw, after.trim(), indent, lang);
          } else {
            signal[i] = 0;
          }
        } else {
          signal[i] = 0;
        }
      }
      continue;
    }

    if (inDocString) {
      const endIdx = masked.indexOf(docStringDelim!);
      if (endIdx !== -1) {
        inDocString = false;
        docStringDelim = null;
        const after = stripped.slice(endIdx + 3);
        if (after.trim()) {
          signal[i] = scoreLine(raw, after.trim(), indent, lang);
        } else {
          signal[i] = 0;
        }
      } else {
        signal[i] = 0;
      }
      continue;
    }

    // ── Detect new Python docstrings (triple quotes) ──
    // Python's triple quotes are scanned on the unmasked stripped line
    // because maskStringLiterals would have consumed them as regular strings.
    if (lang.name === "python") {
      const dqIdx = Math.min(
        stripped.indexOf('"""') === -1 ? Infinity : stripped.indexOf('"""'),
        stripped.indexOf("'''") === -1 ? Infinity : stripped.indexOf("'''"),
      );
      if (Number.isFinite(dqIdx)) {
        const delim = stripped.slice(dqIdx, dqIdx + 3);
        const before = stripped.slice(0, dqIdx).trim();
        const after = stripped.slice(dqIdx + 3);
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
    const bcStartIdx = lang.blockCommentAtLineStart
      ? (masked.startsWith(lang.blockCommentStart) ? 0 : -1)
      : masked.indexOf(lang.blockCommentStart);
    if (bcStartIdx !== -1) {
      const before = stripped.slice(0, bcStartIdx).trim();
      const afterDelim = masked.slice(bcStartIdx + lang.blockCommentStart.length);
      const afterDelimRaw = stripped.slice(bcStartIdx + lang.blockCommentStart.length);

      let endIdx = -1;
      if (lang.blockCommentUsesParenDepth) {
        let depth = 1;
        for (let ci = 0; ci < afterDelim.length; ci++) {
          if (afterDelim[ci] === "(") depth++;
          else if (afterDelim[ci] === ")") {
            depth--;
            if (depth === 0) { endIdx = ci; break; }
          }
        }
      } else {
        endIdx = afterDelim.indexOf(lang.blockCommentEnd);
      }

      if (endIdx !== -1) {
        const after = afterDelimRaw.slice(endIdx + lang.blockCommentEnd.length).trim();
        const real = [before, after].filter(Boolean).join("; ");
        signal[i] = real ? scoreLine(raw, real, indent, lang) : 0;
        continue;
      }
      inBlockComment = true;
      blockCommentDepth = lang.blockCommentUsesParenDepth ? 1 : 0;
      signal[i] = before ? scoreLine(raw, before, indent, lang) : 0;
      continue;
    }

    // ── Single-line comments ──
    const isComment = lang.commentPrefixes.some((p) => {
      if (!masked.startsWith(p)) return false;
      // PHP 8 attributes: `#[...]` is NOT a comment.
      if (p === "#" && masked.startsWith("#[")) return false;
      return true;
    });
    if (isComment || masked.length === 0) {
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
 *  - `extend-type`, `defmulti`, `defined?` survive as single tokens.
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

  // Strip inline single-line comment suffix
  for (const prefix of lang.commentPrefixes) {
    let idx = -1;
    let from = 0;
    while (from < codeOnly.length) {
      const next = codeOnly.indexOf(prefix, from);
      if (next === -1) break;
      // PHP 8 attribute: `#[...]` is not a comment
      if (prefix === "#" && codeOnly[next + 1] === "[") {
        from = next + 1;
        continue;
      }
      idx = next;
      break;
    }
    if (idx !== -1) {
      codeOnly = codeOnly.slice(0, idx).trim();
      break;
    }
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
