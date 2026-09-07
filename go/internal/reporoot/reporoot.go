// Package reporoot resolves the git repository top level containing a
// directory, ported from src/repo-root.ts.
//
// Anchoring root resolution here (rather than raw os.Getwd) is what makes a
// plan-sync command run from a subdirectory resolve the exact same content
// root — and therefore the same shadow-track project-id and ref — as running
// it from the repo root itself. See finding 9 in docs/HARDENING-HISTORY.md:
// a push from a subdirectory otherwise silently committed an empty tree,
// which a later restore read as "genuinely deleted".
package reporoot

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// ResolveRepoRoot resolves the git top level containing the process's
// current working directory.
func ResolveRepoRoot() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("resolving current directory: %w", err)
	}
	return ResolveRepoRootFrom(cwd)
}

// ResolveRepoRootFrom resolves the git top level containing dir.
func ResolveRepoRootFrom(dir string) (string, error) {
	out, err := exec.Command("git", "-C", dir, "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return "", fmt.Errorf("resolving git repo root from %q: %w", dir, err)
	}
	root := strings.TrimSpace(string(out))
	if root == "" {
		return "", fmt.Errorf("resolving git repo root from %q: empty result", dir)
	}
	return root, nil
}
