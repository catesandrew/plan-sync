import { execFileSync } from "node:child_process";

/**
 * Resolves the git repository's top-level directory containing `cwd`, so
 * that any `plan-sync` command run from a subdirectory of the anchor repo
 * resolves the exact same `.omc/` content root — and therefore the same
 * shadow-track project-id and ref — as running it from the repo root
 * itself.
 *
 * Falls back to returning `cwd` unchanged when `cwd` is not inside a git
 * repository at all (e.g. an isolated non-git fixture), so callers still
 * get a usable root rather than a thrown error.
 */
export function resolveRepoRoot(cwd: string = process.cwd()): string {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}
