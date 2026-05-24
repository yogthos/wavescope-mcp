# Feature Implementation Plan

## Overview

Three features to add to WaveScope MCP, each on its own branch, implemented via TDD, with a code review after each.

---

## Phase 1: Diff-Aware Analysis

**Branch:** `feature/diff-aware-analysis`

**Goal:** Show how structural boundaries (wavelet peaks) shift between two git commits for a file. Expose a new MCP tool `diff_wavelet_context` that compares the wavelet profile of a file at two revisions and reports added, removed, shifted, and magnitude-changed peaks.

### Design

- **New module: `src/diff.ts`** — pure functions for diffing two sets of wavelet peaks
  - `diffPeaks(before: Peak[], after: Peak[], window: number): PeakDiff` — matches peaks between two versions by position proximity, classifies as: `added`, `removed`, `shifted` (moved within `window`), `magnitudeChanged` (same position, different coefficient), `unchanged`
  - Types: `PeakDiff`, `PeakChange` with `kind`, `before?`, `after?`
- **New module: `src/git.ts`** — thin wrapper for reading file content at a specific git ref
  - `readFileAtRef(repoPath: string, filePath: string, ref: string): Promise<string>` — uses `git show <ref>:<filepath>` via `child_process.execFile`
  - Error handling for missing files, invalid refs, non-git directories
- **New MCP tool: `diff_wavelet_context`** registered in `src/index.ts`
  - Inputs: `file` (absolute path), `baseRef` (e.g. `HEAD~1`), `targetRef` (e.g. `HEAD`, defaults to working tree via `FileCache`)
  - Returns: structured diff JSON with `added`, `removed`, `shifted`, `magnitudeChanged`, `unchanged` peak arrays, plus before/after line counts
- **Tests:**
  - `src/diff.test.ts` — unit tests for `diffPeaks`: exact match, position shift, magnitude change, empty inputs, mismatched lengths, edge cases
  - `src/git.test.ts` — integration tests against the project's own git repo (reliable test fixture): read file at HEAD, read file at HEAD~1, invalid ref error, uncommitted file error

### TDD Steps

1. Write `diff.test.ts` — test `diffPeaks` with known inputs
2. Implement `diffPeaks` in `src/diff.ts`
3. Write `git.test.ts` — test `readFileAtRef` against real repo
4. Implement `readFileAtRef` in `src/git.ts`
5. Write integration test for `diff_wavelet_context` end-to-end (can test against own source files)
6. Register `diff_wavelet_context` tool in `src/index.ts`
7. Full test suite + typecheck

### Code Review Checklist

- `diffPeaks` matching algorithm: position proximity window is configurable and reasonable
- Git error handling: non-git directories, detached HEAD, binary files, file-not-in-ref all fail gracefully
- MCP tool schema: zod validation, descriptive error messages
- No unnecessary dependencies added

---

## Phase 2: Streaming Updates for Large Repositories

**Branch:** `feature/streaming-updates`

**Goal:** Handle large repositories by streaming file discovery and peak computation incrementally instead of blocking until all files are processed. Add a new MCP tool `stream_project_peaks` that yields results in batches as files are indexed, avoiding timeouts on repos with thousands of files.

### Design

- **Refactor `src/project.ts`** — add streaming variant of file discovery
  - `ProjectIndex.loadStream(root, fileCache, onBatch): Promise<ProjectIndex>` — same as `load` but calls `onBatch(files: ProjectFile[])` after each concurrency batch completes
  - Refactor `discoverFiles` into `discoverFilePaths` (returns paths only, fast) + `indexFileBatch` (contextualizes a batch, callable repeatedly)
  - The existing `ProjectIndex.load` remains unchanged; `loadStream` is additive
- **Async generator alternative considered but rejected:** MCP tool handlers must return a single result — batching works better than true streaming over stdio
- **New MCP tool: `stream_project_peaks`**
  - Inputs: `directory`, `min_coefficient`, `limit`, `batchSize` (default 50)
  - Internally accumulates peaks across batches, returns final aggregated result
  - Key benefit: processing starts immediately and intermediate results are available sooner, avoiding timeout on 5000+ file repos
  - Reports `truncated` flag + `batchesProcessed` count in response
- **Progress reporting:** The tool response includes `batchesProcessed`, `totalFilesFound`, `truncated` so the client knows if the result is partial
- **Tests:**
  - `src/project.test.ts` — add streaming-specific tests: `loadStream` yields same files as `load`, batch callback fires correctly, works with large synthetic directories

