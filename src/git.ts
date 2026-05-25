import { execFile, execFileSync } from "node:child_process";
import { relative, resolve, isAbsolute, dirname, sep } from "node:path";

/**
 * Read a file's content at a specific git ref.
 *
 * @param repoPath - Absolute path to the git repository root
 * @param filePath - Path to the file (absolute or repo-relative)
 * @param ref - Git ref (e.g. "HEAD", "HEAD~1", "main", a commit SHA)
 * @returns File content as a string
 * @throws If git fails (invalid ref, file not found at ref, not a git repo, etc.)
 */
export function readFileAtRef(
  repoPath: string,
  filePath: string,
  ref: string,
): Promise<string> {
  // Reject refs that start with '-' to prevent git option injection.
  if (ref.startsWith("-")) {
    return Promise.reject(
      new Error(`Invalid ref "${ref}": refs must not start with '-'`),
    );
  }

  const normalizedRepo = resolve(repoPath);
  const absFile = resolve(filePath);
  const relPath = isAbsolute(filePath)
    ? relative(normalizedRepo, absFile)
    : filePath;

  // Reject paths that escape the repository root.
  const resolvedRel = resolve(normalizedRepo, relPath);
  if (!resolvedRel.startsWith(normalizedRepo + sep) && resolvedRel !== normalizedRepo) {
    return Promise.reject(
      new Error(`File "${filePath}" is outside the repository`),
    );
  }

  const spec = `${ref}:${relPath}`;

  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["show", spec],
      { cwd: normalizedRepo, maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" },
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
      }).trim();
    } catch {
      // Not a git repo at this level, try next
    }
  }

  throw new Error(
    `Not a git repository (or git not found): could not find git root from ${startPath}`,
  );
}
