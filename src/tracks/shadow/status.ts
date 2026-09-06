import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { parseFlag } from "../../args";
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
