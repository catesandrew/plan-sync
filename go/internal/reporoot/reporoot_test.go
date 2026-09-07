package reporoot

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// newRepo initializes a real git repo in a temp dir and returns its
// realpath-resolved top level (macOS /var -> /private/var symlinks otherwise
// make the comparison below spuriously fail).
func newRepo(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("eval symlinks: %v", err)
	}
	cmd := exec.Command("git", "init", "-q", dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}
	return dir
}

func TestResolveRepoRootFromRepoRoot(t *testing.T) {
	repo := newRepo(t)

	got, err := ResolveRepoRootFrom(repo)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != repo {
		t.Fatalf("got %q, want %q", got, repo)
	}
}

// TestResolveRepoRootFromSubdirectory is finding 9's regression: running from
// a subdirectory must resolve the same root as running from the repo root,
// rather than the subdirectory itself (as raw os.Getwd would return).
func TestResolveRepoRootFromSubdirectory(t *testing.T) {
	repo := newRepo(t)
	sub := filepath.Join(repo, "nested", "deeper")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	fromRoot, err := ResolveRepoRootFrom(repo)
	if err != nil {
		t.Fatalf("unexpected error from repo root: %v", err)
	}
	fromSub, err := ResolveRepoRootFrom(sub)
	if err != nil {
		t.Fatalf("unexpected error from subdirectory: %v", err)
	}

	if fromSub != fromRoot {
		t.Fatalf("subdirectory resolved %q, repo root resolved %q", fromSub, fromRoot)
	}
	if fromSub == sub {
		t.Fatalf("resolved the subdirectory %q instead of the repo top level", sub)
	}
}

func TestResolveRepoRootUsesProcessWorkingDirectory(t *testing.T) {
	repo := newRepo(t)
	sub := filepath.Join(repo, "nested")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Chdir(sub)

	got, err := ResolveRepoRoot()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != repo {
		t.Fatalf("got %q, want %q", got, repo)
	}
}

func TestResolveRepoRootFromOutsideAnyRepoErrors(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("eval symlinks: %v", err)
	}
	// GIT_CEILING_DIRECTORIES stops git from walking up into a real repo
	// that may contain the system temp directory.
	t.Setenv("GIT_CEILING_DIRECTORIES", filepath.Dir(dir))

	if got, err := ResolveRepoRootFrom(dir); err == nil {
		t.Fatalf("got %q, want an error outside any git repo", got)
	}
}
