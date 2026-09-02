import { execFile, execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve, isAbsolute, dirname, basename, join } from "node:path";

/**
 * Resolve a path to its canonical form. Falls back to canonicalizing the
 * parent directory and rejoining the basename when the file itself doesn't
 * exist on disk (e.g. it was deleted in the working tree), so containment
 * checks still see the right symlink-resolved parent on macOS where
 * `/var` is a symlink to `/private/var`.
 */
async function canonicalize(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const parent = dirname(p);
    if (parent && parent !== p) {
      try {
        return join(await realpath(parent), basename(p));
      } catch {
        // Parent also unresolvable — fall through to lexical resolve.
      }
    }
    return resolve(p);
  }
}

/**
 * Read a file's content at a specific git ref.
 *
 * @param repoPath - Absolute path to the git repository root
 * @param filePath - Path to the file (absolute or repo-relative)
 * @param ref - Git ref (e.g. "HEAD", "HEAD~1", "main", a commit SHA)
 * @returns File content as a string
 * @throws If git fails (invalid ref, file not found at ref, not a git repo, etc.)
 */
export async function readFileAtRef(
  repoPath: string,
  filePath: string,
  ref: string,
): Promise<string> {
  // Reject refs that start with '-' to prevent git option injection.
  if (ref.startsWith("-")) {
    throw new Error(`Invalid ref "${ref}": refs must not start with '-'`);
  }

  // Canonicalize via realpath so the containment check survives symlinks
  // (e.g. macOS /var → /private/var). The relative path passed to `git
  // show` is also computed against the canonical repo root, which matches
  // how `git rev-parse --show-toplevel` reports paths.
  const normalizedRepo = await canonicalize(repoPath);
  const absFile = isAbsolute(filePath)
    ? await canonicalize(filePath)
    : resolve(normalizedRepo, filePath);
  const relPath = relative(normalizedRepo, absFile);

  // Reject paths that escape the repository root.
  if (relPath.startsWith("..") || isAbsolute(relPath)) {
    throw new Error(`File "${filePath}" is outside the repository`);
  }

  const spec = `${ref}:${relPath}`;

  return new Promise<string>((resolvePromise, reject) => {
    execFile(
      "git",
      ["show", spec],
      {
        cwd: normalizedRepo,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf-8",
        // Force English stderr so callers can pattern-match
        // "missing at ref" reliably regardless of user locale.
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      },
      (err, stdout) => {
        if (err) {
          const msg = (err as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? `File too large (exceeds 10 MB buffer): ${spec}`
            : `git show ${spec}: ${err.message}`;
          reject(new Error(msg));
        } else if (stdout.includes("\x00")) {
          reject(new Error(`Binary file (NUL byte detected): ${spec}`));
        } else {
          resolvePromise(stdout);
        }
      },
    );
  });
}

/**
 * Read a file at a ref, returning null when the file does not exist at that
 * ref (but the ref itself is valid). Other errors — invalid ref, not a repo,
 * binary file, oversize — propagate as before.
 *
 * Distinguishes git's two "missing at ref" stderr forms:
 *   - "path '...' exists on disk, but not in '<ref>'"
 *   - "path '...' does not exist in '<ref>'"
 */
export async function tryReadFileAtRef(
  repoPath: string,
  filePath: string,
  ref: string,
): Promise<string | null> {
  try {
    return await readFileAtRef(repoPath, filePath, ref);
  } catch (err) {
    const msg = (err as Error).message || "";
    // Anchor to git's `fatal: path '...'` prefix to avoid swallowing
    // unrelated errors that happen to contain "does not exist in".
    if (/fatal: path '.+?' (exists on disk, but not in |does not exist in )/.test(msg)) {
      return null;
    }
    throw err;
  }
}

/**
 * Find the git repository root for a given path.
 * Uses `git rev-parse --show-toplevel`.
 *
 * @param startPath - Path to start searching from (file or directory)
 * @returns Absolute path to the git repository root
 * @throws If the path is not inside a git repository
 */
export function findGitRoot(startPath: string): string {
  const p = resolve(startPath);

  // Try from the path itself first (handles directories), then from its parent.
  for (const dir of [p, dirname(p)]) {
    try {
      return execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: dir,
        encoding: "utf-8",
        // Discard git's stderr. Probing a directory that is not a
        // repository is an expected step here, not a failure, but
        // execFileSync inherits stderr by default, so each probe printed a
        // raw "fatal: not a git repository" line. This server logs to
        // stderr, so those lines read as real errors for any file outside
        // a repository. The thrown Error below is the reported failure.
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // Not a git repo at this level, try next
    }
  }

  throw new Error(
    `Not a git repository (or git not found): could not find git root from ${startPath}`,
  );
}
