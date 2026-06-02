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
  
See [here](https://yogthos.net/posts/2026-06-02-wavescope.html) for a more detailed explanation.

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
- `min_coefficient` — raw wavelet coefficient threshold, 0–20 (default 0.3).
  Same semantics in both single-file and project mode. Typical useful range
  is 0.1–3; the upper bound is generous because CWT coefficients can exceed
  2 at large scales.
- `limit` — max results, 1–100 (default 20)

#### `get_wavelet_coefficients`

Raw wavelet coefficients for custom analysis.

- `file`, `start`, `end`, `scale` (required, 1–128)

Returned object includes `scale` (the actual scale used) and
`requestedScale` (the original scale you asked for) — they differ when
the requested scale isn't in the index and the nearest available one is
substituted. The result also carries `clamped` (true if the requested
`start`/`end` were adjusted to fit the valid coefficient range) and
`clampedFrom: {start, end}` (the original values, present only when
`clamped` is true). A range entirely outside the file returns `coefficients: []`
with `clamped: true` rather than fabricating a boundary value.

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
- `minCoefficient` — minimum wavelet coefficient threshold, 0–20 (default 0.3)
- `limit` — max peaks per revision, 1–500 (default 100)
- `window` — max line distance for matching peaks as "shifted", 1–50 (default 2).
  Higher values treat larger moves as shifts rather than remove+add.

Returns `{ beforeLineCount, afterLineCount, diff: { changes, summary } }`
where each change has `kind` (one of `added`, `removed`, `shifted`,
`magnitudeChanged`, `unchanged`), `before` (the old peak, null for added),
and `after` (the new peak, null for removed). The `summary` tallies counts
for each kind.

Requires the file to be inside a git repository. A file that does not
exist on one side (e.g. newly added so it is missing at `baseRef`, or
deleted in the working tree when `targetRef` is omitted) is treated as
empty — its peaks all show up as `added` or `removed`. An error is
returned only when the file is missing on **both** sides.

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

#### `stream_start`

Start a streaming project-wide query. Returns a `stream_id` immediately
while results are computed in the background. Use `stream_poll` to fetch
batches incrementally and `stream_close` to cancel.

- `directory` — absolute path to the project directory
- `min_coefficient` — minimum wavelet coefficient threshold, 0–20 (default 0.3)
- `limit` — maximum total results across all batches, 1–100 (default 20)
- `batch_size` — peaks per batch, 10–500 (default 50)

Returns `{ stream_id: "<uuid>" }`.

#### `stream_poll`

Fetch the next batch of results from a streaming operation.

- `stream_id` — the ID returned by `stream_start`

Returns `{ peaks, more, complete }` where `more` indicates further
batches are queued and `complete` means the operation has finished.
Returns an error for unknown/expired stream IDs. If the producer
encountered an error, returns `{ error, complete: true }`.

#### `stream_close`

Cancel a streaming operation and free its resources.

- `stream_id` — the ID returned by `stream_start`

Returns `{ acknowledged: true }`. Idempotent for unknown IDs.

#### `get_entropy_bands`

Analyze the wavelet coefficient bands of a file for entropy using
[libwce](https://github.com/yogthos/libwce) bit-cost estimation. For each
scale in the Ricker CWT, coefficients are quantized to integers, their
Bit-Plane Counts are computed, and the encoding bit cost is estimated.
Higher bit cost = more structural irregularity at that scale — a
language-agnostic measure of local code complexity.

- `file` — absolute path to the file
- `lossy_bits` — LSBs to drop before BPC computation, 0–8 (default 0; higher
  is coarser)

Returns `{ bands, totalBitCost, meanBitCost }` where each band carries its
`scale`, `bitCost`, `riceK`, `predictor`, `sparseFlag`, and `numGroups`.

#### `get_complexity_heatmap`

Compute a multi-scale complexity heatmap for a file using a Haar DWT plus
libwce. The per-line structural signal is decomposed, the encoding bit cost
is estimated per detail band, and per-line irregularity scores are returned.
Higher scores mark structurally dense/irregular regions — useful for review
prioritization, context budgeting (keep irregular, summarize boilerplate),
and navigation.

- `file` — absolute path to the file
- `lossy_bits` — LSBs to drop before BPC computation, 0–8 (default 0)

Returns `{ bands, totalEntropy, perLineIrregularity }` where each band carries
its `level`, `span`, `bitCost`, `riceK`, `predictor`, and `sparseFlag`.

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
`.cljc`, `.edn`).

Single-file tools (`query_wavelet_context`, `get_important_positions` with
`file`, `get_summary_at_scale`, etc.) fall back to a minimal generic
configuration for any extension not listed above.

Project-wide indexing (`get_important_positions` with `directory`,
`stream_start`) is restricted to the listed extensions and known filenames
(`Rakefile`, `Gemfile`) — unknown extensions are skipped to avoid burning
budget on `.md`/`.json`/`.csv`/etc. that have little structural signal.

## Project-wide indexing limits

When `get_important_positions` is called with `directory`, the indexer:

- honors a root-level `.gitignore`, including `!` negation patterns
  (last-match-wins semantics, matching git's behavior); nested `.gitignore`
  files are not consulted;
- skips files larger than 2 MB and binary files (NUL byte sniff in first 4 KB);
- caps discovery at 5000 files (a `truncated` flag is set if exceeded);
- follows symlinks once via `realpath`, refusing any that escape the project root.
