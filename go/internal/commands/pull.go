package commands

import (
	"fmt"
	"os"

	"plan-sync/go/internal/args"
	"plan-sync/go/internal/tracks/sibling"
)

const pullHelp = `Usage: plan-sync pull [--track <sibling|shadow>] [--ref <sha-or-ref>] [--root <dir>]

Pulls/materializes manifest-listed files from the sync destination
(sibling repo or shadow git ref) back onto disk.

Flags:
  --track <sibling|shadow>  Sync track (optional if a default track is persisted)
  --ref <sha-or-ref>        Ref/commit to restore from (shadow track only, optional)
  --root <dir>              Root directory to sync (optional, e.g. ".omc")
`

// Pull is the Go port of src/commands/pull.ts. `pull --track shadow` is the
// shadow track's restore (the separate top-level `restore` command was
// folded into `pull`), which is why the shadow branch routes to ShadowPull
// rather than to a "shadow pull" of its own.
func Pull(argv []string) error {
	if args.HasHelpFlag(argv) {
		fmt.Fprint(os.Stdout, pullHelp)
		return nil
	}

	repoRoot, rootDir, err := resolveContext(argv)
	if err != nil {
		return err
	}

	track, rest, err := resolveTrack("pull", argv, repoRoot, rootDir)
	if err != nil {
		return err
	}

	switch track {
	case args.TrackSibling:
		return sibling.Pull(rest)
	case args.TrackShadow:
		return ShadowPull(rest)
	}
	return nil
}
