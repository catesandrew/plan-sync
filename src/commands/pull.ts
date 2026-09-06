import { parseTrack } from "../args";
import { resolveRepoRoot } from "../repo-root";
import { getDefaultTrack } from "../sync-config";
import * as siblingPull from "../tracks/sibling/pull";

export function run(args: string[]): void {
  let track, rest;
  try {
    ({ track, rest } = parseTrack(args, getDefaultTrack(resolveRepoRoot())));
  } catch (err) {
    throw new Error(`pull: ${(err as Error).message}`);
  }
  if (track === "sibling") return siblingPull.run(rest);
  if (track === "shadow") {
    throw new Error(
      "pull: the shadow track has no 'pull' command — use 'omc-sync restore --track shadow' instead",
    );
  }
}
