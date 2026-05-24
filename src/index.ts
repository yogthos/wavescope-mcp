#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { FileContext } from "./context.js";
import { ProjectIndex } from "./project.js";

interface CacheEntry {
  ctx: FileContext;
  ts: number;
  mtimeMs: number;
}

const fileCache = new Map<string, CacheEntry>();
const CACHE_TTL = 60_000;
const MAX_CACHE_ENTRIES = 200;

function norm(path: string): string {
  return resolve(path);
}

function evictCache() {
  if (fileCache.size > MAX_CACHE_ENTRIES) {
    const entries = [...fileCache.entries()].sort(
      (a, b) => a[1].ts - b[1].ts,
    );
    const toDelete = entries.slice(0, fileCache.size - MAX_CACHE_ENTRIES);
    for (const [key] of toDelete) fileCache.delete(key);
  }
}

async function getFileContext(filePath: string): Promise<FileContext> {
  const key = norm(filePath);
  const st = await stat(key);
  const mtimeMs = st.mtimeMs;
  const cached = fileCache.get(key);
  if (
    cached &&
    Date.now() - cached.ts < CACHE_TTL &&
    cached.mtimeMs === mtimeMs
  ) {
    return cached.ctx;
  }

  const content = await readFile(key, "utf-8");
  const ctx = new FileContext(key, content);
  fileCache.set(key, { ctx, ts: Date.now(), mtimeMs });
  evictCache();
  return ctx;
}

// ─── Curated error helpers ───────────────────────────────────

class ToolError extends Error {}

function toolErrorResponse(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function curateFsError(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOENT") return "File not found";
  if (e?.code === "EACCES") return "Permission denied";
  if (e?.code === "EISDIR") return "Expected a file, got a directory";
  if (err instanceof ToolError) return err.message;
  return "Internal error";
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
      min_coefficient: z.number().min(0).max(10).default(0.3).describe(
        "Minimum wavelet coefficient threshold (0-10). Lower = more results. Default 0.3.",
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
        if (directory) {
          const project = await ProjectIndex.load(norm(directory));
          positions = project.getImportantPositions(min_coefficient, limit);
        } else {
          const ctx = await getFileContext(file!);
          positions = ctx.getImportantPositions(min_coefficient, limit);
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(positions, null, 2) }],
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

// ─── start ─────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("WaveScope MCP server running on stdio");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("Shutting down...");
    // Wait up to 5s for in-flight handlers to complete
    const deadline = Date.now() + 5000;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
export const __test_MAX_CACHE_ENTRIES = MAX_CACHE_ENTRIES;
