import { parseFlag, parseTrack } from "../args";
import { resolveRepoRoot } from "../repo-root";
import { resolveRootDir } from "../root";
import { getDefaultTrack } from "../sync-config";
import * as shadowUninstall from "../tracks/shadow/uninstall";

export function run(args: string[]): void {
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
