#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isAbsolute, resolve, relative } from "node:path";
import { stat as fsStat } from "node:fs/promises";
import { z } from "zod";
import { FileCache } from "./file-cache.js";
import {
  ProjectIndex,
  evictExpiredProjects,
  evictFractionProjects,
} from "./project.js";
import { CursorManager } from "./cursor.js";
import { ImportantPosition } from "./context.js";
import { diffFileAtRefs, DiffFileMissingError } from "./diff.js";
import { StreamManager } from "./streaming.js";
import { computeComplexityHeatmap } from "./entropy.js";
import { computeBandEntropy } from "./wce.js";

// ─── Shared file cache ────────────────────────────────────────

const fileCache = new FileCache(60_000, 200);
const getFileContext = (filePath: string) => fileCache.get(filePath);
const cursorManager = new CursorManager(60_000, 50);
const streamManager = new StreamManager(60_000, 20);

// ─── Curated error helpers ───────────────────────────────────

class ToolError extends Error {}

export interface ToolResponse {
  isError?: boolean;
  content: { type: "text"; text: string }[];
  [key: string]: unknown;
}

function toolErrorResponse(message: string): ToolResponse {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function curateFsError(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOENT") return "File not found";
  if (e?.code === "EACCES") return "Permission denied";
  if (e?.code === "EPERM") return "Permission denied";
  if (e?.code === "EISDIR") return "Expected a file, got a directory";
  if (e?.code === "ENOTDIR") return "Expected a directory, got a file";
  if (e?.code === "EMFILE" || e?.code === "ENFILE") return "Too many open files";
  if (e?.code === "ELOOP") return "Symlink loop detected";
  if (err instanceof ToolError) return err.message;
  console.error("[wavescope] Internal error:", err);
  return "Internal error";
}

function requireAbsoluteFile(path: string): void {
  if (!isAbsolute(path)) throw new ToolError("`file` must be an absolute path");
}

// ─── In-flight tracking for graceful shutdown ───────────────

let inFlight = 0;
function track<T>(fn: () => Promise<T>): Promise<T> {
  inFlight++;
  return fn().finally(() => {
    inFlight--;
  });
}

const server = new McpServer({
  name: "wavescope-mcp",
  version: "1.0.0",
});

// ─── query_wavelet_context ─────────────────────────────────

server.registerTool(
  "query_wavelet_context",
  {
    description:
      "Get a multi-resolution (fine/medium/coarse) view of code around a position. " +
      "Fine band shows exact lines near the center, medium band shows function/class signatures, " +
      "coarse band shows section-level structure. Use this to zoom in and out of a file.",
    inputSchema: {
      file: z.string().describe("Absolute path to the file"),
      center: z.number().int().min(0).describe(
        "Line number to center on (0-indexed)",
      ),
      radius: z.number().int().min(10).max(2000).default(300).describe(
        "Total range to consider (before + after center). 10-2000. Default 300.",
      ),
    },
  },
  ({ file, center, radius }) =>
    track(async () => {
      try {
        requireAbsoluteFile(file);
        const ctx = await getFileContext(file);
        const result = ctx.queryWaveletContext(center, radius);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return toolErrorResponse(curateFsError(err));
      }
    }),
);

// ─── get_important_positions ───────────────────────────────

server.registerTool(
  "get_important_positions",
  {
    description:
      "Find structurally important positions (class/function boundaries, imports, etc.) " +
      "in a file or directory. Returns positions sorted by wavelet coefficient magnitude. " +
      "Provide exactly one of 'file' or 'directory'.",
    inputSchema: {
      file: z.string().optional().describe(
        "Absolute path to a single file. Mutually exclusive with 'directory'.",
      ),
      directory: z.string().optional().describe(
        "Absolute path to a project directory. Mutually exclusive with 'file'.",
      ),
      min_coefficient: z.number().min(0).max(20).default(0.3).describe(
        "Minimum wavelet coefficient threshold. Lower = more results. " +
        "CWT coefficients commonly land in 0–3 for typical files but can " +
        "exceed 2 at large scales, so the upper bound is generous (20). Default 0.3.",
      ),
      limit: z.number().int().min(1).max(100).default(20).describe(
        "Maximum number of positions to return. 1-100. Default 20.",
      ),
    },
  },
  ({ file, directory, min_coefficient, limit }) =>
    track(async () => {
      try {
        if (file && directory) {
          throw new ToolError(
            "Provide either 'file' or 'directory', not both",
          );
        }
        if (!file && !directory) {
          throw new ToolError("Provide either 'file' or 'directory'");
        }
        let positions;
        let truncated = false;
        if (directory) {
          const project = await ProjectIndex.load(resolve(directory), fileCache);
          positions = project.getImportantPositions(min_coefficient, limit);
          truncated = project.truncated;
        } else {
          const ctx = await getFileContext(file!);
          positions = ctx.getImportantPositions(min_coefficient, limit);
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ positions, truncated }, null, 2) }],
        };
      } catch (err) {
        return toolErrorResponse(curateFsError(err));
      }
    }),
);

