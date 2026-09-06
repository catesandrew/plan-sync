import { parseFlag } from "../args";
import { defaultManifestPath, readManifest, removeFromManifest } from "../manifest";
import { hasGlobMeta, globToRegExp } from "../glob";
import { resolveRepoRoot } from "../repo-root";
import { resolveRootDir } from "../root";

/**
 * `plan-sync unallow <path-or-glob> [<path-or-glob> ...] [--root <dir>]`
 *
 * Removes one or more entries from the manifest — the counterpart to
 * `allow`. Accepts multiple targets in a single call, each processed
 * independently, in order.
 *
 * A literal target removes that exact manifest entry (a no-op, not an
 * error, if it wasn't present).
 *
 * A pattern containing `*`, `?`, or `[` is matched against the manifest's
 * CURRENT entries (not the filesystem — unlike `allow`, a path may already
 * have been deleted from disk while still listed, and `unallow` must still
 * be able to remove it), and every matching entry is removed.
 */
export function run(args: string[]): void {
  const { value: rootFlag, rest } = parseFlag(args, "root");
  if (rest.length === 0) {
    throw new Error("unallow: <path> argument is required");
  }

  const repoRoot = resolveRepoRoot();
  const rootDir = resolveRootDir(repoRoot, rootFlag);
  const manifestPath = defaultManifestPath(repoRoot, rootDir);

  for (const target of rest) {
    processTarget(manifestPath, target);
  }
}

function processTarget(manifestPath: string, target: string): void {
  if (!hasGlobMeta(target)) {
    const removed = removeFromManifest(manifestPath, target);
    if (!removed) {
      process.stderr.write(
        `plan-sync: unallow: '${target}' was not in the manifest (no-op)\n`,
      );
    }
    return;
  }

  const pattern = globToRegExp(target);
  const matches = readManifest(manifestPath).filter((entry) => pattern.test(entry));

  if (matches.length === 0) {
    process.stderr.write(
      `plan-sync: unallow: pattern '${target}' matched no manifest entries\n`,
    );
    return;
  }

  for (const entry of matches) {
    removeFromManifest(manifestPath, entry);
  }

  process.stdout.write(
    `plan-sync: unallow: pattern '${target}' removed ${matches.length} manifest entr${matches.length === 1 ? "y" : "ies"}\n`,
  );
}
