import { parseTrack } from "../args";
import * as shadowStatus from "../tracks/shadow/status";

export function run(args: string[]): void {
  let track, rest;
  try {
    ({ track, rest } = parseTrack(args));
  } catch (err) {
    throw new Error(`status: ${(err as Error).message}`);
  }
  if (track === "shadow") return shadowStatus.run(rest);
  throw new Error("status: only the shadow track has a status surface currently");
}