// ─── get_wavelet_coefficients ──────────────────────────────

server.registerTool(
  "get_wavelet_coefficients",
  {
    description:
      "Get raw wavelet coefficients for a range of lines at a specific scale. " +
      "Scales: 1-2 (fine/detailed), 4-16 (medium), 32-128 (coarse/overview). " +
      "If the requested scale isn't directly available, the response includes both " +
      "the actual `scale` used and the original `requestedScale`.",
    inputSchema: {
      file: z.string().describe("Absolute path to the file"),
      start: z.number().int().min(0).describe(
        "Start line (0-indexed, inclusive)",
      ),
      end: z.number().int().min(0).describe(
        "End line (0-indexed, inclusive)",
      ),
      scale: z.number().int().min(1).max(128).describe(
        "Wavelet scale (required). 1-2: fine, 4-16: medium, 32-128: coarse.",
      ),
    },
  },
  ({ file, start, end, scale }) =>
    track(async () => {
      try {
        requireAbsoluteFile(file);
        if (start > end) {
          throw new ToolError("`start` must be <= `end`");
        }
        const ctx = await getFileContext(file);
        const result = ctx.getWaveletCoefficients(start, end, scale);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return toolErrorResponse(curateFsError(err));
      }
    }),
);

// ─── get_summary_at_scale ──────────────────────────────────

server.registerTool(
  "get_summary_at_scale",
  {
    description:
      "Get a compressed/summarized view of a region using wavelet peaks at a given scale. " +
      "Larger scales give coarser summaries. Omit `scale` for auto-selection based on region size.",
    inputSchema: {
      file: z.string().describe("Absolute path to the file"),
      start: z.number().int().min(0).describe(
        "Start line (0-indexed, inclusive)",
      ),
      end: z.number().int().min(0).describe(
        "End line (0-indexed, inclusive)",
      ),
      scale: z.number().int().min(1).max(128).optional().describe(
        "Wavelet scale for the summary. Larger = coarser. Omit for auto-selection.",
      ),
    },
  },
  ({ file, start, end, scale }) =>
    track(async () => {
      try {
        requireAbsoluteFile(file);
        if (start > end) {
          throw new ToolError("`start` must be <= `end`");
        }
        const ctx = await getFileContext(file);
        const summary = ctx.getSummaryAtScale(start, end, scale);
        return {
          content: [{ type: "text" as const, text: summary }],
        };
      } catch (err) {
        return toolErrorResponse(curateFsError(err));
      }
    }),
);

// ─── diff_wavelet_context ──────────────────────────────────

server.registerTool(
  "diff_wavelet_context",
  {
    description:
      "Compare wavelet structural boundaries of a file between two git revisions. " +
      "Shows which structural peaks (function/class boundaries, imports, etc.) were " +
      "added, removed, shifted, or changed in magnitude. " +
      "Omit targetRef to compare against the current working tree.",
    inputSchema: {
      file: z.string().describe("Absolute path to the file"),
      baseRef: z.string().describe("Base git ref (e.g. 'HEAD~1', 'main', a commit SHA)"),
      targetRef: z.string().optional().describe(
        "Target git ref. Omit to compare against the current working tree.",
      ),
      minCoefficient: z.number().min(0).max(20).default(0.3).describe(
        "Minimum wavelet coefficient threshold for peak detection. Lower = more peaks. " +
        "Upper bound is generous (20) because CWT coefficients can exceed 2 at large scales. Default 0.3.",
      ),
      limit: z.number().int().min(1).max(500).default(100).describe(
        "Maximum number of peaks to detect per revision. Default 100.",
      ),
      window: z.number().int().min(1).max(50).default(2).describe(
        "Maximum line distance for matching peaks as 'shifted'. " +
        "Higher values treat larger moves as shifts rather than remove+add. Default 2.",
      ),
    },
  },
  (input) => track(() => handleDiffWaveletContext(input)),
);

