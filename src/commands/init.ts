import { parseTrack } from "../args";
import * as siblingInit from "../tracks/sibling/init";
import * as shadowInit from "../tracks/shadow/init";

export function run(args: string[]): void {
  let track, rest;
  try {
    ({ track, rest } = parseTrack(args));
  } catch (err) {
    throw new Error(`init: ${(err as Error).message}`);
  }
  if (track === "sibling") return siblingInit.run(rest);
  if (track === "shadow") return shadowInit.run(rest);
}
