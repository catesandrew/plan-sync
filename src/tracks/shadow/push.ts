import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultManifestPath,
  manifestExists,
  MANIFEST_FILENAME,
  resolveManifestSyncCandidates,
} from "../../manifest";
import { parseFlag } from "../../args";
import { resolveRepoRoot } from "../../repo-root";
import { resolveRootDir } from "../../root";
import { resolveProjectId, resolveShadowRefName, resolveShadowRepoPath } from "./paths";
import { scanForSecrets } from "./scan";

/**
 * `plan-sync push --track shadow [--root <dir>]`
 *
 * Implements Part B, Architecture steps 4-5 of
 * .omc/plans/shadow-ref-git-sync-for-omc-artifacts.md (US-006 / AC-B4):
 *
 *   4. Stage every manifest-listed file into the shadow repo via a
 *      throwaway `GIT_INDEX_FILE`, running an advisory secret-shape scan
 *      per file first. The scan is advisory only, never a deletion
 *      authority: a file that matches never simply drops out of the tree.
 *      Instead, if the path existed in the previous tip's tree, that prior
 *      blob is carried forward unchanged (a logged warning is emitted); if
 *      the path was never previously synced, it is genuinely skipped (also
 *      with a logged warning), without failing the sync for the remaining
 *      files. Separately, a manifest-listed path whose source file no
 *      longer exists on disk (an ordinary local deletion the manifest
 *      hasn't caught up with yet) is skipped gracefully rather than
 *      crashing, and is genuinely left out of the new tree — this is the
 *      one legitimate way a path's absence from the tree signals a real
 *      deletion.
 *   5. Commit the resulting tree with `commit-tree` against the previous
 *      tip of `refs/plan-sync/<project-id>/<root>/data`, and push with a
 *      plain, non-force `git push` — the ordinary non-fast-forward
 *      rejection is the correctness mechanism for concurrent same-machine
 *      pushes, not a `--force-with-lease`.
 */
