#!/usr/bin/env node

import * as init from "./commands/init";
import * as allow from "./commands/allow";
import * as unallow from "./commands/unallow";
import * as push from "./commands/push";
import * as pull from "./commands/pull";
import * as status from "./commands/status";
import * as uninstall from "./commands/uninstall";

export type Command = {
  run(args: string[]): void;
};

export const COMMANDS: Record<string, Command> = {
  init,
  allow,
  unallow,
  push,
  pull,
  status,
  uninstall,
};

/**
 * `<impl>/<version>` half of the stderr identity marker.
 *
 * Kept in sync by hand with `package.json`'s `version` (importing it would
 * pull package.json into `dist/` via `rootDir`-relative emit, which is not
 * worth it for one string).
 */
export const IMPLEMENTATION_ID = "ts/0.1.0";

/**
 * Commands that mutate something — the manifest, `.sync-config.json`, the
 * local working tree, the clone, or the remote. `status` is deliberately
 * absent: it is read-only, so it emits no identity marker.
 */
export const MUTATING_COMMANDS = new Set([
  "init",
  "allow",
  "unallow",
  "push",
  "pull",
  "uninstall",
]);

/**
 * Writes the one-line `$PATH`-collision identity marker to stderr.
 *
 * Two same-purpose binaries (the npm-linked TS `plan-sync` and the Go
 * `plan-sync-go`) can both be on a user's `$PATH`, and nothing in the
 * output of a mutating command otherwise says which one ran it. So every
 * mutating command announces itself — as the FIRST thing on stderr, before
 * any warning or error — in a shape that is unambiguously greppable and
 * cannot be confused with the `plan-sync: <message>` error prefix used
 * everywhere else: the payload is always `<impl>/<version> (<command>)`,
 * e.g. `plan-sync: ts/0.1.0 (push)` vs. `plan-sync: go/0.1.0 (push)`.
 *
 * Emitted per *command name*, not per side effect: `push --help` mutates
 * nothing but still prints the marker, because the question the marker
 * answers ("which binary is this?") is exactly the one a user asking for
 * help has.
 */
function writeIdentityMarker(commandName: string): void {
  process.stderr.write(`plan-sync: ${IMPLEMENTATION_ID} (${commandName})\n`);
}

export const USAGE = `Usage: plan-sync <command> [options]

Commands:
  init       Initialize a sync track (sibling repo or shadow ref)
  allow      Add a path (or glob pattern) to the sync manifest
  unallow    Remove a path (or glob pattern) from the sync manifest
  push       Push manifest-listed files to the sync destination
  pull       Pull/materialize manifest-listed files from the sync destination
  status     Report sync freshness/health
  uninstall  Remove sync configuration and state

Run "plan-sync <command> --help" for command-specific options.
`;

/**
 * Dispatches a parsed argv (command name + remaining args) to the
 * corresponding command module. Returns the process exit code.
 *
 * No-op / unknown commands print usage text and return a non-zero code.
 * Known commands currently throw "not implemented" stubs (by design —
 * their real logic ships in later stories); such errors are caught here,
 * reported to stderr, and also result in a non-zero exit code.
 */
export function dispatch(argv: string[]): number {
  const [commandName, ...rest] = argv;

  if (commandName === "--help" || commandName === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (!commandName || !(commandName in COMMANDS)) {
    process.stdout.write(USAGE);
    return 1;
  }

  if (MUTATING_COMMANDS.has(commandName)) {
    writeIdentityMarker(commandName);
  }

  try {
    COMMANDS[commandName].run(rest);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`plan-sync: ${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(dispatch(process.argv.slice(2)));
}
