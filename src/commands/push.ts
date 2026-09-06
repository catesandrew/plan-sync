import { hasHelpFlag, parseFlag, parseTrack } from "../args";
import { resolveRepoRoot } from "../repo-root";
import { resolveRootDir } from "../root";
import { getDefaultTrack } from "../sync-config";
import * as siblingPush from "../tracks/sibling/push";
import * as shadowPush from "../tracks/shadow/push";

const HELP_TEXT = `Usage: plan-sync push [--track <sibling|shadow>] [--root <dir>]

Pushes manifest-listed files to the sync destination (sibling repo or
shadow git ref).

Flags:
  --track <sibling|shadow>  Sync track (optional if a default track is persisted)
  --root <dir>              Root directory to sync (optional, e.g. ".omc")
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
    throw new Error(`push: ${(err as Error).message}`);
  }
  if (track === "sibling") return siblingPush.run(rest);
  if (track === "shadow") return shadowPush.run(rest);
}
