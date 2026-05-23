# WaveScope MCP

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

4. **Band assembly** — three zoom levels:
   - **Fine** (scales 1–2): raw lines in a tight window (±~50 lines)
   - **Medium** (scales 4–16): function/class signatures in a broader region
   - **Coarse** (scales 32–128): section-level structural summary

## Installation

```bash
pnpm install
pnpm build
```

## Usage

### Running as MCP server

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "wavescope": {
      "command": "node",
      "args": ["/path/to/wavescope-mcp/dist/index.js"]
    }
  }
}
```

### Tools

#### `query_wavelet_context`

Multi-resolution view around a position.

- `file` — absolute path to the file
- `center` — line number (0-indexed)
- `radius` — total range to consider (default 300)

Returns `fine`, `medium`, and `coarse` bands plus detected wavelet peaks.

#### `get_important_positions`

Find structural boundaries (class/function defs, imports, etc.).

- `file` — single file path, OR
- `directory` — project directory for project-wide search
- `min_coefficient` — sensitivity (0–10, default 0.3)
- `limit` — max results (default 20)

#### `get_wavelet_coefficients`

Raw wavelet coefficients for custom analysis.

- `file`, `start`, `end`, `scale` (1–128)

#### `get_summary_at_scale`

Compressed view of a region using specified scale peaks.

- `file`, `start`, `end`, `scale` (optional — auto-selected if omitted)

## Development

```bash
pnpm install         # Install dependencies
pnpm build           # TypeScript compile
pnpm dev             # Run with tsx
pnpm test            # Watch mode
pnpm test:run        # Run tests once
pnpm test:coverage   # Run with coverage
pnpm typecheck       # Type check only
```

## Architecture

```
src/
├── index.ts       # MCP server entry, tool handlers
├── signal.ts      # Per-line structural importance signal
├── wavelet.ts     # Ricker CWT + peak detection
├── context.ts     # FileContext: query_wavelet_context, get_important_positions, etc.
├── project.ts     # ProjectIndex: multi-file discovery and indexing
├── language.ts    # Language-specific keyword weights
└── *.test.ts      # Tests
```

## Supported languages

Python, TypeScript, JavaScript (JSX, MJS, CJS), Go, Rust, Java, Ruby, PHP,
Swift, Kotlin, Scala, Clojure, and others. Non-recognized extensions use a
generic configuration.
