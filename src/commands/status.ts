import { hasHelpFlag, parseFlag, parseTrack } from "../args";
import { resolveRepoRoot } from "../repo-root";
import { resolveRootDir } from "../root";
import { getDefaultTrack } from "../sync-config";
import * as shadowStatus from "../tracks/shadow/status";
import * as siblingStatus from "../tracks/sibling/status";

const HELP_TEXT = `Usage: plan-sync status [--track <sibling|shadow>] [--stale-after <duration>] [--root <dir>]

Reports sync freshness/health for the current track.

Flags:
  --track <sibling|shadow>   Sync track (optional if a default track is persisted)
  --stale-after <duration>   Staleness threshold, e.g. "24h", "2d" (shadow track only, default "24h")
  --root <dir>               Root directory to sync (optional, e.g. ".omc")
`;

export function run(args: string[]): void {
  if (hasHelpFlag(args)) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const { value: rootFlag } = parseFlag(args, "root");
  const repoRoot = resolveRepoRoot();
  const rootDir = resolveRootDir(repoRoot, rootFlag);

  let track, rest;
  try {
    ({ track, rest } = parseTrack(args, getDefaultTrack(repoRoot, rootDir)));
  } catch (err) {
    throw new Error(`status: ${(err as Error).message}`);
  }
  if (track === "shadow") return shadowStatus.run(rest);
  if (track === "sibling") return siblingStatus.run(rest);
}
