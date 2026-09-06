import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveManifestSyncCandidates, defaultManifestPath, MANIFEST_FILENAME } from "../../manifest";
import { resolveRepoRoot } from "../../repo-root";
import { safeCopyFile, safeRemove } from "../../safe-write";
import { siblingConfigPath, type SiblingConfig } from "./init";

function readSiblingConfig(repoRoot: string): SiblingConfig {
  const configPath = siblingConfigPath(repoRoot);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `push --track sibling: no sibling config found at ${configPath} — run \`omc-sync init --track sibling\` first`,
    );
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    sibling?: SiblingConfig;
  };
  if (!raw.sibling) {
    throw new Error(
      `push --track sibling: ${configPath} has no "sibling" entry — run \`omc-sync init --track sibling\` first`,
    );
  }

  return raw.sibling;
}

function copyManifestFiles(
  repoRoot: string,
  clonePath: string,
  manifestPaths: string[],
): void {
  for (const relPath of manifestPaths) {
    const src = path.join(repoRoot, ".omc", relPath);
    const dest = path.join(clonePath, relPath);

    if (!fs.existsSync(src)) {
      // Source was removed from `.omc/` (deletion propagation) — remove the
      // clone's copy too, if present, so the subsequent `git add` below
      // stages the deletion via ordinary git semantics.
      safeRemove(clonePath, dest);
      continue;
    }

    if (fs.lstatSync(src).isSymbolicLink()) {
      process.stderr.write(
        `omc-sync: skipping symlink ${relPath} — symlinks are not synced\n`,
      );
      continue;
    }

    safeCopyFile(clonePath, src, dest);
  }
}

/**
 * Filters manifest paths down to the ones actually worth passing to `git
 * add`: paths that currently exist in the clone (new/modified content) or
 * that are already tracked by git (so a since-removed file's deletion gets
 * staged). Excludes paths that are neither present nor tracked — e.g. a
 * manifest entry whose deletion was already synced and committed on a prior
 * push — since `git add` errors on a pathspec that matches nothing.
 */
function stageableManifestPaths(
  clonePath: string,
  manifestPaths: string[],
): string[] {
  return manifestPaths.filter((relPath) => {
    if (fs.existsSync(path.join(clonePath, relPath))) {
      return true;
    }
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", "--", relPath], {
        cwd: clonePath,
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  });
}

function configuredGitValue(cwd: string, key: string): boolean {
  try {
    const out = execFileSync("git", ["config", key], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/**
 * Falls back to a tool-authored git identity for the commit step when
 * neither the clone's local nor the machine's global git config has one set
 * (so `git commit` doesn't fail in bare environments). Respects any existing
 * configured identity untouched.
 */
function commitEnv(cwd: string): NodeJS.ProcessEnv {
  if (configuredGitValue(cwd, "user.name") && configuredGitValue(cwd, "user.email")) {
    return process.env;
  }

  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "omc-sync",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "omc-sync@localhost",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "omc-sync",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "omc-sync@localhost",
  };
}

function hasStagedChanges(cwd: string): boolean {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], {
      cwd,
      stdio: "pipe",
    });
    return false;
  } catch {
    return true;
  }
}

export function run(_args: string[]): void {
  const repoRoot = resolveRepoRoot();
  const { clonePath } = readSiblingConfig(repoRoot);
  // Resolved (live pattern re-evaluation against the current filesystem,
  // plus every literal entry even when currently absent — see
  // `resolveManifestSyncCandidates`'s doc comment), not the raw manifest
  // lines — this is "what should be staged/considered-for-deletion right
  // now".
  const manifestPaths = resolveManifestSyncCandidates(defaultManifestPath(repoRoot));

  copyManifestFiles(repoRoot, clonePath, manifestPaths);

  // Unconditionally copy the manifest's own current content into the clone
  // too (alongside the manifest-listed files), so it gets committed/pushed —
  // a second machine's `pull` then gets the scope list back, not just file
  // content.
  const manifestSrc = defaultManifestPath(repoRoot);
  if (fs.existsSync(manifestSrc)) {
    if (fs.lstatSync(manifestSrc).isSymbolicLink()) {
      process.stderr.write(
        `omc-sync: skipping symlink ${MANIFEST_FILENAME} — symlinks are not synced\n`,
      );
    } else {
      safeCopyFile(clonePath, manifestSrc, path.join(clonePath, MANIFEST_FILENAME));
    }
  }

  const stageablePaths = stageableManifestPaths(clonePath, [
    ...manifestPaths,
    MANIFEST_FILENAME,
  ]);
  if (stageablePaths.length > 0) {
    execFileSync("git", ["add", "--", ...stageablePaths], {
      cwd: clonePath,
      stdio: "pipe",
    });
  }

  if (hasStagedChanges(clonePath)) {
    execFileSync(
      "git",
      ["commit", "-m", `omc-sync: sync ${manifestPaths.length} file(s)`],
      { cwd: clonePath, stdio: "pipe", env: commitEnv(clonePath) },
    );
  }

  execFileSync("git", ["push", "-u", "origin", "HEAD"], {
    cwd: clonePath,
    stdio: "pipe",
  });
}
