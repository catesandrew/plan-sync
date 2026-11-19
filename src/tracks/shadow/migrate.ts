import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { run as shadowInit } from "./init";
import {
  resolveLegacyProjectId,
  resolveProjectId,
  resolveShadowRefName,
  resolveShadowRepoPath,
} from "./paths";

/**
 * Seeds the local shadow ref from the origin's legacy-ID ref (best effort).
 * The legacy ref on THIS repo's own origin holds its history, so the new ref
 * continues it rather than starting empty. Offline, or no legacy ref on the
 * remote, is not an error. A no-op when the IDs match or the ref exists.
 */
export function seedFromLegacyRef(repoRoot: string, rootDir: string): void {
  const id = resolveProjectId(repoRoot);
  const legacy = resolveLegacyProjectId(repoRoot);
  if (id === legacy) return;

  const gitDir = `--git-dir=${resolveShadowRepoPath(id, rootDir)}`;
  const newRef = resolveShadowRefName(id, rootDir);
  try {
    execFileSync("git", [gitDir, "rev-parse", "--verify", "-q", newRef], { stdio: "ignore" });
    return;
  } catch {
    // no local ref yet: fall through and seed it
  }
  try {
    execFileSync(
      "git",
      [gitDir, "fetch", "origin", `+${resolveShadowRefName(legacy, rootDir)}:${newRef}`],
      { stdio: "ignore" },
    );
  } catch {
    // ref absent on the remote, or offline: start empty, same as a fresh init
  }
}

/**
 * A repo initialised under the legacy ID has its shadow repo at the legacy
 * path. The current ID points elsewhere, so create the new one (init wires it
 * to THIS repo's origin and seeds it, see seedFromLegacyRef) instead of
 * failing with "not initialised". The legacy directory is left untouched: it
 * may be shared with a sibling repo that has the same root commit.
 */
export function adoptLegacyShadow(repoRoot: string, rootDir: string): void {
  const id = resolveProjectId(repoRoot);
  const legacy = resolveLegacyProjectId(repoRoot);
  if (id === legacy) return;
  if (fs.existsSync(resolveShadowRepoPath(id, rootDir))) return;
  if (!fs.existsSync(resolveShadowRepoPath(legacy, rootDir))) return;
  shadowInit(["--root", rootDir]);
}
