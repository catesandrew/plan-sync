// Package shadowpaths derives the shadow track's identity and locations —
// the repo's project-id, the remote ref it pushes to, and the on-disk path
// of the local bare shadow repo — ported from src/tracks/shadow/paths.ts.
//
// Everything here is scoped by both the project-id and the (dot-stripped)
// root segment, so two roots (e.g. `.omc` and `.omx`) tracked against the
// same repo/remote never collide on either the ref or the local cache path.
package shadowpaths

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"sort"
	"strings"

	"plan-sync/go/internal/root"
)

const shadowRepoFilename = "plan-sync-shadow.git"

// projectIDLength is the number of leading hex characters of the root commit
// hash used as the project id.
const projectIDLength = 12

// ResolveProjectId derives a stable, deterministic project id for repoRoot:
// the first 12 hex characters of the repo's root commit hash
// (`git rev-list --max-parents=0 HEAD`) — git's own content-addressed
// identity for "this is the same repository history".
//
// This is intentionally independent of the `origin` remote URL: renaming the
// remote, renaming the repo on its host, switching between SSH/HTTPS remotes,
// or moving to a different host entirely all leave the root commit (and
// therefore the project id) unchanged.
//
// A repo can have more than one root commit (e.g. histories joined via
// `git merge --allow-unrelated-histories`); when `rev-list` reports multiple,
// they are sorted lexically and the first is used, so every clone/machine
// deterministically picks the same one regardless of commit order. This
// matches the TypeScript implementation's `.sort()` + `[0]` exactly — the two
// binaries must agree on the project id for the same repo.
func ResolveProjectId(repoRoot string) (string, error) {
	out, err := exec.Command("git", "-C", repoRoot, "rev-list", "--max-parents=0", "HEAD").Output()
	if err != nil {
		return "", fmt.Errorf("listing root commits for repository at %q: %w", repoRoot, err)
	}

	var rootHashes []string
	for _, line := range strings.Split(string(out), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			rootHashes = append(rootHashes, trimmed)
		}
	}
	// Lexical sort, first wins — deterministic across clones and machines.
	sort.Strings(rootHashes)

	if len(rootHashes) == 0 {
		return "", fmt.Errorf("no root commit found for repository at %q", repoRoot)
	}

	rootHash := rootHashes[0]
	if len(rootHash) < projectIDLength {
		return "", fmt.Errorf(
			"root commit hash %q for repository at %q is shorter than %d characters",
			rootHash, repoRoot, projectIDLength,
		)
	}
	return rootHash[:projectIDLength], nil
}

// ResolveShadowRefName resolves the shadow-track ref name for
// projectId/rootDir: `refs/plan-sync/<project-id>/<root>/data`, outside
// `refs/heads/*`/`refs/tags/*` (so it is invisible to `git branch -a` /
// `git log --all`), and including rootDir's dot-stripped segment so two roots
// tracked against the same repo/remote push to distinct refs.
//
// It returns an error rather than a bare string (the TypeScript original
// throws here) because root.RootSegment rejects roots whose stripped form is
// unsafe — notably "..." -> ".." — and swallowing that would reopen the
// path/refname escape that check exists to close.
func ResolveShadowRefName(projectId, rootDir string) (string, error) {
	segment, err := root.RootSegment(rootDir)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("refs/plan-sync/%s/%s/data", projectId, segment), nil
}

// ResolveShadowRepoPath resolves the on-disk path of the (bare) shadow git
// repo for projectId, scoped under rootDir (e.g. `.omc`, `.omx`) so two roots
// tracked against the same repo/remote never collide:
//
//   - `${PLAN_SYNC_STATE_DIR}/<project-id>/<root>/plan-sync-shadow.git`
//     when PLAN_SYNC_STATE_DIR is set
//   - else `${XDG_CACHE_HOME:-<home>/.cache}/plan-sync-shadow/<project-id>/<root>.git`
//
// Note the two branches are deliberately not structurally parallel: the
// explicit-state-dir branch nests the root segment as a directory and uses a
// fixed `plan-sync-shadow.git` filename, while the cache branch inserts a
// `plan-sync-shadow` namespace directory and uses `<root>.git` as the leaf.
// This mirrors the TypeScript implementation, which the on-disk layout of
// existing installs already depends on.
func ResolveShadowRepoPath(projectId, rootDir string) (string, error) {
	segment, err := root.RootSegment(rootDir)
	if err != nil {
		return "", err
	}

	// Empty-string env vars are treated as unset, matching the TypeScript
	// original's truthiness checks (`if (env.PLAN_SYNC_STATE_DIR)` and
	// `env.XDG_CACHE_HOME || ...`).
	if stateDir := os.Getenv("PLAN_SYNC_STATE_DIR"); stateDir != "" {
		return filepath.Join(stateDir, projectId, segment, shadowRepoFilename), nil
	}

	cacheHome := os.Getenv("XDG_CACHE_HOME")
	if cacheHome == "" {
		home, err := homeDir()
		if err != nil {
			return "", err
		}
		cacheHome = filepath.Join(home, ".cache")
	}
	return filepath.Join(cacheHome, "plan-sync-shadow", projectId, segment+".git"), nil
}

// homeDir resolves the user's home directory the way Node's `os.homedir()`
// (which the TypeScript implementation calls) does, rather than the way Go's
// os.UserHomeDir does.
//
// os.UserHomeDir reads $HOME and nothing else: it fails outright when $HOME is
// unset or empty. Node's os.homedir() falls back to a passwd lookup
// (getpwuid) when $HOME is unset, so the TypeScript binary keeps working in
// environments that don't export $HOME (systemd units, cron, minimal
// containers). Erroring here would have made the Go binary refuse to run where
// the TypeScript one succeeds, and — worse — would have made the two disagree
// about where the shadow repo lives. So the passwd lookup is replicated via
// os/user.
//
// One documented, tested divergence remains, logged here per
// docs/HARDENING-HISTORY.md's F1/F2/F3 ledger pattern (Fix 5, completion
// review round 1): with HOME set to the *empty string* (not unset) and
// XDG_CACHE_HOME/PLAN_SYNC_STATE_DIR also unset, TypeScript's
// resolveShadowRepoPath (src/tracks/shadow/paths.ts) now throws — it used to
// silently build the relative path ".cache/plan-sync-shadow/...", which was
// a real bug, fixed alongside this port (see progress.txt) to fail loudly
// instead. Go, here, treats empty $HOME the same as unset and falls back to
// passwd via os/user, succeeding where TS now (correctly) refuses. Both
// behaviors are SAFE — neither reproduces the old repo-relative-path bug —
// but they differ: TS errors, Go resolves a real absolute path. This is a
// Tier-1 shadow-repo-path parity gap in the one narrow HOME="" case,
// arguably out of US-007 AC4's literal scope (which gates the HOME-UNSET
// case, where both sides agree), left as-is rather than picked one way,
// since either direction (TS falling back too, or Go also refusing) is a
// defensible choice a maintainer should make deliberately, not this port.
func homeDir() (string, error) {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return home, nil
	}
	current, err := user.Current()
	if err != nil {
		return "", fmt.Errorf(
			"resolving home directory for the shadow repo cache path (set XDG_CACHE_HOME or PLAN_SYNC_STATE_DIR): %w",
			err,
		)
	}
	if current.HomeDir == "" {
		return "", fmt.Errorf(
			"resolving home directory for the shadow repo cache path: user %q has no home directory (set XDG_CACHE_HOME or PLAN_SYNC_STATE_DIR)",
			current.Username,
		)
	}
	return current.HomeDir, nil
}
