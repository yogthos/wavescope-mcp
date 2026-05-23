import { LanguageConfig } from "./language.js";

export function computeSignal(
  lines: string[],
  lang: LanguageConfig,
): number[] {
  const signal: number[] = new Array(lines.length);
  let inBlockComment = false;
  let inDocString = false;
  let docStringDelim: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    const indent = raw.length - trimmed.length;
    const stripped = trimmed.trimEnd();

    // ── Handle multiline comments / docstrings (continued from previous line) ──
    if (inBlockComment) {
      const endIdx = stripped.indexOf(lang.blockCommentEnd);
      if (endIdx !== -1) {
        inBlockComment = false;
        // Process code after the closing delimiter, if any
        const after = stripped.slice(endIdx + lang.blockCommentEnd.length);
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

    if (inDocString) {
      const endIdx = stripped.indexOf(docStringDelim!);
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
    if (lang.name === "python") {
      const dqIdx = Math.min(
        stripped.indexOf('"""') === -1 ? Infinity : stripped.indexOf('"""'),
        stripped.indexOf("'''") === -1 ? Infinity : stripped.indexOf("'''"),
      );
      if (dqIdx !== -1 && dqIdx !== Infinity) {
        const delim = stripped.slice(dqIdx, dqIdx + 3);
        const before = stripped.slice(0, dqIdx).trim();
        const after = stripped.slice(dqIdx + 3);
        const hasClosing = after.includes(delim);

        if (hasClosing) {
          // Single-line docstring: score only code before/after the quotes
          const real = [before, after.replace(delim, "").trim()]
            .filter(Boolean).join("; ");
          signal[i] = real ? scoreLine(raw, real, indent, lang) : 0;
          continue;
        }
        // Multi-line docstring start
        inDocString = true;
        docStringDelim = delim;
        signal[i] = before ? scoreLine(raw, before, indent, lang) : 0;
        continue;
      }
    }

    // ── Detect block comment start (anywhere on line, including inline) ──
    const bcStartIdx = stripped.indexOf(lang.blockCommentStart);
    if (bcStartIdx !== -1) {
      const before = stripped.slice(0, bcStartIdx).trim();
      const afterDelim = stripped.slice(bcStartIdx + lang.blockCommentStart.length);
      const endIdx = afterDelim.indexOf(lang.blockCommentEnd);

      if (endIdx !== -1) {
        // Single-line block comment: score code before and after
        const after = afterDelim.slice(endIdx + lang.blockCommentEnd.length).trim();
        const real = [before, after].filter(Boolean).join("; ");
        signal[i] = real ? scoreLine(raw, real, indent, lang) : 0;
        continue;
      }
      // Multi-line block comment start
      inBlockComment = true;
      signal[i] = before ? scoreLine(raw, before, indent, lang) : 0;
      continue;
    }

    // ── Single-line comments ──
    const isComment = lang.commentPrefixes.some(
      (p) => stripped.startsWith(p),
    );
    if (isComment || stripped.length === 0) {
      signal[i] = 0;
      continue;
    }

    signal[i] = scoreLine(raw, stripped, indent, lang);
  }

  return signal;
}

/**
 * Score a single line of actual code (no comments).
 */
function scoreLine(
  _raw: string,
  stripped: string,
  indent: number,
  lang: LanguageConfig,
): number {
  let score = 0;

  // Indentation depth (proxy for nesting)
  const indentLevel = Math.min(indent / 4, 8);
  score += indentLevel * lang.indentWeight;

  // Split on code delimiters so that adjacent punctuation doesn't hide keywords.
  // E.g., "function(" → ["function", ""], "for(" → ["for", ""]
  const tokens = stripped.split(/[\s()[\]{},;:'".=!<>+\-*/&|^~%@#`]+/);
  for (const token of tokens) {
    if (!token) continue;
    const kwWeight = lang.structuralKeywords[token];
    if (kwWeight !== undefined) score += kwWeight;
  }

  // Decorators / annotations
  if (lang.name === "python" && stripped.startsWith("@")) {
    score += lang.decoratorWeight;
  }
  if (
    (lang.name === "typescript" || lang.name === "java" || lang.name === "kotlin") &&
    stripped.startsWith("@")
  ) {
    score += lang.decoratorWeight;
  }

  return Math.min(score, 2.0);
}
