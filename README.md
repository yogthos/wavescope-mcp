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

#### `diff_wavelet_context`

Compare structural wavelet peak profiles of a file between two git revisions.
Shows which structural boundaries (function/class definitions, imports, etc.)
were added, removed, shifted, or changed in magnitude.

- `file` — absolute path to the file
- `baseRef` — base git ref (e.g. `"HEAD~1"`, `"main"`, a commit SHA)
- `targetRef` — target git ref (optional; omit to compare against the
  current working tree)
- `minCoefficient` — minimum wavelet coefficient threshold, 0–10 (default 0.3)
- `limit` — max peaks per revision, 1–500 (default 100)

Returns `{ beforeLineCount, afterLineCount, diff: { changes, summary } }`
where each change has `kind` (one of `added`, `removed`, `shifted`,
`magnitudeChanged`, `unchanged`), `before` (the old peak, null for added),
and `after` (the new peak, null for removed). The `summary` tallies counts
for each kind.

Requires the file to be inside a git repository.

#### `update_cursor_position`

Notify the server of the editor's current cursor position. The server
precomputes wavelet context around the cursor so that subsequent
`get_cursor_context` calls return instantly. Call this whenever the
cursor moves significantly.

- `file` — absolute path to the file
- `line` — cursor line (0-indexed)
- `column` — cursor column (0-indexed)

Returns `{ acknowledged: true }`.

#### `get_cursor_context`

Get the precomputed multi-resolution wavelet context around the
editor's last known cursor position. Returns the cached result from
`update_cursor_position` without recomputation. Returns an error if
no cursor has been registered for the file.

- `file` — absolute path to the file

Return shape matches `query_wavelet_context`: `center`, `clamped`,
`bands` (fine/medium/coarse), and `waveletPeaks`.

#### `get_cursor_important_positions`

Get structurally important positions near the current cursor, sorted
by a combination of proximity and structural significance. Returns
an error if no cursor has been registered for the file.

- `file` — absolute path to the file
- `limit` — max positions to return, 1–50 (default 10)

Returns an array of `{ position, coefficient, scale, label }` objects,
sorted closest-to-cursor first.

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
