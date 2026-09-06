import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { resolveRepoRoot } from "../../repo-root";
import { resolveProjectId, resolveShadowRepoPath } from "./paths";

/**
 * `omc-sync uninstall --track shadow`
 *
 * Implements Part B, Architecture step 9 of
 * .omc/plans/shadow-ref-git-sync-for-omc-artifacts.md (US-007): tears down
 * the shadow-ref track only —
 *
 *   1. deletes `refs/omc/<project-id>/data` on the remote, tolerating the
 *      ref already being absent there (a no-op, not an error), while still
 *      surfacing any other kind of push failure (auth/network/etc.);
 *   2. removes the local (bare) shadow repo directory entirely.
 *
 * Deliberately does NOT touch the anchor repo's `.git/info/exclude` entry
 * or the shared manifest — those are shared with (or owned by) the
 * sibling track and must survive shadow-track teardown untouched.
 */
export function run(_args: string[]): void {
  const repoRoot = resolveRepoRoot();
  const projectId = resolveProjectId(repoRoot);
  const shadowRepoPath = resolveShadowRepoPath(projectId);
  const refName = `refs/omc/${projectId}/data`;

  if (fs.existsSync(shadowRepoPath)) {
    deleteRemoteRef(shadowRepoPath, refName);
  }

  fs.rmSync(shadowRepoPath, { recursive: true, force: true });
}

function deleteRemoteRef(shadowRepoPath: string, refName: string): void {
  const gitDir = `--git-dir=${shadowRepoPath}`;
  try {
    execFileSync("git", [gitDir, "push", "origin", "--delete", refName], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const detail = stderr ? stderr.toString() : (err as Error).message;
    if (/remote ref does not exist/i.test(detail)) {
      // Nothing to delete remotely — treat as a successful no-op.
      return;
    }
    throw new Error(
      `uninstall --track shadow: failed to delete remote ref '${refName}': ${detail}`,
    );
  }
}
