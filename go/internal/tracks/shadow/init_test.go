package shadow

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// countExcludeLines counts how many lines of the anchor repo's
// .git/info/exclude are exactly `want`.
func countExcludeLines(t *testing.T, anchorRepo, want string) int {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join(anchorRepo, ".git", "info", "exclude"))
	if err != nil {
		t.Fatalf("reading info/exclude: %v", err)
	}
	n := 0
	for _, line := range strings.Split(string(contents), "\n") {
		if line == want {
			n++
		}
	}
	return n
}

// Ports test/tracks/shadow/init.test.ts's "creates the shadow bare repo,
// configures it, and wires the anchor's origin, without dirtying the anchor
// repo".
func TestInitCreatesConfiguresAndWiresShadowRepo(t *testing.T) {
	f := newFixture(t)

	if err := Init(nil); err != nil {
		t.Fatalf("Init: %v", err)
	}

	shadowRepoPath := f.shadowRepoPath(".omc")
	projectID := f.git(f.anchorRepo, "rev-list", "--max-parents=0", "HEAD")[:12]
	want := filepath.Join(f.stateDir, projectID, "omc", "plan-sync-shadow.git")
	if shadowRepoPath != want {
		t.Fatalf("shadow repo path: got %q, want %q", shadowRepoPath, want)
	}

	assertExists(t, shadowRepoPath)
	info, err := os.Stat(filepath.Join(shadowRepoPath, "HEAD"))
	if err != nil || !info.Mode().IsRegular() {
		t.Fatalf("expected %s/HEAD to be a regular file (err=%v)", shadowRepoPath, err)
	}

	gitDir := "--git-dir=" + shadowRepoPath
	if got := f.git(f.tmpDir, gitDir, "config", "core.autocrlf"); got != "false" {
		t.Fatalf("core.autocrlf: got %q, want %q", got, "false")
	}

	attributesPath := filepath.Join(shadowRepoPath, "info", "attributes")
	attrs, err := os.ReadFile(attributesPath)
	if err != nil {
		t.Fatalf("reading %s: %v", attributesPath, err)
	}
	if !strings.Contains(string(attrs), "-text") {
		t.Fatalf("info/attributes: got %q, want it to contain %q", attrs, "-text")
	}

	if got := f.git(f.tmpDir, gitDir, "remote", "get-url", "origin"); got != f.originRemote {
		t.Fatalf("shadow origin: got %q, want %q", got, f.originRemote)
	}

	if n := countExcludeLines(t, f.anchorRepo, ".omc/"); n != 1 {
		t.Fatalf("info/exclude: got %d %q lines, want 1", n, ".omc/")
	}

	// The `.omc/` exclude entry must land before anything writes into
	// `.omc/`, so the anchor repo's working tree stays clean.
	if status := f.git(f.anchorRepo, "status", "--short"); status != "" {
		t.Fatalf("anchor repo should be clean, got:\n%s", status)
	}
}

// Ports "is idempotent: running init twice does not duplicate the exclude
// entry or fail".
func TestInitIsIdempotent(t *testing.T) {
	f := newFixture(t)

	if err := Init(nil); err != nil {
		t.Fatalf("first Init: %v", err)
	}
	if err := Init(nil); err != nil {
		t.Fatalf("second Init: %v", err)
	}

	if n := countExcludeLines(t, f.anchorRepo, ".omc/"); n != 1 {
		t.Fatalf("info/exclude: got %d %q lines, want 1", n, ".omc/")
	}
	if status := f.git(f.anchorRepo, "status", "--short"); status != "" {
		t.Fatalf("anchor repo should be clean, got:\n%s", status)
	}
	// The second Init must not have re-created (and therefore emptied) an
	// existing shadow repo: a ref written between the two runs survives.
	assertExists(t, f.shadowRepoPath(".omc"))
}

// Ports "does not duplicate the exclude entry when .omc/ was already added
// by a prior (e.g. sibling-track) init".
func TestInitDoesNotDuplicatePreexistingExcludeEntry(t *testing.T) {
	f := newFixture(t)

	excludePath := filepath.Join(f.anchorRepo, ".git", "info", "exclude")
	f.writeFile(excludePath, []byte("some-other-local-only-file\n.omc/\n"))

	if err := Init(nil); err != nil {
		t.Fatalf("Init: %v", err)
	}

	if n := countExcludeLines(t, f.anchorRepo, ".omc/"); n != 1 {
		t.Fatalf("info/exclude: got %d %q lines, want 1", n, ".omc/")
	}
	// The pre-existing unrelated entry must survive untouched.
	contents, err := os.ReadFile(excludePath)
	if err != nil {
		t.Fatalf("reading info/exclude: %v", err)
	}
	if !strings.Contains(string(contents), "some-other-local-only-file") {
		t.Fatalf("pre-existing exclude entry was lost, got: %q", contents)
	}
}