interface DiffWaveletContextInput {
  file: string;
  baseRef: string;
  targetRef?: string;
  minCoefficient: number;
  limit: number;
  window: number;
}

export async function handleDiffWaveletContext(
  input: DiffWaveletContextInput,
): Promise<ToolResponse> {
  const { file, baseRef, targetRef, minCoefficient, limit, window } = input;
  try {
    requireAbsoluteFile(file);
    const absFile = resolve(file);

    const result = await diffFileAtRefs(absFile, baseRef, targetRef, {
      minCoefficient,
      limit,
      window,
      getWorkingTreeContext: getFileContext,
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    if (err instanceof DiffFileMissingError) {
      return toolErrorResponse(err.message);
    }
    if (err instanceof Error) {
      if (/Not a git repository/.test(err.message)) {
        return toolErrorResponse("File is not in a git repository");
      }
      if (/is outside the repository/.test(err.message)) {
        return toolErrorResponse("File is outside the git repository");
      }
    }
    return toolErrorResponse(curateFsError(err));
  }
}

// ─── update_cursor_position ────────────────────────────────

server.registerTool(
  "update_cursor_position",
  {
    description:
      "Notify the server of the editor's current cursor position. " +
      "The server precomputes wavelet context around the cursor so " +
      "that subsequent get_cursor_context calls return instantly. " +
      "Call this whenever the cursor moves significantly.",
    inputSchema: {
      file: z.string().describe("Absolute path to the file"),
      line: z.number().int().min(0).describe(
        "Cursor line number (0-indexed)",
      ),
      column: z.number().int().min(0).describe(
        "Cursor column number (0-indexed)",
      ),
    },
  },
  ({ file, line, column }) =>
    track(async () => {
      try {
        requireAbsoluteFile(file);
        const ctx = await getFileContext(file);
        cursorManager.updateCursor(ctx, file, line, column);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ acknowledged: true }),
          }],
        };
      } catch (err) {
        return toolErrorResponse(curateFsError(err));
      }
    }),
);

// ─── get_cursor_context ────────────────────────────────────

server.registerTool(
  "get_cursor_context",
  {
    description:
      "Get precomputed multi-resolution wavelet context around the " +
      "editor's current cursor position. Returns cached result from " +
      "the last update_cursor_position call. Returns null if no " +
      "cursor position has been registered for this file.",
    inputSchema: {
      file: z.string().describe("Absolute path to the file"),
    },
  },
  (input) => track(() => handleGetCursorContext(input)),
);

export async function handleGetCursorContext(
  input: { file: string },
): Promise<ToolResponse> {
  const { file } = input;
  try {
    requireAbsoluteFile(file);
    // Pull a mtime-validated FileContext so a disk change since the
    // last update_cursor_position triggers a recompute instead of
    // serving a stale proactiveContext.
    let freshCtx;
    try {
      freshCtx = await getFileContext(file);
    } catch (err) {
      // Tolerate transient file-system blips (deleted-then-recreated
      // on atomic save, brief permission flap). Anything else should
      // propagate so the editor sees real failures.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "EACCES") throw err;
    }
    const context = cursorManager.getProactiveContext(file, freshCtx);
    if (!context) {
      throw new ToolError("No cursor registered for this file");
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(context, null, 2) }],
    };
  } catch (err) {
    return toolErrorResponse(curateFsError(err));
  }
}

// ─── get_cursor_important_positions ─────────────────────────

server.registerTool(
  "get_cursor_important_positions",
  {
    description:
      "Get structurally important positions near the current cursor, " +
      "sorted by a combination of proximity and structural significance. " +
      "Returns null if no cursor position has been registered for this file.",
    inputSchema: {
      file: z.string().describe("Absolute path to the file"),
      limit: z.number().int().min(1).max(50).default(10).describe(
        "Maximum number of positions to return. Default 10.",
      ),
    },
  },
  (input) => track(() => handleGetCursorImportantPositions(input)),
);

