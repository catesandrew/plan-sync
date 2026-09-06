import { parseTrack } from "../args";
import * as siblingPush from "../tracks/sibling/push";
import * as shadowPush from "../tracks/shadow/push";

export function run(args: string[]): void {
  let track, rest;
  try {
    ({ track, rest } = parseTrack(args));
  } catch (err) {
    throw new Error(`push: ${(err as Error).message}`);
  }
  if (track === "sibling") return siblingPush.run(rest);
  if (track === "shadow") return shadowPush.run(rest);
}