// An exclude file with no trailing newline must not get the new entry glued
// onto its dangling last line.
func TestInitAppendsExcludeEntryAfterMissingTrailingNewline(t *testing.T) {
	f := newFixture(t)

	excludePath := filepath.Join(f.anchorRepo, ".git", "info", "exclude")
	f.writeFile(excludePath, []byte("dangling-last-line"))

	if err := Init(nil); err != nil {
		t.Fatalf("Init: %v", err)
	}

	contents, err := os.ReadFile(excludePath)
	if err != nil {
		t.Fatalf("reading info/exclude: %v", err)
	}
	if string(contents) != "dangling-last-line\n.omc/\n" {
		t.Fatalf("info/exclude: got %q, want %q", contents, "dangling-last-line\n.omc/\n")
	}
}

// Ports "uses an explicit --remote flag instead of the anchor's origin when
// given".
func TestInitUsesExplicitRemoteFlag(t *testing.T) {
	f := newFixture(t)

	explicitRemote := filepath.Join(f.tmpDir, "explicit-remote.git")
	f.git(f.tmpDir, "init", "--bare", explicitRemote)

	if err := Init([]string{"--remote", explicitRemote}); err != nil {
		t.Fatalf("Init: %v", err)
	}

	shadowRepoPath := f.shadowRepoPath(".omc")
	got := f.git(f.tmpDir, "--git-dir="+shadowRepoPath, "remote", "get-url", "origin")
	if got != explicitRemote {
		t.Fatalf("shadow origin: got %q, want %q", got, explicitRemote)
	}
}

// Re-running init with a different --remote must re-point the existing
// origin (set-url) rather than failing on a duplicate remote.
func TestInitRepointsExistingOrigin(t *testing.T) {
	f := newFixture(t)

	if err := Init(nil); err != nil {
		t.Fatalf("first Init: %v", err)
	}
	explicitRemote := filepath.Join(f.tmpDir, "explicit-remote.git")
	f.git(f.tmpDir, "init", "--bare", explicitRemote)
	if err := Init([]string{"--remote", explicitRemote}); err != nil {
		t.Fatalf("second Init: %v", err)
	}

	shadowRepoPath := f.shadowRepoPath(".omc")
	got := f.git(f.tmpDir, "--git-dir="+shadowRepoPath, "remote", "get-url", "origin")
	if got != explicitRemote {
		t.Fatalf("shadow origin: got %q, want %q", got, explicitRemote)
	}
}

// With neither --remote nor an anchor `origin`, init must fail closed with a
// clear error rather than leaving a half-wired shadow repo.
func TestInitFailsWithoutRemoteOrAnchorOrigin(t *testing.T) {
	f := newFixture(t)
	f.git(f.anchorRepo, "remote", "remove", "origin")

	err := Init(nil)
	if err == nil {
		t.Fatal("expected Init to fail with no --remote and no anchor origin")
	}
	if !strings.Contains(err.Error(), "no 'origin' remote") {
		t.Fatalf("error should explain the missing origin, got: %v", err)
	}
}

// Ports "US-010: succeeds when run inside a linked git worktree, where .git
// is a file, not a directory" — the case a hardcoded
// filepath.Join(repoRoot, ".git", "info", "exclude") gets wrong.
func TestInitInsideLinkedWorktree(t *testing.T) {
	f := newFixture(t)

	worktreePath := filepath.Join(f.tmpDir, "anchor-worktree")
	f.git(f.anchorRepo, "worktree", "add", "-b", "wt-branch", worktreePath)

	// Confirm the fixture actually exercises the case under test.
	info, err := os.Stat(filepath.Join(worktreePath, ".git"))
	if err != nil || !info.Mode().IsRegular() {
		t.Fatalf("expected the linked worktree's .git to be a file (err=%v)", err)
	}

	t.Chdir(worktreePath)
	if err := Init(nil); err != nil {
		t.Fatalf("Init inside a linked worktree: %v", err)
	}

	// info/exclude is shared repo-wide (not per-worktree), so the entry must
	// land in the MAIN repo's .git/info/exclude.
	if n := countExcludeLines(t, f.anchorRepo, ".omc/"); n != 1 {
		t.Fatalf("main repo info/exclude: got %d %q lines, want 1", n, ".omc/")
	}
	assertExists(t, f.shadowRepoPath(".omc"))
}

// Init must persist `shadow` as the default track, which is what lets
// `pull` dispatch to this track without an explicit --track.
func TestInitPersistsDefaultTrack(t *testing.T) {
	f := newFixture(t)

	if err := Init(nil); err != nil {
		t.Fatalf("Init: %v", err)
	}

	contents, err := os.ReadFile(f.omcPath(".sync-config.json"))
	if err != nil {
		t.Fatalf("reading .omc/.sync-config.json: %v", err)
	}
	if !strings.Contains(string(contents), `"shadow"`) {
		t.Fatalf("sync-config should record the shadow default track, got: %s", contents)
	}
}
