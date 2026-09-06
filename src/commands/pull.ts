import { hasHelpFlag, parseFlag, parseTrack } from "../args";
import { resolveRepoRoot } from "../repo-root";
import { resolveRootDir } from "../root";
import { getDefaultTrack } from "../sync-config";
import * as siblingPull from "../tracks/sibling/pull";
import * as shadowRestore from "../tracks/shadow/restore";

const HELP_TEXT = `Usage: plan-sync pull [--track <sibling|shadow>] [--ref <sha-or-ref>] [--root <dir>]

Pulls/materializes manifest-listed files from the sync destination
(sibling repo or shadow git ref) back onto disk.

Flags:
  --track <sibling|shadow>  Sync track (optional if a default track is persisted)
  --ref <sha-or-ref>        Ref/commit to restore from (shadow track only, optional)
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
    throw new Error(`pull: ${(err as Error).message}`);
  }
  if (track === "sibling") return siblingPull.run(rest);
  if (track === "shadow") return shadowRestore.run(rest);
}
