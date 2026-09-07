package sibling

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"plan-sync/go/internal/manifest"
)

// Status is the Go port of src/tracks/sibling/status.ts's run():
// `plan-sync status --track sibling [--root <dir>]`.
//
// Per-file sync report: for each manifest-listed path, the anchor repo's
// copy is compared against the sibling clone's copy by content hash and
// classified as one of
//
//	"in sync"                 — present in both, matching content.
//	"pending (local changes)" — present in both, content differs.
//	"pending (never synced)"  — present locally, absent from the clone.
//	"missing locally"         — present in the clone, absent locally.
//
// A path present in neither falls back to "pending (never synced)", the
// closest fit of the four reported states.
func Status(argv []string) error {
	repoRoot, rootDir, err := resolveContext(argv)
	if err != nil {
		return err
	}

	cfg, err := readSiblingConfig("status", repoRoot, rootDir)
	if err != nil {
		return err
	}
	clonePath := cfg.ClonePath

	// Resolved (live pattern re-evaluation against the current filesystem,
	// plus every literal entry even when currently absent), not the raw
	// manifest lines — this is "what should be reported right now".
	manifestPaths := manifest.ResolveManifestSyncCandidates(manifestPathFor(repoRoot, rootDir))

	inSync := 0
	pendingLocal := 0
	pendingNeverSynced := 0
	missingLocally := 0

	for _, relPath := range manifestPaths {
		localPath := filepath.Join(repoRoot, rootDir, relPath)
		clonedPath := filepath.Join(clonePath, relPath)
		localExists := fileExists(localPath)
		clonedExists := fileExists(clonedPath)

		var state string
		switch {
		case localExists && clonedExists:
			localHash, localErr := sha256File(localPath)
			clonedHash, clonedErr := sha256File(clonedPath)
			if localErr == nil && clonedErr == nil && localHash == clonedHash {
				state = "in sync"
				inSync++
			} else {
				state = "pending (local changes)"
				pendingLocal++
			}
		case localExists:
			state = "pending (never synced)"
			pendingNeverSynced++
		case clonedExists:
			state = "missing locally"
			missingLocally++
		default:
			state = "pending (never synced)"
			pendingNeverSynced++
		}

		fmt.Fprintf(os.Stdout, "plan-sync: %s: %s\n", relPath, state)
	}

	fmt.Fprintf(os.Stdout,
		"plan-sync: %d file(s) tracked — %d in sync, %d pending (local changes), %d pending (never synced), %d missing locally\n",
		len(manifestPaths), inSync, pendingLocal, pendingNeverSynced, missingLocally)
	return nil
}

// sha256File hashes a file's contents. An unreadable file is reported as an
// error, which Status treats as "not identical" rather than aborting the
// whole report.
func sha256File(path string) (string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:]), nil
}
