package commands

import (
	"fmt"
	"os"
	"path/filepath"

	"plan-sync/go/internal/args"
	"plan-sync/go/internal/glob"
	"plan-sync/go/internal/manifest"
)

const unallowHelp = `Usage: plan-sync unallow <path-or-glob> [<path-or-glob> ...] [--root <dir>]

Removes one or more paths (or glob patterns) from the sync manifest.
A literal target removes that exact entry; a glob pattern is matched
against current manifest entries and every match is removed.

Flags:
  --root <dir>  Root directory to sync (optional, e.g. ".omc")
`

// Unallow is the Go port of src/commands/unallow.ts:
// `plan-sync unallow <path-or-glob> [<path-or-glob> ...] [--root <dir>]`.
//
// Track-agnostic, exactly like Allow — it only edits the manifest file.
//
// A literal target removes that exact manifest entry (a no-op, not an
// error, if it wasn't present). A pattern containing `*`, `?`, or `[` is
// matched against the manifest's CURRENT ENTRIES rather than the
// filesystem: unlike `allow`, a path may already have been deleted from
// disk while still listed, and `unallow` must still be able to remove it.
func Unallow(argv []string) error {
	if args.HasHelpFlag(argv) {
		fmt.Fprint(os.Stdout, unallowHelp)
		return nil
	}

	_, rest := args.ParseFlag(argv, "root")
	if len(rest) == 0 {
		return fmt.Errorf("unallow: <path> argument is required")
	}

	repoRoot, rootDir, err := resolveContext(argv)
	if err != nil {
		return err
	}
	manifestPath := filepath.Join(repoRoot, rootDir, manifest.ManifestFilename)

	for _, target := range rest {
		if err := unallowTarget(manifestPath, target); err != nil {
			return err
		}
	}
	return nil
}

func unallowTarget(manifestPath, target string) error {
	if !manifest.HasGlobMeta(target) {
		removed, err := manifest.RemoveFromManifest(manifestPath, target)
		if err != nil {
			return err
		}
		if !removed {
			fmt.Fprintf(os.Stderr,
				"plan-sync: unallow: '%s' was not in the manifest (no-op)\n", target)
		}
		return nil
	}

	var matches []string
	for _, entry := range manifest.ReadManifest(manifestPath) {
		if glob.Match(target, entry) {
			matches = append(matches, entry)
		}
	}

	if len(matches) == 0 {
		fmt.Fprintf(os.Stderr,
			"plan-sync: unallow: pattern '%s' matched no manifest entries\n", target)
		return nil
	}

	for _, entry := range matches {
		if _, err := manifest.RemoveFromManifest(manifestPath, entry); err != nil {
			return err
		}
	}

	plural := "ies"
	if len(matches) == 1 {
		plural = "y"
	}
	fmt.Fprintf(os.Stdout,
		"plan-sync: unallow: pattern '%s' removed %d manifest entr%s\n",
		target, len(matches), plural)
	return nil
}
