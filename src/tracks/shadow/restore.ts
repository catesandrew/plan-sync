import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFlag } from "../../args";
import {
  addToManifest,
  defaultManifestPath,
  MANIFEST_FILENAME,
  readManifest,
} from "../../manifest";
import { resolveRepoRoot } from "../../repo-root";
import { resolveRootDir } from "../../root";
import { safeRemove, safeWriteFile } from "../../safe-write";
import { resolveProjectId, resolveShadowRefName, resolveShadowRepoPath } from "./paths";

/**
 * `plan-sync restore --track shadow [--ref <sha-or-ref>] [--root <dir>]`
 *
 * Implements Part B, Architecture step 6 of
 * .omc/plans/shadow-ref-git-sync-for-omc-artifacts.md (US-007 / AC-B2,
 * AC-B3): materializes the tree at `refs/plan-sync/<project-id>/<root>/data`
 * (or a `--ref` override) back onto disk at `<rootDir>/<path>` in the anchor
 * repo.
 *
 * This is a true tree-sync, not an additive overlay:
 *   - every path present in the target tree is (re)written from the
 *     blob's exact bytes — unless the on-disk copy differs from the local
 *     ref's pre-fetch tip (the merge base), i.e. it was edited locally and
 *     not yet pushed: then local wins, and if the remote also changed, the
 *     two are 3-way merged in place (`git merge-file`; conflict markers on
 *     overlap), falling back to `<path>.remote` for binary content;
 *   - every path currently listed in the manifest that is *not* present in
 *     the target tree, but *was* present at some earlier commit reachable
 *     from the target ref (i.e. it was genuinely synced once and is now
 *     genuinely gone), is deleted, if present on disk and unchanged from
 *     the merge base.
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
  const { value: refFlag, rest: rest1 } = parseFlag(args, "ref");
  const { value: rootFlag } = parseFlag(rest1, "root");
  const repoRoot = resolveRepoRoot();
  const rootDir = resolveRootDir(repoRoot, rootFlag);
  const projectId = resolveProjectId(repoRoot);
  const shadowRepoPath = resolveShadowRepoPath(projectId, rootDir);

  if (!fs.existsSync(shadowRepoPath)) {
    throw new Error(
      `restore --track shadow: no shadow repo found at ${shadowRepoPath} — run \`plan-sync init --track shadow\` first`,
    );
  }

  const gitDir = `--git-dir=${shadowRepoPath}`;
  const derivedRefName = resolveShadowRefName(projectId, rootDir);
  const refName = refFlag ?? derivedRefName;

  // The local ref tip BEFORE fetching is the last state this machine
  // synced (pushed or pulled) — the merge base for deciding whether an
  // on-disk file was edited locally since then. Always the derived ref,
  // even under --ref, so an explicit restore still can't clobber unpushed
  // local edits. Absent on a fresh machine: then every differing local
  // file counts as locally modified.
  const baseSha = resolveLocalRef(gitDir, derivedRefName);

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
  const omcRoot = path.join(repoRoot, rootDir);

  for (const relPath of targetPaths) {
    if (relPath === MANIFEST_FILENAME) {
      // The manifest itself is handled specially below via a union-merge
      // into the LOCAL manifest, never wholesale-overwritten from the
      // incoming tree like an ordinary file — see mergeIncomingManifest.
      continue;
    }
    const content = readBlob(gitDir, refName, relPath);
    const destPath = path.join(repoRoot, rootDir, relPath);
    const local = readLocalFile(destPath);
    if (local?.equals(content)) {
      continue;
    }
    if (local !== undefined) {
      const base = baseSha ? tryReadBlob(gitDir, baseSha, relPath) : undefined;
      if (!base?.equals(local)) {
        // Edited locally since the last sync: keep it (the next push
        // uploads it). If the remote ALSO changed, 3-way merge (an empty
        // base when there's none, so differing sides become an add/add
        // conflict); if merge-file refuses (binary) or errors, park the
        // incoming copy beside the local one rather than drop it.
        if (!base?.equals(content)) {
          const result = mergeFile(local, base ?? Buffer.alloc(0), content);
          if (!result) {
            safeWriteFile(omcRoot, `${destPath}.remote`, content);
            process.stderr.write(
              `plan-sync: conflict on ${relPath}: kept local, remote copy at ${relPath}.remote\n`,
            );
          } else {
            safeWriteFile(omcRoot, destPath, result.merged);
            process.stderr.write(
              result.conflicts === 0
                ? `plan-sync: merged ${relPath}\n`
                : `plan-sync: conflict in ${relPath} (${result.conflicts} hunk(s)); resolve markers, then push\n`,
            );
          }
        }
        continue;
      }
    }
    safeWriteFile(omcRoot, destPath, content);
  }

  const localManifestPath = defaultManifestPath(repoRoot, rootDir);
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
    const destPath = path.join(repoRoot, rootDir, relPath);
    const local = readLocalFile(destPath);
    if (local !== undefined) {
      const base = baseSha ? tryReadBlob(gitDir, baseSha, relPath) : undefined;
      if (!base?.equals(local)) {
        // Edited locally since the last sync (or never synced here):
        // the remote deletion must not destroy those edits.
        continue;
      }
    }
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
        `plan-sync: skipping invalid incoming manifest entry '${line}': ${(err as Error).message}\n`,
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

function resolveLocalRef(gitDir: string, refName: string): string | undefined {
  try {
    const out = execFileSync("git", [gitDir, "rev-parse", "--verify", "-q", refName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the on-disk file's bytes only if it is a regular file (lstat, so a
 * symlink at the destination reads as "not a local file" and falls through
 * to safeWriteFile/safeRemove's refusal path, exactly as before).
 */
function readLocalFile(destPath: string): Buffer | undefined {
  try {
    return fs.lstatSync(destPath).isFile() ? fs.readFileSync(destPath) : undefined;
  } catch {
    return undefined;
  }
}

/** `readBlob`, but `undefined` when the path doesn't exist at that commit. */
function tryReadBlob(gitDir: string, sha: string, relPath: string): Buffer | undefined {
  try {
    return execFileSync("git", [gitDir, "show", `${sha}:${relPath}`], {
      maxBuffer: 100 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/**
 * 3-way merges via `git merge-file -p` over throwaway temp copies in the OS
 * tmpdir (never under the root dir; the caller writes the result through
 * safeWriteFile). Returns the merged bytes plus the conflict-hunk count
 * (merge-file's exit status, 0 = clean), or `undefined` when merge-file
 * refuses (binary content) or otherwise errors.
 */
function mergeFile(
  local: Buffer,
  base: Buffer,
  incoming: Buffer,
): { merged: Buffer; conflicts: number } | undefined {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-sync-merge-"));
  try {
    const sides = [["local", local], ["base", base], ["remote", incoming]] as const;
    for (const [name, content] of sides) fs.writeFileSync(path.join(tmpDir, name), content);
    const argv = ["merge-file", "-p", "-L", "local", "-L", "base", "-L", "remote"];
    try {
      const merged = execFileSync("git", [...argv, ...sides.map(([name]) => path.join(tmpDir, name))], {
        maxBuffer: 100 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { merged, conflicts: 0 };
    } catch (err) {
      // Exit 1..127 = that many conflict hunks, stdout holds the marked-up
      // merge; anything else (255 = binary/error) is a refusal.
      const { status, stdout } = err as { status?: number | null; stdout?: Buffer };
      if (status && status > 0 && status < 128 && stdout) {
        return { merged: stdout, conflicts: status };
      }
      return undefined;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
