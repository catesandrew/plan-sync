package shadow

import (
	"os"

	"plan-sync/go/internal/shadowpaths"
)

// seedFromLegacyRef seeds the local shadow ref from the origin's legacy-ID ref
// (best effort). The legacy ref on THIS repo's own origin holds its history,
// so the new ref continues it rather than starting empty. Offline, or no
// legacy ref on the remote, is not an error. A no-op when the IDs match or
// the ref already exists. Mirrors seedFromLegacyRef in the TypeScript original.
func seedFromLegacyRef(repoRoot, rootDir string) error {
	id, err := shadowpaths.ResolveProjectId(repoRoot)
	if err != nil {
		return err
	}
	legacy, err := shadowpaths.ResolveLegacyProjectId(repoRoot)
	if err != nil {
		return err
	}
	if id == legacy {
		return nil
	}

	shadowRepoPath, err := shadowpaths.ResolveShadowRepoPath(id, rootDir)
	if err != nil {
		return err
	}
	newRef, err := shadowpaths.ResolveShadowRefName(id, rootDir)
	if err != nil {
		return err
	}
	legacyRef, err := shadowpaths.ResolveShadowRefName(legacy, rootDir)
	if err != nil {
		return err
	}

	gitDir := gitDirFlag(shadowRepoPath)
	if tryGit(gitDir, "rev-parse", "--verify", "-q", newRef) != "" {
		return nil
	}
	// Ref absent on the remote, or offline: start empty, same as a fresh init.
	_, _ = runGit(gitDir, "fetch", "origin", "+"+legacyRef+":"+newRef)
	return nil
}

// adoptLegacyShadow: a repo initialised under the legacy ID has its shadow
// repo at the legacy path. The current ID points elsewhere, so create the new
// one (Init wires it to THIS repo's origin and seeds it) instead of failing
// with "not initialised". The legacy directory is left untouched: it may be
// shared with a sibling repo that has the same root commit.
func adoptLegacyShadow(repoRoot, rootDir string) error {
	id, err := shadowpaths.ResolveProjectId(repoRoot)
	if err != nil {
		return err
	}
	legacy, err := shadowpaths.ResolveLegacyProjectId(repoRoot)
	if err != nil {
		return err
	}
	if id == legacy {
		return nil
	}
	newPath, err := shadowpaths.ResolveShadowRepoPath(id, rootDir)
	if err != nil {
		return err
	}
	if _, err := os.Stat(newPath); err == nil {
		return nil
	}
	legacyPath, err := shadowpaths.ResolveShadowRepoPath(legacy, rootDir)
	if err != nil {
		return err
	}
	if _, err := os.Stat(legacyPath); err != nil {
		return nil
	}
	return Init([]string{"--root", rootDir})
}
