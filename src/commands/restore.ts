import { parseFlag, parseTrack } from "../args";
import { resolveRepoRoot } from "../repo-root";
import { resolveRootDir } from "../root";
import { getDefaultTrack } from "../sync-config";
import * as shadowRestore from "../tracks/shadow/restore";

export function run(args: string[]): void {
  const { value: rootFlag } = parseFlag(args, "root");
  const repoRoot = resolveRepoRoot();
  const rootDir = resolveRootDir(repoRoot, rootFlag);

  let track, rest;
  try {
    ({ track, rest } = parseTrack(args, getDefaultTrack(repoRoot, rootDir)));
  } catch (err) {
    throw new Error(`restore: ${(err as Error).message}`);
  }
  if (track === "shadow") return shadowRestore.run(rest);
  throw new Error(
    "restore: only the shadow track supports 'restore' — sibling-track durability uses ordinary 'pull'",
  );
}
