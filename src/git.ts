import { execFile, execFileSync } from "node:child_process";
import { relative, resolve, isAbsolute, dirname } from "node:path";

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
  const normalizedRepo = resolve(repoPath);
  const relPath = isAbsolute(filePath)
    ? relative(normalizedRepo, filePath)
    : filePath;

  const spec = `${ref}:${relPath}`;

  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["show", spec],
      { cwd: normalizedRepo, maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" },
      (err, stdout) => {
        if (err) {
          reject(new Error(`git show ${spec}: ${err.message}`));
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
  const dir = isAbsolute(startPath)
    ? dirname(resolve(startPath))
    : resolve(startPath);

  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf-8",
    }).trim();
  } catch {
    throw new Error(
      `Not a git repository (or git not found): could not find git root from ${startPath}`,
    );
  }
}
