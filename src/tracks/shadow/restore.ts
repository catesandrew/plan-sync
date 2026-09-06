import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFlag } from "../../args";
import {
  addToManifest,
  defaultManifestPath,
  MANIFEST_FILENAME,
  readManifest,
} from "../../manifest";
import { resolveRepoRoot } from "../../repo-root";
import { safeRemove, safeWriteFile } from "../../safe-write";
import { resolveProjectId, resolveShadowRepoPath } from "./paths";

/**
 * `omc-sync restore --track shadow [--ref <sha-or-ref>]`
 *
 * Implements Part B, Architecture step 6 of
 * .omc/plans/shadow-ref-git-sync-for-omc-artifacts.md (US-007 / AC-B2,
 * AC-B3): materializes the tree at `refs/omc/<project-id>/data` (or a
 * `--ref` override) back onto disk at `.omc/<path>` in the anchor repo.
 *
 * This is a true tree-sync, not an additive overlay:
 *   - every path present in the target tree is (re)written from the
 *     blob's exact bytes;
 *   - every path currently listed in the manifest that is *not* present in
 *     the target tree, but *was* present at some earlier commit reachable
 *     from the target ref (i.e. it was genuinely synced once and is now
 *     genuinely gone), is deleted, if present on disk.
 *
 * Deletion is deliberately scoped to (ref history \ target tree), never to
 * (current manifest \ target tree): a path can be manifest-listed and
 * absent from the target tree merely because it was never successfully
 * synced yet (e.g. it has always matched the advisory scan in `push`, so no
 * commit in this ref's history ever contained it). Deleting the local file
 * in that case would destroy content that was never backed up. Checking
 * the ref's own history (via `git log -- <path>`) is what distinguishes a
 * genuine prior-then-gone deletion from a path that simply never made it
 * into the shadow ref in the first place.
 *
 * Scope is otherwise limited to the manifest ∪ the target tree — this never
 * touches files under `.omc/` that this tool has no knowledge of.
 */
export function run(args: string[]): void {
  const { value: refFlag } = parseFlag(args, "ref");
  const repoRoot = resolveRepoRoot();
  const projectId = resolveProjectId(repoRoot);
  const shadowRepoPath = resolveShadowRepoPath(projectId);

  if (!fs.existsSync(shadowRepoPath)) {
    throw new Error(
      `restore --track shadow: no shadow repo found at ${shadowRepoPath} — run \`omc-sync init --track shadow\` first`,
    );
  }

  const gitDir = `--git-dir=${shadowRepoPath}`;
  const refName = refFlag ?? `refs/omc/${projectId}/data`;

  // On a fresh machine (a shadow repo that was just `init`-ed but never
  // pushed from), the local ref doesn't exist yet — only `origin` knows
  // about it. Best-effort fetch it into the matching local ref name before
  // reading the tree; if this fails (offline, ref never pushed, or an
  // explicit --ref that isn't a remote-tracking ref name), fall through to
  // `listTree`, which surfaces a clear error if the ref is unresolvable
  // both locally and remotely.
  if (!refFlag) {
    tryFetchRef(gitDir, refName);
  }

  const targetPaths = listTree(gitDir, refName);
  const targetSet = new Set(targetPaths);
  const omcRoot = path.join(repoRoot, ".omc");

  for (const relPath of targetPaths) {
    if (relPath === MANIFEST_FILENAME) {
      // The manifest itself is handled specially below via a union-merge
      // into the LOCAL manifest, never wholesale-overwritten from the
      // incoming tree like an ordinary file — see mergeIncomingManifest.
      continue;
    }
    const content = readBlob(gitDir, refName, relPath);
    const destPath = path.join(repoRoot, ".omc", relPath);
    safeWriteFile(omcRoot, destPath, content);
  }

  const localManifestPath = defaultManifestPath(repoRoot);
  const manifestPaths = readManifest(localManifestPath);
  for (const relPath of manifestPaths) {
    if (targetSet.has(relPath)) {
      continue;
    }
    if (!everSyncedInHistory(gitDir, refName, relPath)) {
      // This path is absent from the target tree, but the shadow ref's own
      // history shows it was never actually synced (e.g. it has always
      // matched the advisory scan). Its absence carries no deletion
      // intent, so any local copy is left untouched.
      continue;
    }
    const destPath = path.join(repoRoot, ".omc", relPath);
    safeRemove(omcRoot, destPath);
  }

  if (targetSet.has(MANIFEST_FILENAME)) {
    mergeIncomingManifest(gitDir, refName, localManifestPath);
  }
}

/**
 * Parses the incoming manifest blob's raw lines (same skip-blank/skip-
 * comment rules as `readManifest`) and UNION-merges each valid line into the
 * local manifest via `addToManifest` — additive only, so a pre-existing
 * local-only entry the incoming manifest doesn't mention is never removed or
 * overwritten. Reads via `readBlob` (git's own object store), so there's no
 * filesystem symlink-escape surface to guard against here.
 */
function mergeIncomingManifest(
  gitDir: string,
  refName: string,
  localManifestPath: string,
): void {
  const raw = readBlob(gitDir, refName, MANIFEST_FILENAME).toString("utf8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  for (const line of lines) {
    try {
      addToManifest(localManifestPath, line);
    } catch (err) {
      // A hand-edited or otherwise malformed incoming manifest could contain
      // an out-of-bounds entry (absolute path / `../` traversal);
      // addToManifest fails closed on those. Skip just that one line with a
      // warning rather than aborting the whole restore.
      process.stderr.write(
        `omc-sync: skipping invalid incoming manifest entry '${line}': ${(err as Error).message}\n`,
      );
    }
  }
}

/**
 * Returns true if `relPath` was ever added/modified/removed in some commit
 * reachable from `refName` — i.e. it was genuinely synced into the shadow
 * ref's history at some point, regardless of whether it's present in the
 * current tip's tree. Used to distinguish a genuine (previously-synced,
 * now-deleted) path from one that simply never made it into any commit.
 */
function everSyncedInHistory(gitDir: string, refName: string, relPath: string): boolean {
  try {
    const out = execFileSync(
      "git",
      [gitDir, "log", "--format=%H", "-1", refName, "--", relPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function tryFetchRef(gitDir: string, refName: string): void {
  try {
    execFileSync("git", [gitDir, "fetch", "origin", `+${refName}:${refName}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Best-effort: no origin, offline, or nothing has ever been pushed.
    // `listTree` below will surface a clear error if the ref truly can't
    // be resolved locally either.
  }
}

function listTree(gitDir: string, refName: string): string[] {
  let out: string;
  try {
    out = execFileSync("git", [gitDir, "ls-tree", "-r", "--name-only", refName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const detail = stderr ? stderr.toString() : (err as Error).message;
    throw new Error(
      `restore --track shadow: failed to read ref '${refName}': ${detail}`,
    );
  }
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Extracts a blob's exact bytes as a `Buffer` (not a string round-trip), so
 * CRLF (or any other byte sequence) content round-trips byte-for-byte.
 */
function readBlob(gitDir: string, refName: string, relPath: string): Buffer {
  return execFileSync("git", [gitDir, "show", `${refName}:${relPath}`], {
    maxBuffer: 100 * 1024 * 1024,
  });
}
