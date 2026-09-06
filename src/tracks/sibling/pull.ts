import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { readManifest, defaultManifestPath } from "../../manifest";
import { resolveRepoRoot } from "../../repo-root";
import { safeCopyFile, safeRemove } from "../../safe-write";
import { siblingConfigPath, type SiblingConfig } from "./init";

function readSiblingConfig(repoRoot: string): SiblingConfig {
  const configPath = siblingConfigPath(repoRoot);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `pull --track sibling: no sibling config found at ${configPath} — run \`omc-sync init --track sibling\` first`,
    );
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    sibling?: SiblingConfig;
  };
  if (!raw.sibling) {
    throw new Error(
      `pull --track sibling: ${configPath} has no "sibling" entry — run \`omc-sync init --track sibling\` first`,
    );
  }

  return raw.sibling;
}

function currentBranch(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    stdio: "pipe",
  })
    .toString()
    .trim();
}

/**
 * For each manifest-listed path: if it exists in the sibling clone, copy it
 * into the anchor repo's `.omc/`; if it does not (deleted upstream), remove
 * it from the anchor repo's `.omc/` if present there. This is the entire
 * deletion-propagation mechanism — no tree-diff engine, just "does the
 * manifest-listed path exist in the clone or not" (per the plan's design
 * point that ordinary git semantics, not bespoke reconciliation, should
 * handle this).
 */
function syncManifestFilesFromClone(
  repoRoot: string,
  clonePath: string,
  manifestPaths: string[],
): void {
  const omcRoot = path.join(repoRoot, ".omc");

  for (const relPath of manifestPaths) {
    const src = path.join(clonePath, relPath);
    const dest = path.join(repoRoot, ".omc", relPath);

    if (!fs.existsSync(src)) {
      // Removed upstream (deletion propagation) — remove the anchor repo's
      // copy too, if present.
      safeRemove(omcRoot, dest);
      continue;
    }

    if (fs.lstatSync(src).isSymbolicLink()) {
      process.stderr.write(
        `omc-sync: skipping symlink ${relPath} — symlinks are not synced\n`,
      );
      continue;
    }

    safeCopyFile(omcRoot, src, dest);
  }
}

export function run(_args: string[]): void {
  const repoRoot = resolveRepoRoot();
  const { clonePath } = readSiblingConfig(repoRoot);
  const branch = currentBranch(clonePath);

  try {
    execFileSync("git", ["pull", "--rebase", "origin", branch], {
      cwd: clonePath,
      stdio: "pipe",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `pull --track sibling: merge conflict during rebase — resolve manually in ${clonePath} then re-run\n${detail}`,
    );
  }

  const manifestPaths = readManifest(defaultManifestPath(repoRoot));
  syncManifestFilesFromClone(repoRoot, clonePath, manifestPaths);
}
