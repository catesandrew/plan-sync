import * as path from "node:path";
import { hasHelpFlag, parseFlag } from "../args";
import { addToManifest, defaultManifestPath } from "../manifest";
import { expandGlobUnderRoot } from "../glob";
import { resolveRepoRoot } from "../repo-root";
import { resolveRootDir } from "../root";

const HELP_TEXT = `Usage: plan-sync allow <path-or-glob> [<path-or-glob> ...] [--root <dir>]

Adds one or more paths (or glob patterns) to the sync manifest.

Flags:
  --root <dir>  Root directory to sync (optional, e.g. ".omc")
`;

/**
 * `plan-sync allow <path-or-glob> [<path-or-glob> ...] [--root <dir>]`
 *
 * Accepts one or more targets in a single call. Every target is added to
 * the manifest exactly once, VERBATIM, as a single manifest line, via
 * `addToManifest` — regardless of whether it contains glob metacharacters
 * (`*`, `?`, `[`). There is no glob-expansion-into-N-literal-matches step
 * here, and no literal-vs-pattern branch: every manifest entry is always
 * re-evaluated as a glob pattern later, at push/status time (see
 * `resolveManifestPaths` in `src/manifest.ts`). A literal filename like
 * `notes.md` is just a degenerate pattern with no metacharacters — it
 * already only matches itself, so nothing special is needed for it here.
 *
 * The current match count under `.omc/` is still reported for user
 * feedback, purely informational — it is never written to the manifest —
 * via `expandGlobUnderRoot` (the same symlink-safe walk used at push/status
 * time). A pattern entry that currently matches zero files is still added:
 * it may start matching later, since it's re-evaluated live on every
 * push/status.
 */
export function run(args: string[]): void {
  if (hasHelpFlag(args)) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const { value: rootFlag, rest } = parseFlag(args, "root");
  if (rest.length === 0) {
    throw new Error("allow: <path> argument is required");
  }

  const repoRoot = resolveRepoRoot();
  const rootDir = resolveRootDir(repoRoot, rootFlag);
  const manifestPath = defaultManifestPath(repoRoot, rootDir);

  for (const target of rest) {
    processTarget(manifestPath, target);
  }
}

function processTarget(manifestPath: string, target: string): void {
  addToManifest(manifestPath, target);

  const omcRoot = path.dirname(manifestPath);
  const matchCount = expandGlobUnderRoot(omcRoot, target).length;
  process.stdout.write(
    `plan-sync: allow: '${target}' added (currently matches ${matchCount} file(s))\n`,
  );
}
