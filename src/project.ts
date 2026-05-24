import { readdir, readFile, lstat, stat, realpath } from "node:fs/promises";
import { open } from "node:fs/promises";
import { join, basename, extname, relative, resolve, sep } from "node:path";
import { FileContext, ImportantPosition } from "./context.js";
import { FileCache } from "./file-cache.js";
import { configs } from "./language.js";

const CODE_EXTENSIONS = new Set(
  configs.flatMap((c) => c.extensions),
);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  "coverage",
  ".pytest_cache",
  ".cache",
  ".idea",
  ".vscode",
  "vendor",
  "out",
  "obj",
  ".gradle",
  ".tox",
  ".mypy_cache",
  ".ruff_cache",
  "bower_components",
  ".serverless",
  ".terraform",
  ".eggs",
  "site-packages",
  ".yarn",
  ".parcel-cache",
  "__snapshots__",
]);

export const MAX_FILE_BYTES = 2_000_000;
export const MAX_FILES = 5_000;
const BINARY_SNIFF_BYTES = 4096;

export interface ProjectFile {
  filename: string;
  path: string;
  context: FileContext;
}

// ─── Project cache (TTL + LRU eviction) ─────────────────────

const CACHE_TTL_MS = 60_000;
const MAX_PROJECT_CACHE = 20;

interface CacheEntry {
  project: ProjectIndex;
  timestamp: number;
}

const projectCache = new Map<string, CacheEntry>();
const pendingLoads = new Map<string, Promise<ProjectIndex>>();

function evictProjectCache() {
  if (projectCache.size > MAX_PROJECT_CACHE) {
    const entries = [...projectCache.entries()].sort(
      (a, b) => a[1].timestamp - b[1].timestamp,
    );
    const toDelete = entries.slice(0, projectCache.size - MAX_PROJECT_CACHE);
    for (const [key] of toDelete) projectCache.delete(key);
  }
}

/**
 * Remove project cache entries whose timestamp is older than TTL.
 * Exported for the periodic cleanup sweep in the server entry point.
 */
export function evictExpiredProjects(now: number = Date.now()): number {
  let count = 0;
  for (const [key, entry] of projectCache) {
    if (now - entry.timestamp >= CACHE_TTL_MS) {
      projectCache.delete(key);
      count++;
    }
  }
  return count;
}

/**
 * Force-evict the oldest `fraction` of project cache entries.
 * Exported for the memory watchdog in the server entry point.
 */
export function evictFractionProjects(fraction: number): number {
  if (projectCache.size === 0) return 0;
  const capped = Math.min(Math.max(fraction, 0), 1);
  const toEvict = Math.max(1, Math.floor(projectCache.size * capped));
  const entries = [...projectCache.entries()].sort(
    (a, b) => a[1].timestamp - b[1].timestamp,
  );
  let count = 0;
  for (let i = 0; i < toEvict && i < entries.length; i++) {
    projectCache.delete(entries[i][0]);
    count++;
  }
  return count;
}

/** Exported for tests */
export function __test_clearProjectCache(): void {
  projectCache.clear();
}

/** Exported for tests */
export function __test_projectCacheSize(): number {
  return projectCache.size;
}

// ─── ProjectIndex ───────────────────────────────────────────

/**
 * Project-level wavelet index across multiple files.
 *
 * Results are cached with a 60-second TTL to avoid expensive
 * re-indexing on repeated calls.
 */
export class ProjectIndex {
  readonly root: string;
  readonly files: ProjectFile[];
  /** True when discovery stopped at MAX_FILES — index is incomplete. */
  readonly truncated: boolean;
  private fileMap: Map<string, FileContext>;

  private constructor(root: string, files: ProjectFile[], truncated: boolean) {
    this.root = root;
    this.files = files;
    this.truncated = truncated;
    this.fileMap = new Map(
      files.map((f) => {
        const relPath = relative(root, f.path);
        return [relPath, f.context];
      }),
    );
  }

  static async load(
    root: string,
    fileCache?: FileCache,
  ): Promise<ProjectIndex> {
    const resolved = resolve(root);

    const cached = projectCache.get(resolved);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.project;
    }

    const pending = pendingLoads.get(resolved);
    if (pending) return pending;

    const loadPromise = (async () => {
      try {
        const { files, truncated } = await discoverFiles(resolved, fileCache);
        const project = new ProjectIndex(resolved, files, truncated);
        evictProjectCache();
        projectCache.set(resolved, { project, timestamp: Date.now() });
        return project;
      } finally {
        pendingLoads.delete(resolved);
      }
    })();

    pendingLoads.set(resolved, loadPromise);
    return loadPromise;
  }

  getFile(relPath: string): FileContext | null {
    return this.fileMap.get(relPath) ?? null;
  }

  listFiles(): string[] {
    return this.files.map((f) => relative(this.root, f.path));
  }

  /**
   * Project-wide important positions across all files.
   *
   * Uses raw absolute wavelet coefficients (same semantics as
   * single-file `FileContext.getImportantPositions`) so that
   * `minCoefficient` means the same thing in both modes.
   */
  getImportantPositions(
    minCoefficient: number = 0.3,
    limit: number = 20,
  ): ImportantPosition[] {
    const allPeaks: (ImportantPosition & { filename: string })[] = [];

    for (const file of this.files) {
      const peaks = file.context.getImportantPositions(
        minCoefficient,
        Math.max(limit, 30),
      );
      if (peaks.length === 0) continue;
      const fileRelPath = relative(this.root, file.path);
      for (const p of peaks) {
        allPeaks.push({
          ...p,
          label: `${p.label} (${fileRelPath})`,
          filename: fileRelPath,
        });
      }
    }

    allPeaks.sort(
      (a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient),
    );

    return allPeaks.slice(0, limit);
  }
}

