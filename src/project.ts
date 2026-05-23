import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename, extname, relative } from "node:path";
import { FileContext, ImportantPosition } from "./context.js";

const CODE_EXTENSIONS = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".clj",
  ".cljs",
  ".edn",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  ".env",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  "coverage",
  ".pytest_cache",
]);

export interface ProjectFile {
  filename: string;
  path: string;
  context: FileContext;
}

// ─── Project cache (simple TTL) ─────────────────────────────

const CACHE_TTL_MS = 30_000; // 30 seconds

interface CacheEntry {
  project: ProjectIndex;
  timestamp: number;
}

const projectCache = new Map<string, CacheEntry>();

// ─── ProjectIndex ───────────────────────────────────────────

/** File-size weighting constant: files shorter than this get penalized. */
const FILE_SIZE_ADJUSTMENT = 30;

/**
 * Project-level wavelet index across multiple files.
 *
 * Results are cached with a 30-second TTL to avoid expensive
 * re-indexing on repeated calls.
 */
export class ProjectIndex {
  readonly root: string;
  readonly files: ProjectFile[];
  private fileMap: Map<string, FileContext>;

  private constructor(root: string, files: ProjectFile[]) {
    this.root = root;
    this.files = files;
    // Use relative path from root as key to avoid filename collisions
    this.fileMap = new Map(
      files.map((f) => {
        const relPath = relative(root, f.path);
        return [relPath, f.context];
      }),
    );
  }

  static async load(root: string): Promise<ProjectIndex> {
    // Check cache
    const cached = projectCache.get(root);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.project;
    }

    const files = await discoverFiles(root);
    const project = new ProjectIndex(root, files);

    projectCache.set(root, { project, timestamp: Date.now() });
    return project;
  }

  /**
   * Look up a file context by relative path (e.g., "src/utils.ts").
   */
  getFile(relPath: string): FileContext | null {
    return this.fileMap.get(relPath) ?? null;
  }

  /**
   * List all indexed files as relative paths from the project root.
   */
  listFiles(): string[] {
    return this.files.map((f) => relative(this.root, f.path));
  }

  /**
   * Project-wide important positions across all files.
   *
   * Per-file coefficients are normalized to [0, 1] against the file's
   * own max, then multiplied by a file-size weight w(n) = 1 - e^(-n/30)
   * to penalize tiny files whose lone peaks would otherwise be inflated.
   */
  getImportantPositions(
    minCoefficient: number = 0.3,
    limit: number = 30,
  ): ImportantPosition[] {
    const allPeaks: (ImportantPosition & { filename: string })[] = [];

    for (const file of this.files) {
      const peaks = file.context.getImportantPositions(0.0, 100);
      const fileRelPath = relative(this.root, file.path);

      // Per-file normalization (max = 1.0) combined with file-size weighting
      // to prevent small files from contributing peaks with inflated scores.
      const maxCoeff = peaks.reduce(
        (m, p) => Math.max(m, Math.abs(p.coefficient)),
        0,
      );
      const fileWeight = 1 - Math.exp(
        -file.context.lineCount / FILE_SIZE_ADJUSTMENT,
      );

      for (const p of peaks) {
        const rawNormCoeff = maxCoeff > 0
          ? Math.abs(p.coefficient) / maxCoeff
          : 0;
        const normCoeff = rawNormCoeff * fileWeight * Math.sign(p.coefficient);

        if (Math.abs(normCoeff) < minCoefficient) continue;

        allPeaks.push({
          ...p,
          coefficient: normCoeff,
          label: `${p.label} (${fileRelPath})`,
          filename: fileRelPath,
        });
      }
    }

    // Merge and sort by normalized coefficient
    allPeaks.sort(
      (a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient),
    );

    return allPeaks.slice(0, limit);
  }
}

// ─── File discovery ─────────────────────────────────────────

async function discoverFiles(root: string): Promise<ProjectFile[]> {
  const results: ProjectFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);

      if (SKIP_DIRS.has(entry)) continue;

      let fileStat;
      try {
        fileStat = await stat(fullPath);
      } catch {
        continue;
      }

      if (fileStat.isDirectory()) {
        await walk(fullPath);
      } else if (fileStat.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          try {
            const content = await readFile(fullPath, "utf-8");
            results.push({
              filename: basename(entry),
              path: fullPath,
              context: new FileContext(basename(entry), content),
            });
          } catch {
            // Skip unreadable files
          }
        }
      }
    }
  }

  await walk(root);
  return results;
}
