package shadowpaths

import (
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// git runs a git command in dir with identity/signing pinned, so tests do not
// depend on (or get rejected by) the developer's global git config.
func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	full := append([]string{
		"-C", dir,
		"-c", "user.name=plan-sync test",
		"-c", "user.email=test@example.invalid",
		"-c", "commit.gpgsign=false",
	}, args...)
	out, err := exec.Command("git", full...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// commitFile writes name into dir and commits it, returning the commit hash.
func commitFile(t *testing.T, dir, name, message string) string {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(name+"\n"), 0o644); err != nil {
		t.Fatalf("writing %s: %v", name, err)
	}
	git(t, dir, "add", name)
	git(t, dir, "commit", "-m", message)
	return git(t, dir, "rev-parse", "HEAD")
}

func TestResolveProjectIdUsesRootCommitPrefix(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-q", "-b", "main")
	// In a single-commit repo HEAD *is* the root commit, so the expected id is
	// computed here without reusing the implementation's rev-list call.
	head := commitFile(t, dir, "a.txt", "first")
	commitFile(t, dir, "b.txt", "second")

	want := head[:12]
	got, err := ResolveProjectId(dir)
	if err != nil {
		t.Fatalf("ResolveProjectId: unexpected error: %v", err)
	}
	if got != want {
		t.Errorf("ResolveProjectId = %q, want %q", got, want)
	}
	if len(got) != 12 {
		t.Errorf("ResolveProjectId returned %d characters, want 12", len(got))
	}
}

func TestResolveProjectIdIsStableAcrossSubsequentCommits(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-q", "-b", "main")
	commitFile(t, dir, "a.txt", "first")

	before, err := ResolveProjectId(dir)
	if err != nil {
		t.Fatalf("ResolveProjectId: unexpected error: %v", err)
	}
	commitFile(t, dir, "b.txt", "second")
	after, err := ResolveProjectId(dir)
	if err != nil {
		t.Fatalf("ResolveProjectId: unexpected error: %v", err)
	}
	if before != after {
		t.Errorf("project id changed after a new commit: %q -> %q", before, after)
	}
}

// TestResolveProjectIdPicksLexicallyFirstOfMultipleRootCommits exercises the
// multi-root tie-break: a repo whose history was joined via
// `git merge --allow-unrelated-histories` has two root commits, and both
// implementations must sort them lexically and take the first.
func TestResolveProjectIdPicksLexicallyFirstOfMultipleRootCommits(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-q", "-b", "main")
	firstRoot := commitFile(t, dir, "a.txt", "first history")

	git(t, dir, "checkout", "-q", "--orphan", "other")
	git(t, dir, "rm", "-q", "-rf", ".")
	secondRoot := commitFile(t, dir, "b.txt", "second history")

	git(t, dir, "checkout", "-q", "main")
	git(t, dir, "merge", "-q", "--allow-unrelated-histories", "--no-edit", "other")

	// Guard the setup: without two genuine root commits the lexical tie-break
	// below would pass by coincidence rather than by exercising the sort.
	if reported := strings.Fields(git(t, dir, "rev-list", "--max-parents=0", "HEAD")); len(reported) != 2 {
		t.Fatalf("test setup produced %d root commits, want 2: %v", len(reported), reported)
	}

	roots := []string{firstRoot, secondRoot}
	if roots[0] == roots[1] {
		t.Fatalf("test setup produced a single root commit %q", roots[0])
	}
	sort.Strings(roots)
	want := roots[0][:12]

	got, err := ResolveProjectId(dir)
	if err != nil {
		t.Fatalf("ResolveProjectId: unexpected error: %v", err)
	}
	if got != want {
		t.Errorf("ResolveProjectId = %q, want lexically-first root prefix %q (roots %v)", got, want, roots)
	}
}

func TestResolveProjectIdErrorsOutsideGitRepo(t *testing.T) {
	got, err := ResolveProjectId(t.TempDir())
	if err == nil {
		t.Fatalf("ResolveProjectId = %q, want error outside a git repo", got)
	}
}

func TestResolveShadowRefNameStripsLeadingDotFromRoot(t *testing.T) {
	cases := []struct{ rootDir, want string }{
		{".omc", "refs/plan-sync/abc123def456/omc/data"},
		{".omx", "refs/plan-sync/abc123def456/omx/data"},
		{".adlc", "refs/plan-sync/abc123def456/adlc/data"},
		{"omc", "refs/plan-sync/abc123def456/omc/data"},
	}
	for _, tc := range cases {
		got, err := ResolveShadowRefName("abc123def456", tc.rootDir)
		if err != nil {
			t.Fatalf("ResolveShadowRefName(%q): unexpected error: %v", tc.rootDir, err)
		}
		if got != tc.want {
			t.Errorf("ResolveShadowRefName(%q) = %q, want %q", tc.rootDir, got, tc.want)
		}
	}
}

func TestResolveShadowRefNameRejectsUnsafeRoot(t *testing.T) {
	got, err := ResolveShadowRefName("abc123def456", "...")
	if err == nil {
		t.Fatalf("ResolveShadowRefName(%q) = %q, want error", "...", got)
	}
	if got != "" {
		t.Errorf("ResolveShadowRefName returned %q alongside its error", got)
	}
}

func TestResolveShadowRepoPathUsesStateDirWhenSet(t *testing.T) {
	t.Setenv("PLAN_SYNC_STATE_DIR", "/state")
	t.Setenv("XDG_CACHE_HOME", "/cache")

	got, err := ResolveShadowRepoPath("abc123def456", ".omc")
	if err != nil {
		t.Fatalf("ResolveShadowRepoPath: unexpected error: %v", err)
	}
	want := filepath.Join("/state", "abc123def456", "omc", "plan-sync-shadow.git")
	if got != want {
		t.Errorf("ResolveShadowRepoPath = %q, want %q", got, want)
	}
}

func TestResolveShadowRepoPathFallsBackToXdgCacheHome(t *testing.T) {
	t.Setenv("PLAN_SYNC_STATE_DIR", "")
	t.Setenv("XDG_CACHE_HOME", "/cache")

	// Deliberately *not* parallel in shape with the state-dir branch: a
	// `plan-sync-shadow` namespace dir, and `<root>.git` as the leaf.
	cases := []struct{ rootDir, want string }{
		{".omc", filepath.Join("/cache", "plan-sync-shadow", "abc123def456", "omc.git")},
		{".omx", filepath.Join("/cache", "plan-sync-shadow", "abc123def456", "omx.git")},
	}
	for _, tc := range cases {
		got, err := ResolveShadowRepoPath("abc123def456", tc.rootDir)
		if err != nil {
			t.Fatalf("ResolveShadowRepoPath(%q): unexpected error: %v", tc.rootDir, err)
		}
		if got != tc.want {
			t.Errorf("ResolveShadowRepoPath(%q) = %q, want %q", tc.rootDir, got, tc.want)
		}
	}
}

func TestResolveShadowRepoPathTreatsEmptyStateDirAsUnset(t *testing.T) {
	t.Setenv("PLAN_SYNC_STATE_DIR", "")
	t.Setenv("XDG_CACHE_HOME", "/cache")

	got, err := ResolveShadowRepoPath("abc123def456", ".omc")
	if err != nil {
		t.Fatalf("ResolveShadowRepoPath: unexpected error: %v", err)
	}
	want := filepath.Join("/cache", "plan-sync-shadow", "abc123def456", "omc.git")
	if got != want {
		t.Errorf("ResolveShadowRepoPath = %q, want %q", got, want)
	}
}

// TestResolveShadowRepoPathWithoutHome pins the third branch: no
// PLAN_SYNC_STATE_DIR, no XDG_CACHE_HOME, and no usable $HOME.
//
// Go's os.UserHomeDir fails outright here, but Node's os.homedir() — which the
// TypeScript implementation calls — falls back to a passwd lookup, so this
// port does too (see homeDir). The assertion is therefore: if a passwd entry
// with a home directory exists, the cache path is derived from it exactly as
// if $HOME had been set; only when no home directory can be determined at all
// does the call fail, and then it fails loudly.
func TestResolveShadowRepoPathWithoutHome(t *testing.T) {
	t.Setenv("PLAN_SYNC_STATE_DIR", "")
	t.Setenv("XDG_CACHE_HOME", "")
	t.Setenv("HOME", "")

	got, err := ResolveShadowRepoPath("abc123def456", ".omc")

	current, userErr := user.Current()
	if userErr == nil && current.HomeDir != "" {
		if err != nil {
			t.Fatalf("ResolveShadowRepoPath: unexpected error with a passwd home directory available: %v", err)
		}
		want := filepath.Join(current.HomeDir, ".cache", "plan-sync-shadow", "abc123def456", "omc.git")
		if got != want {
			t.Errorf("ResolveShadowRepoPath = %q, want passwd-derived %q", got, want)
		}
		if !filepath.IsAbs(got) {
			t.Errorf("ResolveShadowRepoPath = %q, want an absolute path", got)
		}
		return
	}

	if err == nil {
		t.Fatalf("ResolveShadowRepoPath = %q, want error when no home directory can be resolved", got)
	}
	if got != "" {
		t.Errorf("ResolveShadowRepoPath returned %q alongside its error", got)
	}
	if !strings.Contains(err.Error(), "home directory") {
		t.Errorf("error %q does not mention the home directory", err)
	}
}
