package commands

import (
	"fmt"
	"os"

	"plan-sync/go/internal/args"
	"plan-sync/go/internal/tracks/sibling"
)

const pushHelp = `Usage: plan-sync push [--track <sibling|shadow>] [--root <dir>]

Pushes manifest-listed files to the sync destination (sibling repo or
shadow git ref).

Flags:
  --track <sibling|shadow>  Sync track (optional if a default track is persisted)
  --root <dir>              Root directory to sync (optional, e.g. ".omc")
`

// Push is the Go port of src/commands/push.ts.
func Push(argv []string) error {
	if args.HasHelpFlag(argv) {
		fmt.Fprint(os.Stdout, pushHelp)
		return nil
	}

	repoRoot, rootDir, err := resolveContext(argv)
	if err != nil {
		return err
	}

	track, rest, err := resolveTrack("push", argv, repoRoot, rootDir)
	if err != nil {
		return err
	}

	switch track {
	case args.TrackSibling:
		return sibling.Push(rest)
	case args.TrackShadow:
		return ShadowPush(rest)
	}
	return nil
}