export async function handleGetCursorImportantPositions(
  input: { file: string; limit: number },
): Promise<ToolResponse> {
  const { file, limit } = input;
  try {
    requireAbsoluteFile(file);
    let freshCtx;
    try {
      freshCtx = await getFileContext(file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "EACCES") throw err;
    }
    const positions = cursorManager.getCursorImportantPositions(
      file,
      limit,
      freshCtx,
    );
    if (!positions) {
      throw new ToolError("No cursor registered for this file");
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(positions, null, 2) }],
    };
  } catch (err) {
    return toolErrorResponse(curateFsError(err));
  }
}

// ─── stream_start ──────────────────────────────────────────

server.registerTool(
  "stream_start",
  {
    description:
      "Start a streaming operation. Returns a stream_id that can be polled " +
      "with stream_poll to receive results incrementally. " +
      "Use this for long-running project-wide queries.",
    inputSchema: {
      directory: z.string().describe("Absolute path to the project directory"),
      min_coefficient: z.number().min(0).max(20).default(0.3).describe(
        "Minimum wavelet coefficient threshold. Default 0.3.",
      ),
      limit: z.number().int().min(1).max(100).default(20).describe(
        "Maximum total results across all batches. Default 20.",
      ),
      batch_size: z.number().int().min(10).max(500).default(50).describe(
        "Peaks per batch, 10–500. Default 50.",
      ),
    },
  },
  (input) => track(() => handleStreamStart(input)),
);

export async function handleStreamStart(
  input: {
    directory: string;
    min_coefficient: number;
    limit: number;
    batch_size: number;
  },
): Promise<ToolResponse> {
  const { directory, min_coefficient, limit, batch_size } = input;
  try {
    if (!isAbsolute(directory)) {
      throw new ToolError("`directory` must be an absolute path");
    }
    const root = resolve(directory);
    // Validate the directory exists and is a directory BEFORE returning a
    // stream_id. Otherwise the error only surfaces via the first poll,
    // forcing the client through an extra round-trip just to learn the
    // path was bad and leaking the raw FS-path-bearing message.
    let dirStat;
    try {
      dirStat = await fsStat(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new ToolError("Directory not found");
      }
      throw err;
    }
    if (!dirStat.isDirectory()) {
      throw new ToolError("`directory` is not a directory");
    }
    const streamId = streamManager.createStream();
        // Per-stream AbortController so stream_close / TTL eviction can
        // interrupt the discovery walk, not just the emit loop between
        // batches.
        const aborter = new AbortController();
        streamManager.registerAborter(streamId, aborter);

        // Background producer — kept inside track() so graceful shutdown
        // waits for emission to drain, not just for the first setImmediate.
        track(async () => {
          try {
            const project = await ProjectIndex.load(root, fileCache, aborter.signal);
            const allFiles = project.files;

            if (allFiles.length === 0) {
              streamManager.appendBatch(streamId, [], true);
              return;
            }

            // Collect peaks with a bounded top-N list to keep memory O(limit)
            // instead of O(files × 500). Each file's peaks are merged into
            // the running top-N, truncated to `limit`, and discarded.
            const topPeaks: (ImportantPosition & { filename: string })[] = [];

            for (const f of allFiles) {
              if (!streamManager.peek(streamId)) return; // cancelled or evicted

              const peaks = f.context.getImportantPositions(
                min_coefficient,
                500,
              );
              if (peaks.length === 0) continue;

              const fileRelPath = relative(root, f.path);
              for (const p of peaks) {
                topPeaks.push({
                  ...p,
                  label: `${p.label} (${fileRelPath})`,
                  filename: fileRelPath,
                });
              }

              // Keep only the top `limit` by |coefficient|
              topPeaks.sort(
                (a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient),
              );
              if (topPeaks.length > limit) topPeaks.length = limit;
            }

            // Emit in chunks, yielding between batches so the consumer
            // can poll. peek() avoids refreshing the stream's TTL — only
            // the consumer's poll() should keep the stream alive.
            for (
              let offset = 0;
              offset < topPeaks.length;
              offset += batch_size
            ) {
              if (!streamManager.peek(streamId)) return; // cancelled or evicted
              const chunk = topPeaks.slice(offset, offset + batch_size);
              const isLast = offset + batch_size >= topPeaks.length;
              streamManager.appendBatch(streamId, chunk, isLast);
              if (!isLast) {
                await new Promise<void>((r) => setImmediate(r));
              }
            }

            // Edge case: limit returned fewer peaks than batch_size, or
            // all peaks were filtered out. Signal completion.
            if (topPeaks.length === 0) {
              streamManager.appendBatch(streamId, [], true);
            }
          } catch (err) {
            // AbortError from stream_close / eviction — silent exit, the
            // stream is already gone so there's no consumer to report to.
            if ((err as Error)?.name === "AbortError") return;
            // Sanitize before exposing — raw error.message can include
            // absolute filesystem paths and Node ENOENT/EACCES details.
            streamManager.markErrored(streamId, curateFsError(err));
          }
        }).catch(() => {
          // Defensive: track() should never reject because the inner try/catch
          // covers the producer, but guard against unhandled rejections from
          // markErrored itself or future refactors.
        });

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ stream_id: streamId }),
      }],
    };
  } catch (err) {
    return toolErrorResponse(curateFsError(err));
  }
}

