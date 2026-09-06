import { parseTrack } from "../args";
import { resolveRepoRoot } from "../repo-root";
import { getDefaultTrack } from "../sync-config";
import * as shadowStatus from "../tracks/shadow/status";
import * as siblingStatus from "../tracks/sibling/status";

export function run(args: string[]): void {
  let track, rest;
  try {
    ({ track, rest } = parseTrack(args, getDefaultTrack(resolveRepoRoot())));
  } catch (err) {
    throw new Error(`status: ${(err as Error).message}`);
  }
  if (track === "shadow") return shadowStatus.run(rest);
  if (track === "sibling") return siblingStatus.run(rest);
}
