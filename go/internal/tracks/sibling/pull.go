package sibling

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"plan-sync/go/internal/manifest"
	"plan-sync/go/internal/safewrite"
)

// Pull is the Go port of src/tracks/sibling/pull.ts's run():
// `plan-sync pull --track sibling [--root <dir>]`.
//
// Rebases the clone onto the remote (surfacing a genuine concurrent edit as
// a real git conflict, markers intact, rather than resolving it silently),
// UNION-merges the incoming manifest into the local one, then materializes
// every locally-listed path from the clone — removing the local copy of any
// path the clone no longer has.
func Pull(argv []string) error {
	repoRoot, rootDir, err := resolveContext(argv)
	if err != nil {
		return err
	}

	cfg, err := readSiblingConfig("pull", repoRoot, rootDir)
	if err != nil {
		return err
	}
	clonePath := cfg.ClonePath

	branch, err := gitOutput(clonePath, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return err
	}

	if _, err := git(clonePath, "pull", "--rebase", "origin", branch); err != nil {
		return fmt.Errorf(
			"pull --track sibling: merge conflict during rebase — resolve manually in %s then re-run\n%w",
			clonePath, err)
	}

	// Merge the incoming manifest (if the clone has one) into the local
	// manifest BEFORE the copy-in step below, and re-read the local
	// manifest fresh afterward — so a completely fresh machine (empty local
	// manifest, never `allow`-ed anything) still gets both the manifest AND
	// the content it lists from a single `pull`, rather than having to
	// manually `allow` each path first and pull a second time.
	localManifestPath := manifestPathFor(repoRoot, rootDir)
	mergeIncomingManifestFromClone(clonePath, localManifestPath)

	manifestPaths := manifest.ReadManifest(localManifestPath)
	syncManifestFilesFromClone(repoRoot, rootDir, clonePath, manifestPaths)
	return nil
}

// syncManifestFilesFromClone materializes each manifest-listed path from
// the clone into the anchor repo's sync root; if the path does not exist in
// the clone (deleted upstream), the local copy is removed instead. That is
// the entire deletion-propagation mechanism — no tree-diff engine, just
// "does the manifest-listed path exist in the clone or not".
//
// Both branches go through internal/safewrite, so neither the copy-in nor
// the deletion can escape the sync root via a symlinked path component
// (docs/HARDENING-HISTORY.md finding 11 found both of these specific call
// sites unguarded in the TypeScript original).
func syncManifestFilesFromClone(repoRoot, rootDir, clonePath string, manifestPaths []string) {
	omcRoot := filepath.Join(repoRoot, rootDir)

	for _, relPath := range manifestPaths {
		src := filepath.Join(clonePath, relPath)
		dest := filepath.Join(omcRoot, relPath)

		if !fileExists(src) {
			// Removed upstream (deletion propagation) — remove the anchor
			// repo's copy too, if present.
			safewrite.SafeRemove(omcRoot, dest)
			continue
		}

		if isSymlink(src) {
			fmt.Fprintf(os.Stderr,
				"plan-sync: skipping symlink %s — symlinks are not synced\n", relPath)
			continue
		}

		safewrite.SafeCopyFile(omcRoot, src, dest)
	}
}

// mergeIncomingManifestFromClone UNION-merges each valid line of the
// clone's own manifest (pushed there by a peer machine) into the local
// manifest via manifest.AddToManifest — additive only, so a pre-existing
// local-only entry the incoming manifest doesn't mention is never removed
// or overwritten. Mirrors ReadManifest's blank/comment-skipping parse rules.
func mergeIncomingManifestFromClone(clonePath, localManifestPath string) {
	incomingPath := filepath.Join(clonePath, manifest.ManifestFilename)

	info, err := os.Lstat(incomingPath)
	if err != nil {
		return
	}
	if info.Mode()&os.ModeSymlink != 0 {
		fmt.Fprintf(os.Stderr,
			"plan-sync: skipping symlink %s — symlinks are not synced\n",
			manifest.ManifestFilename)
		return
	}

	raw, err := os.ReadFile(incomingPath)
	if err != nil {
		return
	}

	for _, rawLine := range strings.Split(string(raw), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if err := manifest.AddToManifest(localManifestPath, line); err != nil {
			fmt.Fprintf(os.Stderr,
				"plan-sync: skipping invalid incoming manifest entry '%s': %v\n", line, err)
		}
	}
}
