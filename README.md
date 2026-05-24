# WaveScope MCP

[![SafeSkill 89/100](https://img.shields.io/badge/SafeSkill-89%2F100_Passes%20with%20Notes-yellow)](https://safeskill.dev/scan/yogthos-wavescope-mcp)
Wavelet-based multi-resolution context management for LLMs via MCP.

Provides a **zoomable view** of code files — the model can look at high-level
structure, then drill down to specific regions as needed, without loading
entire files into context.

## How it works

1. **Structural signal** — each line gets an importance score based on
   indentation, keywords (`class`, `def`, `export`, etc.), and comment status.

2. **Ricker wavelet transform** — the signal is convolved with Ricker (Mexican
   hat) wavelets at 8 scales (1–128), detecting structural boundaries at
   multiple resolutions.

3. **Multi-scale peaks** — coefficient maxima are extracted and sorted by
   magnitude, identifying the most important structural transitions.

4. **Band assembly** — three zoom levels, sized as a fraction of the query
   `radius` (default 300):
   - **Fine** (scales 1–2): raw lines in ±`radius/5` (≥10 lines)
   - **Medium** (scales 4–16): function/class signatures in ±`radius/2`
   - **Coarse** (scales 32–128): section-level structural summary across ±`radius`

## Installation

### From npm (recommended)

```bash
npm install -g wavescope-mcp
# or locally in a project:
npm install wavescope-mcp
```

### From source

```bash
git clone <repo-url>
cd wavescope-mcp
pnpm install    # auto-builds dist/ via prepare script
```

## Usage

### Running as MCP server

After global install, just use the binary name:

```json
{
  "mcpServers": {
    "wavescope": {
      "command": "wavescope-mcp"
    }
  }
}
```

With a local install, use `npx`:

```json
{
  "mcpServers": {
    "wavescope": {
      "command": "npx",
      "args": ["wavescope-mcp"]
    }
  }
}
```

### Tools

#### `query_wavelet_context`

Multi-resolution view around a position.

- `file` — absolute path to the file
- `center` — line number (0-indexed)
- `radius` — total range to consider, 10–2000 (default 300)

Returns `center`, `clamped` (and `clampedFrom` when out of range was
clamped), three `fine`/`medium`/`coarse` bands, and detected wavelet peaks.

#### `get_important_positions`

Find structural boundaries (class/function defs, imports, etc.).

- exactly one of `file` (single file path) or `directory` (project-wide search)
- `min_coefficient` — raw wavelet coefficient threshold, 0–10 (default 0.3).
  Same semantics in both single-file and project mode.
- `limit` — max results, 1–100 (default 20)

#### `get_wavelet_coefficients`

Raw wavelet coefficients for custom analysis.

- `file`, `start`, `end`, `scale` (required, 1–128)

Returned object includes `scale` (the actual scale used) and
`requestedScale` (the original scale you asked for) — they differ when
the requested scale isn't in the index and the nearest available one is
substituted.

#### `get_summary_at_scale`

Compressed view of a region using specified scale peaks.

- `file`, `start`, `end`, `scale` (optional — auto-selected based on
  region size if omitted: ≤50 lines → 2, ≤200 → 8, ≤800 → 32, >800 → 128)

## Development

```bash
pnpm install         # Install dependencies + auto-build dist/
pnpm dev             # Run with tsx (live TypeScript)
pnpm test            # Watch mode
pnpm test:run        # Run tests once
pnpm test:coverage   # Run with coverage
pnpm typecheck       # Type check only
```

`pnpm install` runs the `prepare` script, which builds `dist/` automatically.
For a manual build, run `pnpm build`.

## Supported languages

Python (`.py`, `.pyi`, `.pyx`), TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`),
JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`), Go, Rust, Java, Ruby (incl.
`Rakefile`, `Gemfile`), PHP, Swift, Kotlin, Scala, Clojure (`.clj`, `.cljs`,
`.cljc`, `.edn`). Non-recognized extensions use a minimal generic
configuration.

## Project-wide indexing limits

When `get_important_positions` is called with `directory`, the indexer:

- honors a root-level `.gitignore` (plain patterns; no negations);
- skips files larger than 2 MB and binary files (NUL byte sniff in first 4 KB);
- caps discovery at 5000 files (a `truncated` flag is set if exceeded);
- follows symlinks once via `realpath`, refusing any that escape the project root.
