package commands

import (
	"fmt"
	"os"
	"path/filepath"

	"plan-sync/go/internal/args"
	"plan-sync/go/internal/glob"
	"plan-sync/go/internal/manifest"
)

const allowHelp = `Usage: plan-sync allow <path-or-glob> [<path-or-glob> ...] [--root <dir>]

Adds one or more paths (or glob patterns) to the sync manifest.

Flags:
  --root <dir>  Root directory to sync (optional, e.g. ".omc")
`

// Allow is the Go port of src/commands/allow.ts:
// `plan-sync allow <path-or-glob> [<path-or-glob> ...] [--root <dir>]`.
//
// Track-agnostic by construction: it only ever edits the manifest file, so
// there is no --track flag and no per-track branch here — the manifest is
// the single scope list both tracks consume.
//
// Every target is added exactly once, VERBATIM, as a single manifest line,
// whether or not it contains glob metacharacters. There is no
// expand-into-N-literal-matches step and no literal-vs-pattern branch: each
// manifest entry is always re-evaluated as a glob at push/status time, and
// a literal filename is just a degenerate pattern that only matches itself.
// The current match count is reported purely as user feedback and is never
// written to the manifest; a pattern matching zero files today is still
// added, since it may start matching later.
func Allow(argv []string) error {
	if args.HasHelpFlag(argv) {
		fmt.Fprint(os.Stdout, allowHelp)
		return nil
	}

	_, rest := args.ParseFlag(argv, "root")
	if len(rest) == 0 {
		return fmt.Errorf("allow: <path> argument is required")
	}

	repoRoot, rootDir, err := resolveContext(argv)
	if err != nil {
		return err
	}
	manifestPath := filepath.Join(repoRoot, rootDir, manifest.ManifestFilename)

	for _, target := range rest {
		if err := allowTarget(manifestPath, target); err != nil {
			return err
		}
	}
	return nil
}

func allowTarget(manifestPath, target string) error {
	if err := manifest.AddToManifest(manifestPath, target); err != nil {
		return err
	}

	// Informational only. The same symlink-safe walk used at push/status
	// time; an unreadable/absent sync root simply reports zero matches
	// rather than failing the add that already succeeded.
	omcRoot := filepath.Dir(manifestPath)
	matches, err := glob.ExpandUnderRoot(omcRoot, target)
	matchCount := 0
	if err == nil {
		matchCount = len(matches)
	}

	fmt.Fprintf(os.Stdout,
		"plan-sync: allow: '%s' added (currently matches %d file(s))\n", target, matchCount)
	return nil
}
