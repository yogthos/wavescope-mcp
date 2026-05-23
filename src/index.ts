#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { FileContext } from "./context.js";
import { ProjectIndex } from "./project.js";

const fileCache = new Map<string, { ctx: FileContext; ts: number }>();
const CACHE_TTL = 60_000; // 60 seconds

function norm(path: string): string {
  return resolve(path);
}

async function getFileContext(
  filePath: string,
): Promise<FileContext> {
  const key = norm(filePath);
  const cached = fileCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.ctx;

  const content = await readFile(filePath, "utf-8");
  const ctx = new FileContext(filePath, content);
  fileCache.set(key, { ctx, ts: Date.now() });
  return ctx;
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
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
        "Total range to consider (before + after center). Default 300.",
      ),
    },
  },
  async ({ file, center, radius }) => {
    try {
      const ctx = await getFileContext(file);
      const result = ctx.queryWaveletContext(center, radius);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return errorResult(
        `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
);

// ─── get_important_positions ───────────────────────────────

server.registerTool(
  "get_important_positions",
  {
    description:
      "Find structurally important positions (class/function boundaries, imports, etc.) " +
      "in a file or directory. Returns positions sorted by wavelet coefficient magnitude. " +
      "Use this to navigate to key structural boundaries.",
    inputSchema: {
      file: z.string().optional().describe(
        "Absolute path to a single file. Conflicts with 'directory'.",
      ),
      directory: z.string().optional().describe(
        "Absolute path to a project directory. Conflicts with 'file'.",
      ),
      min_coefficient: z.number().min(0).max(10).default(0.3).describe(
        "Minimum wavelet coefficient threshold (0-10). Lower = more results. Default 0.3.",
      ),
      limit: z.number().int().min(1).max(100).default(20).describe(
        "Maximum number of positions to return. Default 20.",
      ),
    },
  },
  async ({ file, directory, min_coefficient, limit }) => {
    if (file && directory) {
      return errorResult(
        "Error: provide either 'file' or 'directory', not both.",
      );
    }

    let positions;

    try {
      if (directory) {
        const project = await ProjectIndex.load(norm(directory));
        positions = project.getImportantPositions(min_coefficient, limit);
      } else if (file) {
        const ctx = await getFileContext(file);
        positions = ctx.getImportantPositions(min_coefficient, limit);
      } else {
        return errorResult(
          "Error: provide either 'file' or 'directory' parameter.",
        );
      }
    } catch (err) {
      return errorResult(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      content: [{ type: "text", text: JSON.stringify(positions, null, 2) }],
    };
  },
);

// ─── get_wavelet_coefficients ──────────────────────────────

server.registerTool(
  "get_wavelet_coefficients",
  {
    description:
      "Get raw wavelet coefficients for a range of lines at a specific scale. " +
      "Scales: 1-2 (fine/detailed), 4-16 (medium), 32-128 (coarse/overview). " +
      "Use this for custom analysis or debugging.",
    inputSchema: {
      file: z.string().describe("Absolute path to the file"),
      start: z.number().int().min(0).describe(
        "Start line (0-indexed, inclusive)",
      ),
      end: z.number().int().min(0).describe(
        "End line (0-indexed, inclusive)",
      ),
      scale: z.number().int().min(1).max(128).default(2).describe(
        "Wavelet scale. 1-2: fine, 4-16: medium, 32-128: coarse.",
      ),
    },
  },
  async ({ file, start, end, scale }) => {
    try {
      const ctx = await getFileContext(file);
      const coeffs = ctx.getWaveletCoefficients(start, end, scale);
      return {
        content: [{ type: "text", text: JSON.stringify(coeffs, null, 2) }],
      };
    } catch (err) {
      return errorResult(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
);

// ─── get_summary_at_scale ──────────────────────────────────

server.registerTool(
  "get_summary_at_scale",
  {
    description:
      "Get a compressed/summarized view of a region using wavelet peaks at a given scale. " +
      "Larger scales give coarser summaries. Use this to get an overview of a region without " +
      "loading all the details.",
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
  async ({ file, start, end, scale }) => {
    try {
      const ctx = await getFileContext(file);
      const summary = ctx.getSummaryAtScale(start, end, scale);
      return {
        content: [{ type: "text", text: summary }],
      };
    } catch (err) {
      return errorResult(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
);

// ─── start ─────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("WaveScope MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
