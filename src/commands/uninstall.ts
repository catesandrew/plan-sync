import { parseTrack } from "../args";
import * as shadowUninstall from "../tracks/shadow/uninstall";

export function run(args: string[]): void {
  let track, rest;
  try {
    ({ track, rest } = parseTrack(args));
  } catch (err) {
    throw new Error(`uninstall: ${(err as Error).message}`);
  }
  if (track === "shadow") return shadowUninstall.run(rest);
  throw new Error(
    "uninstall: only the shadow track has teardown state to remove — sibling-track cleanup is an ordinary 'rm -rf <clone-path>'",
  );
}