// ─── stream_poll ───────────────────────────────────────────

server.registerTool(
  "stream_poll",
  {
    description:
      "Poll the next batch of results from a streaming operation. " +
      "Returns an error if the stream ID is unknown. " +
      "Returns { complete: true } when finished.",
    inputSchema: {
      stream_id: z.string().describe("Stream ID from stream_start"),
    },
  },
  ({ stream_id }) =>
    track(async () => {
      try {
        const result = streamManager.poll(stream_id);
        if (!result) {
          return toolErrorResponse("Unknown stream ID — stream may have been closed or expired");
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return toolErrorResponse(curateFsError(err));
      }
    }),
);

// ─── stream_close ──────────────────────────────────────────

server.registerTool(
  "stream_close",
  {
    description:
      "Close and clean up a streaming operation.",
    inputSchema: {
      stream_id: z.string().describe("Stream ID from stream_start"),
    },
  },
  ({ stream_id }) =>
    track(async () => {
      streamManager.close(stream_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ acknowledged: true }) }],
      };
    }),
);

// ─── get_entropy_bands ──────────────────────────────────────

server.registerTool(
  "get_entropy_bands",
  {
    description:
      "Analyze wavelet coefficient bands for entropy using libwce bit-cost estimation. " +
      "For each scale in the Ricker CWT, quantizes coefficients to integers, " +
      "computes Bit-Plane Counts, and estimates the encoding bit cost. " +
      "Higher bit cost = more structural irregularity at that scale. " +
      "This is a language-agnostic measure of local code complexity.",
    inputSchema: {
      file: z.string().describe("Absolute path to the file"),
      lossy_bits: z.number().int().min(0).max(8).default(0).describe(
        "LSBs to drop before BPC computation. 0 = full precision, 4-8 = coarser. Default 0.",
      ),
    },
  },
  ({ file, lossy_bits }) =>
    track(async () => {
      try {
        requireAbsoluteFile(file);
        const ctx = await getFileContext(file);
        const { coefficients, scales } = ctx.coefficients;

        const bands = [];
        for (let si = 0; si < scales.length; si++) {
          const coeffs = coefficients[si];
          // Quantize float coefficients to i32 range
          const maxAbs = coeffs.reduce((m, c) => Math.max(m, Math.abs(c)), 0);
          const scale = maxAbs > 0 ? (2147483647 / maxAbs) : 1;
          const intCoeffs: number[] = [];
          for (const c of coeffs) {
            intCoeffs.push(Math.round(c * scale));
          }
          // Pad to multiple of 4
          while (intCoeffs.length & 3) intCoeffs.push(0);

          const ent = computeBandEntropy(intCoeffs, lossy_bits);
          bands.push({
            scale: scales[si],
            bitCost: ent.bitCost,
            riceK: ent.riceK,
            predictor: ent.predictor,
            sparseFlag: ent.sparseFlag,
            numGroups: ent.numGroups,
          });
        }

        const totalBitCost = bands.reduce((s, b) => s + b.bitCost, 0);

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            bands,
            totalBitCost,
            meanBitCost: bands.length > 0 ? totalBitCost / bands.length : 0,
          }, null, 2) }],
        };
      } catch (err) {
        return toolErrorResponse(curateFsError(err));
      }
    }),
);

// ─── get_complexity_heatmap ─────────────────────────────────