### TDD Steps

1. Write project test for `loadStream` — verifies it produces same results as `load`
2. Implement `loadStream` + `discoverFilePaths` + `indexFileBatch` in `src/project.ts`
3. Write test for batch callback — verifies batches are emitted, callbacks interleave with processing
4. Register `stream_project_peaks` tool in `src/index.ts` with zod schema + batch logic
5. Integration test verifies end-to-end behavior on a synthetic large directory
6. Full test suite + typecheck

### Code Review Checklist

- `loadStream` and `load` share discovery logic — no code duplication
- Batching respects the existing concurrency model (8 parallel workers)
- Memory: accumulated results bounded by `maxPeaks` limit, not unbounded
- `truncated` + batch counts are accurate even when directory scanning is interrupted
- Existing `ProjectIndex.load` behavior is unchanged

---

## Phase 3: Editor Cursor Position Integration

**Branch:** `feature/cursor-position-integration`

**Goal:** Accept editor cursor position updates and provide proactive context management. The server maintains cursor state per file and pre-computes wavelet context around the cursor so that when the model queries, the answer is instant.

### Design

- **New module: `src/cursor-tracker.ts`** — in-memory cursor state manager
  - `setCursor(file: string, line: number, col?: number): void` — update cursor position
  - `getCursor(file: string): CursorState | null` — retrieve current position
  - `removeCursor(file: string): void` — cleanup
  - `listTracked(): string[]` — all files with active cursors
  - TTL-based eviction (cursor goes stale after 5 min of no updates)
  - `precompute(file: string, fileCache: FileCache): void` — eagerly compute wavelet context at cursor position, cached until cursor moves
- **New MCP tool: `set_cursor_position`**
  - Inputs: `file` (absolute path), `line` (0-indexed), `column` (optional)
  - Stores cursor position, triggers precomputation
  - Returns: acknowledged + precomputed context bands
- **New MCP tool: `get_cursor_context`**
  - Inputs: `file`, `radius` (default 300)
  - Returns the precomputed wavelet context if available and still fresh, otherwise computes on demand
  - Same response shape as `query_wavelet_context`
- **Modification to `query_wavelet_context`:** If the queried file/position matches the tracked cursor (within `radius`), use the precomputed result instead of recomputing
- **Caching strategy:** Precomputed context is invalidated when:
  - Cursor moves (line changes)
  - File mtime changes (file was edited)
  - 30s TTL expires (stale precomputation)
- **Tests:**
  - `src/cursor-tracker.test.ts` — unit tests: set/get, TTL eviction, precompute hit/miss, mtime invalidation
  - Integration test: cursor set → context query returns precomputed result

### TDD Steps

1. Write `cursor-tracker.test.ts` — test `CursorTracker` set/get/remove
2. Implement `CursorTracker` class in `src/cursor-tracker.ts`
3. Write test for precomputation and invalidation
4. Implement `precompute` + invalidation logic
5. Register `set_cursor_position` and `get_cursor_context` tools in `src/index.ts`
6. Modify `query_wavelet_context` handler to check cursor cache
7. Full test suite + typecheck

### Code Review Checklist

- Cursor state is per-file, not global — multiple files can be tracked simultaneously
- Precomputation is lazy and bounded — no background threads, no unbounded work
- TTL prevents stale cursors from accumulating memory
- Mtime check prevents serving stale context after file edits
- Integration with existing `FileCache` is clean — no circular dependencies

---

## Execution Order

| Step | Feature | Branch |
|------|---------|--------|
| 1 | Diff-Aware Analysis | `feature/diff-aware-analysis` |
| 2 | Streaming Updates | `feature/streaming-updates` |
| 3 | Cursor Position Integration | `feature/cursor-position-integration` |

Each phase is independent and can be merged to `main` after review. The order minimizes conflicts: Phase 1 adds new modules, Phase 2 refactors `project.ts`, Phase 3 adds new modules and lightly modifies `index.ts`.

---

## General Principles

- **No new npm dependencies** unless absolutely necessary (git integration uses `child_process.execFile` which is a Node built-in)
- **Follow existing patterns:** zod schemas, `track()` wrapper for tool handlers, `curateFsError()` for error messages, vitest `describe`/`it`/`expect`
- **TypeScript strict mode** — all new code passes `tsc --noEmit`
- **108 existing tests must continue to pass** after each phase
- **Commit after each TDD cycle** (test → red → green → commit)
