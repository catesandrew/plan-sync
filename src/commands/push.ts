import { parseFlag, parseTrack } from "../args";
import { resolveRepoRoot } from "../repo-root";
import { resolveRootDir } from "../root";
import { getDefaultTrack } from "../sync-config";
import * as siblingPush from "../tracks/sibling/push";
import * as shadowPush from "../tracks/shadow/push";

export function run(args: string[]): void {
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