export function run(args: string[]): void {
  const { value: rootFlag } = parseFlag(args, "root");
  const repoRoot = resolveRepoRoot();
  const rootDir = resolveRootDir(repoRoot, rootFlag);
  const projectId = resolveProjectId(repoRoot);
  const shadowRepoPath = resolveShadowRepoPath(projectId, rootDir);

  if (!fs.existsSync(shadowRepoPath)) {
    throw new Error(
      `push --track shadow: no shadow repo found at ${shadowRepoPath} — run \`plan-sync init --track shadow\` first`,
    );
  }

  const gitDir = `--git-dir=${shadowRepoPath}`;
  const refName = resolveShadowRefName(projectId, rootDir);
  const manifestPath = defaultManifestPath(repoRoot, rootDir);

  // Resolved before proceeding: a missing manifest FILE (as opposed to a
  // genuinely empty one) combined with a real previous tip on the ref is a
  // likely-accidental scenario (e.g. the manifest file itself got deleted,
  // or state resolved somewhere unexpected) — not a legitimate whole-
  // manifest deletion. Committing an empty tree here would look identical
  // to a genuine deletion to a later `restore`, which would then delete
  // every previously-synced local file elsewhere.
  const previousTip = tryRevParse(gitDir, refName);
  if (!manifestExists(manifestPath) && previousTip) {
    throw new Error(
      `push --track shadow: manifest file is missing (not just empty) at ${manifestPath}, but a previous push exists — refusing to commit an empty tree; if you really intend to delete everything, create an empty manifest file explicitly first`,
    );
  }

  // Resolved (live pattern re-evaluation against the current filesystem,
  // plus every literal entry even when currently absent — see
  // `resolveManifestSyncCandidates`'s doc comment), not the raw manifest
  // lines — this is "what should be staged/considered-for-deletion right
  // now".
  const manifestPaths = resolveManifestSyncCandidates(manifestPath);

  const indexFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "plan-sync-shadow-index-")),
    "index",
  );
  const indexEnv = { ...process.env, GIT_INDEX_FILE: indexFile };

  try {
    const surviving: string[] = [];
    // previousTip already resolved above (used by the manifest-missing
    // guard), reused here rather than re-computed.

    for (const relPath of manifestPaths) {
      const filePath = path.join(repoRoot, rootDir, relPath);

      if (!fs.existsSync(filePath)) {
        // Ordinary, expected workflow: the user deleted the file locally
        // but hasn't (there's no `unallow`) removed it from the manifest
        // yet. Skip gracefully rather than crashing on ENOENT, and leave it
        // out of the new tree — this genuine absence is the one legitimate
        // deletion signal restore relies on.
        process.stderr.write(
          `plan-sync: skipping ${relPath} — file no longer exists in ${rootDir}/ (not synced)\n`,
        );
        continue;
      }

      if (fs.lstatSync(filePath).isSymbolicLink()) {
        process.stderr.write(
          `plan-sync: skipping symlink ${relPath} — symlinks are not synced\n`,
        );
        continue;
      }

      const content = fs.readFileSync(filePath, "utf8");

      const matches = scanForSecrets(content);
      if (matches.length > 0) {
        // The scan is advisory only — it must never have delete authority.
        // If this path existed in the previous tip's tree, carry that prior
        // blob forward unchanged rather than dropping the path from the new
        // tree. Only genuinely omit it if it was never previously synced.
        const previousEntry = previousTip
          ? tryLsTreeEntry(gitDir, previousTip, relPath)
          : undefined;

        if (previousEntry) {
          execFileSync(
            "git",
            [
              gitDir,
              "update-index",
              "--add",
              "--cacheinfo",
              `${previousEntry.mode},${previousEntry.sha},${relPath}`,
            ],
            { env: indexEnv, stdio: "pipe" },
          );
          process.stderr.write(
            `plan-sync: ${relPath} matches an advisory scan pattern (${matches.join(", ")}) — retaining previous synced version, not updating\n`,
          );
          surviving.push(relPath);
        } else {
          process.stderr.write(
            `plan-sync: skipping ${relPath} — matched: ${matches.join(", ")} (advisory scan, never previously synced)\n`,
          );
        }
        continue;
      }

      const blobSha = execFileSync("git", [gitDir, "hash-object", "-w", filePath], {
        encoding: "utf8",
      }).trim();

      execFileSync(
        "git",
        [gitDir, "update-index", "--add", "--cacheinfo", `100644,${blobSha},${relPath}`],
        { env: indexEnv, stdio: "pipe" },
      );

      surviving.push(relPath);
    }

    // Unconditionally stage the manifest's own current raw content (read
    // directly off disk, not through readManifest()'s parsed/filtered list),
    // so a second machine's restore/pull gets the scope list back too, not
    // just the file content. Never scanned for secrets — it's just a list of
    // relative path strings. Skipped gracefully if the manifest file doesn't
    // exist at all yet. Deliberately excluded from `surviving` (which counts
    // only actual manifest-listed content files), so the "nothing survived
    // the scan" / "nothing to push" early-return below is unaffected by the
    // manifest always being staged into this throwaway index.
    if (fs.existsSync(manifestPath)) {
      if (fs.lstatSync(manifestPath).isSymbolicLink()) {
        process.stderr.write(
          `plan-sync: skipping symlink ${MANIFEST_FILENAME} — symlinks are not synced\n`,
        );
      } else {
        const manifestBlobSha = execFileSync(
          "git",
          [gitDir, "hash-object", "-w", manifestPath],
          { encoding: "utf8" },
        ).trim();
        execFileSync(
          "git",
          [
            gitDir,
            "update-index",
            "--add",
            "--cacheinfo",
            `100644,${manifestBlobSha},${MANIFEST_FILENAME}`,
          ],
          { env: indexEnv, stdio: "pipe" },
        );
      }
    }

    const treeSha = execFileSync("git", [gitDir, "write-tree"], {
      env: indexEnv,
      encoding: "utf8",
    }).trim();

    if (previousTip) {
      const previousTreeSha = execFileSync(
        "git",
        [gitDir, "rev-parse", `${previousTip}^{tree}`],
        { encoding: "utf8" },
      ).trim();

      if (previousTreeSha === treeSha) {
        process.stderr.write(
          "plan-sync: nothing changed since the last push\n",
        );
        return;
      }
    } else if (surviving.length === 0) {
      // First-ever push with nothing to establish a baseline against
      // (empty manifest, or every file scan-skipped with no prior
      // version) — there's no previous tip to compare the tree against,
      // and the tree itself is empty, so skipping is genuinely correct
      // here rather than committing an empty root with no history.
      process.stderr.write(
        "plan-sync: nothing to push (no manifest files, or all were skipped by the advisory scan)\n",
      );
      return;
    }

    const commitTreeArgs = [gitDir, "commit-tree", treeSha];
    if (previousTip) {
      commitTreeArgs.push("-p", previousTip);
    }
    commitTreeArgs.push("-m", `plan-sync: sync ${surviving.length} file(s)`);

    const commitSha = execFileSync("git", commitTreeArgs, {
      encoding: "utf8",
    }).trim();

    try {
      execFileSync("git", [gitDir, "push", "origin", `${commitSha}:${refName}`], {
        stdio: "pipe",
      });
    } catch (err) {
      const stderr = (err as { stderr?: Buffer | string }).stderr;
      const detail = stderr ? stderr.toString() : (err as Error).message;
      throw new Error(
        `push --track shadow: push to ${refName} was rejected (likely a concurrent push moved the ref out from under this one): ${detail}`,
      );
    }

    // Mirror the newly-pushed tip into the shadow repo's own local ref, so
    // a later (fresh-process) invocation of `push` can read the previous
    // tip via a purely local `rev-parse` (step 5 of the plan) rather than
    // needing a network round-trip to origin.
    execFileSync("git", [gitDir, "update-ref", refName, commitSha], {
      stdio: "pipe",
    });
  } finally {
    fs.rmSync(path.dirname(indexFile), { recursive: true, force: true });
  }
}

function tryRevParse(gitDir: string, refName: string): string | undefined {
  try {
    const sha = execFileSync("git", [gitDir, "rev-parse", "--verify", refName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Looks up `relPath` in the tree of `treeish` (typically the previous tip
 * commit) and returns its exact mode + blob SHA, or `undefined` if the path
 * isn't present there. Used to carry a scan-matched path's previously
 * synced blob forward unchanged, without re-hashing the current (matched)
 * file content.
 */
function tryLsTreeEntry(
  gitDir: string,
  treeish: string,
  relPath: string,
): { mode: string; sha: string } | undefined {
  let out: string;
  try {
    out = execFileSync("git", [gitDir, "ls-tree", treeish, "--", relPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
  if (out.length === 0) {
    return undefined;
  }
  const match = out.match(/^(\d+) \w+ ([0-9a-f]+)\t/);
  if (!match) {
    return undefined;
  }
  return { mode: match[1], sha: match[2] };
}
