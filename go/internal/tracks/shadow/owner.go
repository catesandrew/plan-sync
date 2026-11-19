package shadow

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const ownerKey = "plan-sync.owner"

// ownerOf is the checkout's git common dir, so linked worktrees of one repo
// count as one owner. Mirrors ownerOf in the TypeScript original.
func ownerOf(repoRoot string) (string, error) {
	out, err := runGit("-C", repoRoot, "rev-parse", "--git-common-dir")
	if err != nil {
		return "", err
	}
	common := strings.TrimSpace(out)
	if !filepath.IsAbs(common) {
		common = filepath.Join(repoRoot, common)
	}
	return filepath.EvalSymlinks(common)
}

// checkShadowOwner refuses to use a shadow repo that another checkout owns.
// Two different repos that resolve to the same shadow repo would overwrite
// each other's ref and push into each other's remote, so fail loudly instead.
// An unset owner (a repo created before this check) is claimed when claim is
// true, and so is an owner whose directory no longer exists (the repo moved).
func checkShadowOwner(shadowRepoPath, repoRoot string, claim bool) error {
	if _, err := os.Stat(shadowRepoPath); err != nil {
		return nil
	}
	gitDir := gitDirFlag(shadowRepoPath)
	me, err := ownerOf(repoRoot)
	if err != nil {
		return err
	}
	owner := strings.TrimSpace(tryGit(gitDir, "config", "--get", ownerKey))
	if owner == me {
		return nil
	}
	if owner != "" {
		if _, err := os.Stat(owner); err == nil {
			return fmt.Errorf(
				"shadow repo at %s belongs to %s, not %s — two repos are sharing one shadow repo (usually the same root commit). Remove it, or fix the other repo, before syncing from here",
				shadowRepoPath, owner, me)
		}
	}
	if claim {
		if _, err := runGit(gitDir, "config", ownerKey, me); err != nil {
			return err
		}
	}
	return nil
}
