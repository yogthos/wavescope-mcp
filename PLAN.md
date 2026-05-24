# WaveScope MCP — Feature Implementation Plan

## Overview

Three features, each on its own branch, implemented via TDD, with code review after each.

---

## Feature 1: Diff-Aware Analysis (`feat/diff-analysis`)

**Goal:** Show how structural boundaries (wavelet peaks) shift between two versions
of a file, or between two commits across a project.

### Implementation Steps

1. **`src/diff.ts`** — Core diff computation
   - `diffFileContexts(old: FileContext, new: FileContext): DiffResult`
   - Computes peaks for both, matches them by position proximity, reports:
     - `added`: peaks present in new but not old
     - `removed`: peaks present in old but not new  
     - `shifted`: peaks that moved (same label, different position)
     - `unchanged`: peaks at same position in both
   - `DiffResult` also includes a "structural churn score" (0-1)

2. **MCP Tool: `diff_wavelet_context`**
   - Input: `file` (path), `oldCommit` (optional, defaults to HEAD~1), `newCommit` (optional, defaults to working tree)
   - Reads both versions, builds FileContext for each, runs diff
   - Returns structured JSON with added/removed/shifted/unchanged peaks

3. **Tests (`src/diff.test.ts`)**
   - Two identical files → all peaks unchanged, churn 0
   - Function added → reported as added
   - Function removed → reported as removed
   - Function moved → reported as shifted
   - Empty old file, new file with content → all peaks added
   - Realistic: small refactor of sample Python file

### Files to create/modify
- `src/diff.ts` (new)
- `src/diff.test.ts` (new)
- `src/index.ts` (modify — register new tool)

---

## Feature 2: Streaming Updates for Large Repositories (`feat/streaming-updates`)

**Goal:** Yield partial results during project indexing so the caller sees progress
and gets useful peaks before the full scan completes.

### Implementation Steps

1. **`src/streaming.ts`** — Async generator for streaming file discovery
   - `streamDiscoverFiles(root, fileCache): AsyncGenerator<StreamEvent>`
   - Events: `{ type: "progress", filesFound: number, filesProcessed: number }` and `{ type: "peaks", peaks: ImportantPosition[], partial: true }`
   - Batching: emit peaks every N files (configurable, default 50)
   - Uses the same discovery logic as `ProjectIndex` but yields incrementally

2. **MCP Tool: `stream_important_positions`**  
   - Input: `directory`, `min_coefficient`, `limit`, `batch_size`
   - Returns results as they come — but MCP doesn't natively support streaming, so we use a different approach:
     - First call returns a `stream_id` and initial batch
     - Subsequent calls with `stream_id` return next batch
     - `stream_close` to clean up
   - Alternative (simpler): just return results in batches immediately with a `more: true` flag and `cursor` token for pagination

3. **Stream state management** — `StreamManager` class
   - Holds active streams, TTL expiry, cleanup
   - `createStream()`, `pollStream()`, `closeStream()`

4. **Tests (`src/streaming.test.ts`)**
   - Streaming yields progress events
   - Batches arrive in order
   - Stream cleanup works
   - Large project doesn't block

### Files to create/modify
- `src/streaming.ts` (new)
- `src/streaming.test.ts` (new)
- `src/index.ts` (modify — register new tools)

---

## Feature 3: Editor Cursor Integration (`feat/cursor-context`)

**Goal:** Proactive context management driven by editor cursor position. The editor
sends cursor updates, the server prefetches and caches context around the cursor.

### Implementation Steps

1. **`src/cursor.ts`** — Cursor state manager
   - `CursorManager` class: tracks active files and cursor positions
   - `updateCursor(file, line, column)`: called by editor when cursor moves
   - `getProactiveContext(file)`: returns pre-computed wavelet context around cursor
   - Debouncing: only recompute if cursor moved significantly (>10 lines)
   - Prefetching: when cursor enters a new file, precompute context for nearby regions

2. **MCP Tools:**
   - `update_cursor_position`: `{ file, line, column }` — editor calls on cursor move
   - `get_cursor_context`: `{ file }` — returns precomputed wavelet context around current cursor
   - `get_cursor_important_positions`: `{ file }` — returns important positions near cursor, sorted by proximity

3. **Integration with existing tools:**
   - `query_wavelet_context` gains optional `center` default when cursor is active
   - `get_important_positions` can filter by proximity to cursor

4. **Tests (`src/cursor.test.ts`)**
   - Cursor update stores position
   - Proactive context is precomputed
   - Debouncing works (small movements don't recompute)
   - Multi-file cursor tracking
   - Expiry/cleanup of stale cursors

### Files to create/modify
- `src/cursor.ts` (new)
- `src/cursor.test.ts` (new)
- `src/index.ts` (modify — register new tools)

---

## Execution Order

1. **Feature 1: Diff-Aware Analysis** → branch `feat/diff-analysis`
2. **Feature 2: Streaming Updates** → branch `feat/streaming-updates`  
3. **Feature 3: Editor Cursor Integration** → branch `feat/cursor-context`

Each feature follows the TDD cycle:
- Write failing test → implement → pass → verify (typecheck + full test suite)

After each feature, run the full test suite and typecheck before merging.
