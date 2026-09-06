import { hasHelpFlag, parseTrack } from "../args";
import * as siblingInit from "../tracks/sibling/init";
import * as shadowInit from "../tracks/shadow/init";

const HELP_TEXT = `Usage: plan-sync init --track <sibling|shadow> [--remote <url>] [--clone-path <path>] [--root <dir>]

Initializes a sync track (sibling repo or shadow git ref) for this repo.

Flags:
  --track <sibling|shadow>  Which sync track to initialize (required)
  --remote <url>            Remote URL (required for sibling; optional for shadow)
  --clone-path <path>       Local path to clone the sibling repo into (required for sibling)
  --root <dir>              Root directory to sync (optional, e.g. ".omc")
`;

export function run(args: string[]): void {
  if (hasHelpFlag(args)) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  let track, rest;
  try {
    ({ track, rest } = parseTrack(args));
  } catch (err) {
    throw new Error(`init: ${(err as Error).message}`);
  }
  if (track === "sibling") return siblingInit.run(rest);
  if (track === "shadow") return shadowInit.run(rest);
}
