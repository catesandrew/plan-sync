import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const OWNER_KEY = "plan-sync.owner";

function readOwner(gitDir: string): string | undefined {
  try {
    const value = execFileSync("git", [gitDir, "config", "--get", OWNER_KEY], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** The checkout's git common dir, so linked worktrees of one repo count as one owner. */
function ownerOf(repoRoot: string): string {
  const out = execFileSync("git", ["-C", repoRoot, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
  return fs.realpathSync(path.resolve(repoRoot, out));
}

/**
 * Refuses to use a shadow repo that another checkout owns. Two different repos
 * that resolve to the same shadow repo would overwrite each other's ref and
 * push into each other's remote, so fail loudly instead.
 *
 * An unset owner (a repo created before this check) is claimed when `claim` is
 * true. An owner whose directory no longer exists (the repo was moved or
 * deleted) is reclaimed the same way. `claim` is false for read-only status.
 */
export function checkShadowOwner(shadowRepoPath: string, repoRoot: string, claim: boolean): void {
  if (!fs.existsSync(shadowRepoPath)) return;
  const gitDir = `--git-dir=${shadowRepoPath}`;
  const me = ownerOf(repoRoot);
  const owner = readOwner(gitDir);

  if (owner === me) return;
  if (owner !== undefined && fs.existsSync(owner)) {
    throw new Error(
      `shadow repo at ${shadowRepoPath} belongs to ${owner}, not ${me} — two repos are sharing one shadow repo (usually the same root commit). Remove it, or fix the other repo, before syncing from here`,
    );
  }
  if (claim) execFileSync("git", [gitDir, "config", OWNER_KEY, me]);
}
