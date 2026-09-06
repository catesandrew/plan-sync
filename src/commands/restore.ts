import { parseTrack } from "../args";
import * as shadowRestore from "../tracks/shadow/restore";

export function run(args: string[]): void {
  let track, rest;
  try {
    ({ track, rest } = parseTrack(args));
  } catch (err) {
    throw new Error(`restore: ${(err as Error).message}`);
  }
  if (track === "shadow") return shadowRestore.run(rest);
  throw new Error(
    "restore: only the shadow track supports 'restore' — sibling-track durability uses ordinary 'pull'",
  );
}
