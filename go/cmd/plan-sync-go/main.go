// Command plan-sync-go is the Go port of plan-sync (Phase 1). See
// .omc/plans/go-port.md for scope: init, allow, unallow, push, pull, status
// are implemented; there is no uninstall command in Phase 1.
package main

import (
	"os"

	"plan-sync/go/internal/cli"
	"plan-sync/go/internal/commands"
)

func init() {
	// Every command routes through internal/commands, which owns the
	// --help/--track/--root handling and the per-track dispatch. The
	// sibling track is fully implemented; the shadow track's entry points
	// are reached through the seams in internal/commands/shadow.go, where
	// Phase 1's `init`/`pull` are wired to internal/tracks/shadow and
	// `push`/`status` report that they are Phase 2.
	cli.Commands["init"] = cli.CommandFunc(commands.Init)
	cli.Commands["allow"] = cli.CommandFunc(commands.Allow)
	cli.Commands["unallow"] = cli.CommandFunc(commands.Unallow)
	cli.Commands["push"] = cli.CommandFunc(commands.Push)
	cli.Commands["pull"] = cli.CommandFunc(commands.Pull)
	cli.Commands["status"] = cli.CommandFunc(commands.Status)
}

func main() {
	os.Exit(cli.Dispatch(os.Args[1:]))
}