server.registerTool(
  "get_complexity_heatmap",
  {
    description:
      "Compute a multi-scale complexity heatmap for a file using Haar DWT + libwce. " +
      "Decomposes the per-line structural signal, estimates encoding bit cost per detail band, " +
      "and returns per-line irregularity scores. Higher scores mark structurally dense/irregular regions. " +
      "Useful for: review prioritization (sort by entropy), context budgeting (keep irregular, summarize boilerplate), " +
      "and navigation (complement wavelet importance with a texture/regularity axis).",
    inputSchema: {
      file: z.string().describe("Absolute path to the file"),
      lossy_bits: z.number().int().min(0).max(8).default(0).describe(
        "LSBs to drop before BPC computation. 0 = full precision. Default 0.",
      ),
    },
  },
  ({ file, lossy_bits }) =>
    track(async () => {
      try {
        requireAbsoluteFile(file);
        const ctx = await getFileContext(file);
        const heatmap = computeComplexityHeatmap(ctx.signal, lossy_bits);

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            bands: heatmap.bands.map(b => ({
              level: b.level,
              span: b.span,
              bitCost: b.bitCost,
              riceK: b.riceK,
              predictor: b.predictor,
              sparseFlag: b.sparseFlag,
            })),
            totalEntropy: heatmap.totalEntropy,
            perLineIrregularity: heatmap.perLineIrregularity,
          }, null, 2) }],
        };
      } catch (err) {
        return toolErrorResponse(curateFsError(err));
      }
    }),
);

// ─── start ─────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("WaveScope MCP server running on stdio");

  // ─── Periodic cache cleanup (every 30s) ──────────────────────

  const CLEANUP_INTERVAL_MS = 30_000;
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    const fileEvicted = fileCache.evictExpired(now);
    const projectEvicted = evictExpiredProjects(now);
    const cursorEvicted = cursorManager.evictExpired(now);
    const streamEvicted = streamManager.evictExpired(now);
    if (fileEvicted > 0 || projectEvicted > 0 || cursorEvicted > 0 || streamEvicted > 0) {
      console.error(
        `[Cache] Evicted ${fileEvicted} file(s), ${projectEvicted} project(s), ${cursorEvicted} cursor(s), ${streamEvicted} stream(s)`,
      );
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  // ─── Memory watchdog (every 60s) ─────────────────────────────

  const HEAP_WARNING_MB = 400;
  const HEAP_CRITICAL_MB = 800;
  const WATCHDOG_INTERVAL_MS = 60_000;
  const memoryTimer = setInterval(() => {
    const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
    if (heapMB > HEAP_CRITICAL_MB) {
      console.error(
        `[Memory] Heap ${Math.round(heapMB)}MB > ${HEAP_CRITICAL_MB}MB critical, force-evicting 75%`,
      );
      fileCache.evictFraction(0.75);
      evictFractionProjects(0.75);
    } else if (heapMB > HEAP_WARNING_MB) {
      console.error(
        `[Memory] Heap ${Math.round(heapMB)}MB > ${HEAP_WARNING_MB}MB warning, force-evicting 25%`,
      );
      fileCache.evictFraction(0.25);
      evictFractionProjects(0.25);
    }
  }, WATCHDOG_INTERVAL_MS);
  memoryTimer.unref();

  // ─── Graceful shutdown ────────────────────────────────────────

  let shuttingDown = false;
  const shutdown = async (reason?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Shutting down${reason ? ` (${reason})` : ""}...`);

    clearInterval(cleanupTimer);
    clearInterval(memoryTimer);
    cursorManager.shutdown();
    streamManager.shutdown();

    // Wait up to 5s for in-flight handlers to complete
    const deadline = Date.now() + 5000;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.on("end", () => shutdown("stdin EOF"));
  process.stdin.on("close", () => shutdown("stdin closed"));
}

// Skip the server bootstrap when imported by tests.
if (!process.env.VITEST) {
  main().catch((err) => {
    console.error("Fatal error:", err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
}

// ─── Test-only exports ─────────────────────────────────────

export const __test_getFileContext = getFileContext;
export const __test_clearCache = () => fileCache.clear();
export const __test_cacheSize = () => fileCache.size;
export const __test_MAX_CACHE_ENTRIES = fileCache.maxEntries;
export const __test_cursorManager = cursorManager;
export const __test_streamManager = streamManager;
