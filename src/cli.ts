#!/usr/bin/env node

import * as init from "./commands/init";
import * as allow from "./commands/allow";
import * as unallow from "./commands/unallow";
import * as push from "./commands/push";
import * as pull from "./commands/pull";
import * as restore from "./commands/restore";
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
  restore,
  status,
  uninstall,
};

export const USAGE = `Usage: plan-sync <command> [options]

Commands:
  init       Initialize a sync track (sibling repo or shadow ref)
  allow      Add a path (or glob pattern) to the sync manifest
  unallow    Remove a path (or glob pattern) from the sync manifest
  push       Push manifest-listed files to the sync destination
  pull       Pull manifest-listed files from the sync destination
  restore    Materialize a prior synced state locally
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

  if (!commandName || !(commandName in COMMANDS)) {
    process.stdout.write(USAGE);
    return 1;
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
