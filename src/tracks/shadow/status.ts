import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFlag } from "../../args";
import { defaultManifestPath, resolveManifestSyncCandidates } from "../../manifest";
import { resolveRepoRoot } from "../../repo-root";
import { resolveProjectId, resolveShadowRepoPath } from "./paths";

const DEFAULT_STALE_AFTER = "24h";

/**
 * `omc-sync status --track shadow [--stale-after <duration>]`
 *
 * Implements Part B, Architecture step 8 of
 * .omc/plans/shadow-ref-git-sync-for-omc-artifacts.md (US-007): reports
 * whether the shadow repo is initialized, the age of the last successful
 * push (derived from the pushed ref's own committer timestamp — not a
 * separate side-channel timestamp file that could drift from it), and
 * whether that age exceeds `--stale-after` (default `24h`; accepts `h`,
 * `d`, `m` suffixes for hours/days/minutes).
 *
 * Prints "OK" and returns normally when fresh. Prints a "STALE" indicator
 * and throws (surfacing a non-zero exit via the CLI dispatcher) when
 * there's no shadow repo, no push has ever happened, or the last push is
 * older than the threshold.
 */
export function run(args: string[]): void {
  const { value: staleAfterFlag } = parseFlag(args, "stale-after");
  const staleAfterSpec = staleAfterFlag ?? DEFAULT_STALE_AFTER;
  const staleAfterMs = parseDuration(staleAfterSpec);

  const repoRoot = resolveRepoRoot();
  const projectId = resolveProjectId(repoRoot);
  const shadowRepoPath = resolveShadowRepoPath(projectId);

  if (!fs.existsSync(shadowRepoPath)) {
    process.stdout.write(
      `omc-sync: shadow repo not initialized (no repo at ${shadowRepoPath})\n`,
    );
    throw new Error("STALE: shadow repo not initialized — no push has ever happened");
  }

  const gitDir = `--git-dir=${shadowRepoPath}`;
  const refName = `refs/omc/${projectId}/data`;

  tryFetchRef(gitDir, refName);
  printPerFileStatus(repoRoot, gitDir, refName);

  const lastPushIso = tryGetLastPushTimestamp(gitDir, refName);

  process.stdout.write(`omc-sync: shadow repo initialized at ${shadowRepoPath}\n`);

  if (!lastPushIso) {
    process.stdout.write("omc-sync: no push has ever happened\n");
    throw new Error("STALE: no push has ever happened");
  }

  const ageMs = Date.now() - Date.parse(lastPushIso);
  const ageHuman = formatAge(ageMs);
  process.stdout.write(`omc-sync: last push ${ageHuman} (${lastPushIso})\n`);

  if (ageMs > staleAfterMs) {
    process.stdout.write(
      `STALE: last push was ${ageHuman}, older than the --stale-after threshold (${staleAfterSpec})\n`,
    );
    throw new Error(
      `STALE: last push was ${ageHuman}, older than the --stale-after threshold (${staleAfterSpec})`,
    );
  }

  process.stdout.write("OK\n");
}

/**
 * Best-effort fetch of `refName` from `origin` into the matching local ref
 * name, mirroring `restore.ts`'s same-named helper, so the per-file report
 * reflects the remote's current tip even on a machine that only ever
 * `init`-ed/`restore`-d (never pushed) and so has no local mirror ref yet.
 * Failure (offline, no origin, ref never pushed) is tolerated silently —
 * the per-file comparisons below already treat an unresolvable ref entry as
 * "not present in the ref".
 */
function tryFetchRef(gitDir: string, refName: string): void {
  try {
    execFileSync("git", [gitDir, "fetch", "origin", `+${refName}:${refName}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Best-effort only.
  }
}

/**
 * Reports each manifest-listed path's sync state relative to the ref tip:
 *   - "in sync": present locally and in the ref, with matching content.
 *   - "pending (local changes)": present in both, but content differs.
 *   - "pending (never synced)": present locally, absent from the ref.
 *   - "missing locally": present in the ref, absent locally.
 * Prints one line per path, then a one-line summary count.
 */
function printPerFileStatus(repoRoot: string, gitDir: string, refName: string): void {
  // Resolved (live pattern re-evaluation against the current filesystem,
  // plus every literal entry even when currently absent — see
  // `resolveManifestSyncCandidates`'s doc comment), not the raw manifest
  // lines — this is "what should be reported right now".
  const manifestPaths = resolveManifestSyncCandidates(defaultManifestPath(repoRoot));

  let inSync = 0;
  let pendingLocal = 0;
  let pendingNeverSynced = 0;
  let missingLocally = 0;

  for (const relPath of manifestPaths) {
    const localPath = path.join(repoRoot, ".omc", relPath);
    const localExists = fs.existsSync(localPath);
    const refSha = tryLsTreeBlobSha(gitDir, refName, relPath);

    let state: string;
    if (localExists && refSha) {
      const localSha = tryHashObject(gitDir, localPath);
      if (localSha && localSha === refSha) {
        state = "in sync";
        inSync++;
      } else {
        state = "pending (local changes)";
        pendingLocal++;
      }
    } else if (localExists) {
      state = "pending (never synced)";
      pendingNeverSynced++;
    } else if (refSha) {
      state = "missing locally";
      missingLocally++;
    } else {
      // Neither locally present nor ever synced — closest fit of the four
      // reported states is "never synced".
      state = "pending (never synced)";
      pendingNeverSynced++;
    }

    process.stdout.write(`omc-sync: ${relPath}: ${state}\n`);
  }

  process.stdout.write(
    `omc-sync: ${manifestPaths.length} file(s) tracked — ${inSync} in sync, ${pendingLocal} pending (local changes), ${pendingNeverSynced} pending (never synced), ${missingLocally} missing locally\n`,
  );
}

function tryLsTreeBlobSha(
  gitDir: string,
  refName: string,
  relPath: string,
): string | undefined {
  let out: string;
  try {
    out = execFileSync("git", [gitDir, "ls-tree", refName, "--", relPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
  if (out.length === 0) {
    return undefined;
  }
  const match = out.match(/^\d+ \w+ ([0-9a-f]+)\t/);
  return match ? match[1] : undefined;
}

function tryHashObject(gitDir: string, filePath: string): string | undefined {
  try {
    return execFileSync("git", [gitDir, "hash-object", filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function tryGetLastPushTimestamp(gitDir: string, refName: string): string | undefined {
  try {
    const out = execFileSync(
      "git",
      [gitDir, "log", "-1", "--format=%cI", refName],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Parses a `24h` / `7d` / `30m`-style duration spec into milliseconds. */
function parseDuration(spec: string): number {
  const match = /^(\d+)\s*(h|d|m)$/.exec(spec.trim());
  if (!match) {
    throw new Error(
      `status --track shadow: invalid --stale-after duration '${spec}' (expected e.g. 24h, 7d, 30m)`,
    );
  }
  const value = Number(match[1]);
  const unit = match[2];
  const unitMs = unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 60_000;
  return value * unitMs;
}

/** Formats a millisecond duration as a human-readable "N unit(s) ago" string. */
function formatAge(ms: number): string {
  const clamped = Math.max(0, ms);

  if (clamped < 60_000) {
    const secs = Math.round(clamped / 1000);
    return `${secs} second${secs === 1 ? "" : "s"} ago`;
  }
  if (clamped < 3_600_000) {
    const mins = Math.round(clamped / 60_000);
    return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  }
  if (clamped < 86_400_000) {
    const hours = Math.round(clamped / 3_600_000);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(clamped / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
