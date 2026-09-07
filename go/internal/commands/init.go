package commands

import (
	"fmt"
	"os"

	"plan-sync/go/internal/args"
	"plan-sync/go/internal/tracks/sibling"
)

const initHelp = `Usage: plan-sync init --track <sibling|shadow> [--remote <url>] [--clone-path <path>] [--root <dir>]

Initializes a sync track (sibling repo or shadow git ref) for this repo.

Flags:
  --track <sibling|shadow>  Which sync track to initialize (required)
  --remote <url>            Remote URL (required for sibling; optional for shadow)
  --clone-path <path>       Local path to clone the sibling repo into (required for sibling)
  --root <dir>              Root directory to sync (optional, e.g. ".omc")

Phase 1 limitation: 'init --track shadow' creates real local (and, once
pushed by the TS binary, remote) shadow state, but 'push'/'status' for the
shadow track are not available until Phase 2 in this binary — you cannot
yet push, check status on, or uninstall shadow state created here.
`

// Init is the Go port of src/commands/init.ts.
//
// Unlike push/pull/status, `init` never falls back to a persisted default
// track: it is the command that ESTABLISHES the default, so an explicit
// --track is always required.
func Init(argv []string) error {
	if args.HasHelpFlag(argv) {
		fmt.Fprint(os.Stdout, initHelp)
		return nil
	}

	track, rest, err := args.ParseTrack(argv, "")
	if err != nil {
		return fmt.Errorf("init: %w", err)
	}

	switch track {
	case args.TrackSibling:
		return sibling.Init(rest)
	case args.TrackShadow:
		return ShadowInit(rest)
	}
	return nil
}