// ─── .gitignore parser (minimal) ────────────────────────────

interface GitignoreRule {
  /** Pre-compiled regex matched against the path relative to gitignore root. */
  regex: RegExp;
  /** True if the rule only matches directories (pattern ends with `/`). */
  dirOnly: boolean;
}

async function loadGitignore(root: string): Promise<GitignoreRule[]> {
  const path = join(root, ".gitignore");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const rules: GitignoreRule[] = [];
  for (const lineRaw of raw.split("\n")) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const dirOnly = line.endsWith("/");
    const pat = dirOnly ? line.slice(0, -1) : line;
    rules.push({ regex: compileGlob(pat), dirOnly });
  }
  return rules;
}

function compileGlob(pat: string): RegExp {
  // Anchor: leading `/` means root-relative; otherwise match any depth.
  const anchored = pat.startsWith("/");
  const body = anchored ? pat.slice(1) : pat;

  let regex = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "*" && body[i + 1] === "*") {
      regex += ".*";
      i += 2;
      if (body[i] === "/") i++;
    } else if (c === "*") {
      regex += "[^/]*";
      i++;
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if (".+()[]{}^$|\\".includes(c)) {
      regex += "\\" + c;
      i++;
    } else {
      regex += c;
      i++;
    }
  }

  const prefix = anchored ? "^" : "(^|/)";
  return new RegExp(`${prefix}${regex}(/|$)`);
}

function isIgnored(
  relPath: string,
  isDir: boolean,
  rules: GitignoreRule[],
): boolean {
  const normalized = relPath.split(sep).join("/");
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.regex.test(normalized)) return true;
    // Also test path with trailing slash for dir-only rules
    if (rule.dirOnly && rule.regex.test(normalized + "/")) return true;
  }
  return false;
}

// ─── File discovery ─────────────────────────────────────────

interface DiscoverResult {
  files: ProjectFile[];
  truncated: boolean;
}

/**
 * Sniff the first BINARY_SNIFF_BYTES for NUL bytes — the standard
 * heuristic for distinguishing text from binary files.
 */
async function isBinary(fullPath: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(fullPath, "r");
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, BINARY_SNIFF_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return true;
  } finally {
    await fh?.close();
  }
}

async function discoverFiles(
  root: string,
  fileCache?: FileCache,
): Promise<DiscoverResult> {
  const results: ProjectFile[] = [];
  const visitedRealpaths = new Set<string>();
  let rootRealpath: string;
  try {
    rootRealpath = await realpath(root);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const wrapped = new Error(`Cannot read directory: ${root}`);
    (wrapped as NodeJS.ErrnoException).code = e.code;
    throw wrapped;
  }
  visitedRealpaths.add(rootRealpath);

  const gitignore = await loadGitignore(root);
  let truncated = false;

  // Concurrency-bounded file processor
  const pending: Array<{ fullPath: string; size: number; mtimeMs: number }> = [];

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (truncated) return;
      const fullPath = join(dir, entry);
      const relPath = relative(root, fullPath);

      let entryStat;
      try {
        entryStat = await lstat(fullPath);
      } catch {
        continue;
      }

      // Resolve symlinks: follow them, but refuse ones that escape the
      // root. Dedup happens below in the dir/file branches via realpath.
      if (entryStat.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(fullPath);
        } catch {
          continue;
        }
        if (!target.startsWith(rootRealpath + sep) && target !== rootRealpath) {
          continue;
        }
        try {
          entryStat = await stat(target);
        } catch {
          continue;
        }
      }

      if (entryStat.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        if (isIgnored(relPath, true, gitignore)) continue;
        let dirReal: string;
        try {
          dirReal = await realpath(fullPath);
        } catch {
          continue;
        }
        if (visitedRealpaths.has(dirReal)) continue;
        visitedRealpaths.add(dirReal);
        await walk(fullPath);
      } else if (entryStat.isFile()) {
        if (isIgnored(relPath, false, gitignore)) continue;
        const ext = extname(entry).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext)) continue;
        if (entryStat.size > MAX_FILE_BYTES) continue;
        if (results.length + pending.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        pending.push({ fullPath, size: entryStat.size, mtimeMs: entryStat.mtimeMs });
      }
    }
  }

  await walk(root);

  // Parallel binary-sniff + read + FileContext construction with bounded pool
  const CONCURRENCY = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const idx = cursor++;
      const { fullPath, mtimeMs } = pending[idx];
      if (await isBinary(fullPath)) continue;
      let content: string;
      try {
        content = await readFile(fullPath, "utf8");
      } catch {
        continue;
      }
      const ctx = new FileContext(basename(fullPath), content);
      results.push({
        filename: basename(fullPath),
        path: fullPath,
        context: ctx,
      });
      if (fileCache) {
        fileCache.put(fullPath, ctx, mtimeMs);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()),
  );

  return { files: results, truncated };
}
