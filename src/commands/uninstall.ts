import { hasHelpFlag, parseFlag, parseTrack } from "../args";
import { resolveRepoRoot } from "../repo-root";
import { resolveRootDir } from "../root";
import { getDefaultTrack } from "../sync-config";
import * as shadowUninstall from "../tracks/shadow/uninstall";

const HELP_TEXT = `Usage: plan-sync uninstall [--track <sibling|shadow>] [--root <dir>]

Removes sync configuration and state. Only the shadow track has teardown
state to remove; sibling-track cleanup is an ordinary 'rm -rf <clone-path>'.

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
    throw new Error(`uninstall: ${(err as Error).message}`);
  }
  if (track === "shadow") return shadowUninstall.run(rest);
  throw new Error(
    "uninstall: only the shadow track has teardown state to remove — sibling-track cleanup is an ordinary 'rm -rf <clone-path>'",
  );
}
