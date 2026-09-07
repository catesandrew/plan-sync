package commands

import (
	"fmt"
	"os"

	"plan-sync/go/internal/args"
	"plan-sync/go/internal/tracks/sibling"
)

const statusHelp = `Usage: plan-sync status [--track <sibling|shadow>] [--stale-after <duration>] [--root <dir>]

Reports sync freshness/health for the current track.

Flags:
  --track <sibling|shadow>   Sync track (optional if a default track is persisted)
  --stale-after <duration>   Staleness threshold, e.g. "24h", "2d" (shadow track only, default "24h")
  --root <dir>               Root directory to sync (optional, e.g. ".omc")
`

// Status is the Go port of src/commands/status.ts.
func Status(argv []string) error {
	if args.HasHelpFlag(argv) {
		fmt.Fprint(os.Stdout, statusHelp)
		return nil
	}

	repoRoot, rootDir, err := resolveContext(argv)
	if err != nil {
		return err
	}

	track, rest, err := resolveTrack("status", argv, repoRoot, rootDir)
	if err != nil {
		return err
	}

	switch track {
	case args.TrackShadow:
		return ShadowStatus(rest)
	case args.TrackSibling:
		return sibling.Status(rest)
	}
	return nil
}
