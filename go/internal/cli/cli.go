// Package cli implements the plan-sync-go command dispatcher, the Go
// equivalent of src/cli.ts. Phase 1 registers exactly six commands (init,
// allow, unallow, push, pull, status) -- there is no uninstall command in
// the Phase 1 binary at all, per .omc/plans/go-port.md's Phase 1 scope.
package cli

import (
	"fmt"
	"os"
)

// Command is the Go equivalent of TS's Command{run(args)void}.
type Command interface {
	Run(args []string) error
}

// CommandFunc adapts a plain function to the Command interface.
type CommandFunc func(args []string) error

func (f CommandFunc) Run(args []string) error { return f(args) }

// Commands is populated by main() with the real command implementations as
// each lands (US-010). Left as a package-level var (not a literal map) so
// main can register commands without an import cycle.
var Commands = map[string]Command{}

// ImplementationID is the `<impl>/<version>` half of the stderr identity
// marker. Its TS counterpart is IMPLEMENTATION_ID in src/cli.ts.
const ImplementationID = "go/0.1.0"

// mutatingCommands lists the commands that mutate something -- the
// manifest, .sync-config.json, the local working tree, the clone, or the
// remote. `status` is deliberately absent: it is read-only, so it emits no
// identity marker. (There is no `uninstall` in the Phase 1 binary at all;
// its TS counterpart IS on the TS side's list.)
var mutatingCommands = map[string]bool{
	"init":    true,
	"allow":   true,
	"unallow": true,
	"push":    true,
	"pull":    true,
}

// writeIdentityMarker writes the one-line $PATH-collision identity marker
// to stderr, mirroring src/cli.ts's writeIdentityMarker.
//
// Two same-purpose binaries (the npm-linked TS `plan-sync` and this
// `plan-sync-go`) can both be on a user's $PATH, and nothing in the output
// of a mutating command otherwise says which one ran it. So every mutating
// command announces itself -- as the FIRST thing on stderr, before any
// warning or error -- in a shape that is unambiguously greppable and cannot
// be confused with the "plan-sync: <message>" error prefix used everywhere
// else: the payload is always "<impl>/<version> (<command>)", e.g.
// "plan-sync: go/0.1.0 (push)" vs. "plan-sync: ts/0.1.0 (push)".
//
// Emitted per COMMAND NAME, not per side effect: `push --help` mutates
// nothing but still prints the marker, because the question the marker
// answers ("which binary is this?") is exactly the one a user asking for
// help has.
func writeIdentityMarker(commandName string) {
	fmt.Fprintf(os.Stderr, "plan-sync: %s (%s)\n", ImplementationID, commandName)
}

const Usage = `Usage: plan-sync <command> [options]

Commands:
  init       Initialize a sync track (sibling repo or shadow ref)
  allow      Add a path (or glob pattern) to the sync manifest
  unallow    Remove a path (or glob pattern) from the sync manifest
  push       Push manifest-listed files to the sync destination
  pull       Pull/materialize manifest-listed files from the sync destination
  status     Report sync freshness/health

Run "plan-sync <command> --help" for command-specific options.
`

// Dispatch mirrors src/cli.ts's dispatch(): parses argv (command name +
// remaining args), routes to the matching command, and returns the process
// exit code. Unknown/missing commands print usage and return 1. A command
// error is reported to stderr as "plan-sync: <message>" and also returns 1.
func Dispatch(argv []string) int {
	if len(argv) == 0 {
		fmt.Fprint(os.Stdout, Usage)
		return 1
	}

	commandName, rest := argv[0], argv[1:]

	if commandName == "--help" || commandName == "-h" {
		fmt.Fprint(os.Stdout, Usage)
		return 0
	}

	cmd, ok := Commands[commandName]
	if !ok {
		fmt.Fprint(os.Stdout, Usage)
		return 1
	}

	if mutatingCommands[commandName] {
		writeIdentityMarker(commandName)
	}

	if err := cmd.Run(rest); err != nil {
		fmt.Fprintf(os.Stderr, "plan-sync: %s\n", err.Error())
		return 1
	}
	return 0
}
