package sibling

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixture is the single-machine setup shared by the init/push tests: one
// anchor repo, one bare "remote", and the clone path init will create.
// Ported from test/tracks-sibling.test.ts's beforeEach.
type fixture struct {
	tmpRoot string
	anchor  string
	remote  string
	clone   string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()

	tmpRoot := realTempDir(t)
	f := &fixture{
		tmpRoot: tmpRoot,
		anchor:  filepath.Join(tmpRoot, "anchor"),
		remote:  filepath.Join(tmpRoot, "remote.git"),
		clone:   filepath.Join(tmpRoot, "sibling-clone"),
	}

	newAnchorRepo(t, f.anchor)
	newBareRemote(t, f.remote)
	t.Chdir(f.anchor)

	return f
}

// initSibling runs the real `init --track sibling` against the fixture.
func (f *fixture) initSibling(t *testing.T) {
	t.Helper()
	if err := Init([]string{"--remote", f.remote, "--clone-path", f.clone}); err != nil {
		t.Fatalf("Init: %v", err)
	}
}

func (f *fixture) omc(parts ...string) string {
	return filepath.Join(append([]string{f.anchor, ".omc"}, parts...)...)
}

// --- init -------------------------------------------------------------

func TestInitExcludesRootViaGitInfoExcludeAndLeavesStatusClean(t *testing.T) {
	f := newFixture(t)

	f.initSibling(t)

	excludeContents := readFile(t, filepath.Join(f.anchor, ".git", "info", "exclude"))
	found := false
	for _, line := range strings.Split(excludeContents, "\n") {
		if strings.TrimSpace(line) == ".omc/" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected .git/info/exclude to contain %q, got:\n%s", ".omc/", excludeContents)
	}

	if status := strings.TrimSpace(runGit(t, f.anchor, "status", "--short")); status != "" {
		t.Fatalf("expected a clean git status after init, got:\n%s", status)
	}
}

func TestInitIsIdempotentOnRepeatedRuns(t *testing.T) {
	f := newFixture(t)

	f.initSibling(t)
	if err := Init([]string{"--remote", f.remote, "--clone-path", f.clone}); err != nil {
		t.Fatalf("second Init should be a no-op, got: %v", err)
	}

	// The exclude entry must not be duplicated by the second run either.
	excludeContents := readFile(t, filepath.Join(f.anchor, ".git", "info", "exclude"))
	if got := strings.Count(excludeContents, ".omc/"); got != 1 {
		t.Fatalf("expected exactly one %q entry in info/exclude, got %d:\n%s",
			".omc/", got, excludeContents)
	}
}

func TestInitRequiresRemoteAndClonePath(t *testing.T) {
	f := newFixture(t)

	err := Init([]string{"--clone-path", f.clone})
	if err == nil || !strings.Contains(err.Error(), "--remote") {
		t.Fatalf("expected an error naming --remote, got: %v", err)
	}

	err = Init([]string{"--remote", f.remote})
	if err == nil || !strings.Contains(err.Error(), "--clone-path") {
		t.Fatalf("expected an error naming --clone-path, got: %v", err)
	}
}

func TestInitErrorsWhenClonePathExistsButIsNotAGitRepo(t *testing.T) {
	f := newFixture(t)

	if err := os.MkdirAll(f.clone, 0o755); err != nil {
		t.Fatalf("creating non-repo clone path: %v", err)
	}

	err := Init([]string{"--remote", f.remote, "--clone-path", f.clone})
	if err == nil || !strings.Contains(err.Error(), "not a git repository") {
		t.Fatalf("expected a 'not a git repository' error, got: %v", err)
	}
}

// TestInitInsideLinkedWorktree covers the case where `.git` is a FILE (a
// "gitdir:" pointer) rather than a directory: info/exclude is shared
// repo-wide, so the entry must land in the MAIN repo's exclude file, which
// only works because the path is resolved via `git rev-parse --git-path`.
func TestInitInsideLinkedWorktree(t *testing.T) {
	f := newFixture(t)

	worktree := filepath.Join(f.tmpRoot, "anchor-worktree")
	// A worktree cannot be added from a repo with no commits.
	writeFile(t, filepath.Join(f.anchor, "seed.txt"), "seed\n")
	runGit(t, f.anchor, "add", "seed.txt")
	if _, err := runGitEnv(t, f.anchor, testCommitEnv, "commit", "-m", "seed"); err != nil {
		t.Fatalf("seeding anchor repo: %v", err)
	}
	runGit(t, f.anchor, "worktree", "add", "-b", "wt-branch", worktree)

	info, err := os.Stat(filepath.Join(worktree, ".git"))
	if err != nil || info.IsDir() {
		t.Fatalf("fixture precondition: expected %s/.git to be a file, err=%v", worktree, err)
	}

	t.Chdir(worktree)
	worktreeClone := filepath.Join(f.tmpRoot, "sibling-clone-worktree")
	if err := Init([]string{"--remote", f.remote, "--clone-path", worktreeClone}); err != nil {
		t.Fatalf("Init inside a linked worktree: %v", err)
	}

	excludeContents := readFile(t, filepath.Join(f.anchor, ".git", "info", "exclude"))
	if !strings.Contains(excludeContents, ".omc/") {
		t.Fatalf("expected the MAIN repo's info/exclude to contain %q, got:\n%s",
			".omc/", excludeContents)
	}
	if !exists(worktreeClone) {
		t.Fatalf("expected the clone at %s to exist", worktreeClone)
	}
}

// --- push -------------------------------------------------------------

// TestPushCopiesExactlyTheManifestListedFiles is AC-A4: init + allow two
// files + push results in exactly those files (plus the manifest itself),
// committed, in the clone AND on the remote — and nothing else.
func TestPushCopiesExactlyTheManifestListedFiles(t *testing.T) {
	f := newFixture(t)
	f.initSibling(t)

	writeFile(t, f.omc("notes.md"), "synced notes\n")
	writeFile(t, f.omc("plans", "foo.md"), "synced plan\n")
	// Not in the manifest — must never be copied or pushed.
	writeFile(t, f.omc("secret.md"), "unlisted\n")

	allow(t, f.anchor, "notes.md")
	allow(t, f.anchor, "plans/foo.md")

	if err := Push(nil); err != nil {
		t.Fatalf("Push: %v", err)
	}

	if got := readFile(t, filepath.Join(f.clone, "notes.md")); got != "synced notes\n" {
		t.Fatalf("clone notes.md = %q", got)
	}
	if got := readFile(t, filepath.Join(f.clone, "plans", "foo.md")); got != "synced plan\n" {
		t.Fatalf("clone plans/foo.md = %q", got)
	}
	if exists(filepath.Join(f.clone, "secret.md")) {
		t.Fatal("an unlisted file was copied into the clone")
	}

	want := []string{".sync-manifest", "notes.md", "plans/foo.md"}
	if got := trackedFiles(t, f.clone); !equalStrings(got, want) {
		t.Fatalf("clone tracked files = %v, want %v", got, want)
	}
	// Confirm the push actually reached the remote, not just the clone.
	if got := trackedFiles(t, f.tmpRoot, "--git-dir", f.remote); !equalStrings(got, want) {
		t.Fatalf("remote tracked files = %v, want %v", got, want)
	}
}

func TestPushIsANoOpWhenNothingNewIsStaged(t *testing.T) {
	f := newFixture(t)
	f.initSibling(t)

	writeFile(t, f.omc("notes.md"), "v1\n")
	allow(t, f.anchor, "notes.md")

	if err := Push(nil); err != nil {
		t.Fatalf("first Push: %v", err)
	}
	if err := Push(nil); err != nil {
		t.Fatalf("second Push should be a no-op, got: %v", err)
	}
}

func TestPushErrorsWhenInitHasNotBeenRun(t *testing.T) {
	newFixture(t)

	err := Push(nil)
	if err == nil || !strings.Contains(err.Error(), "init --track sibling") {
		t.Fatalf("expected an error pointing at `init --track sibling`, got: %v", err)
	}
}

// TestPushSkipsSymlinkSource: a symlink under the sync root pointing
// outside the repo must be skipped, never dereferenced
// (docs/HARDENING-HISTORY.md finding 4).
func TestPushSkipsSymlinkSource(t *testing.T) {
	f := newFixture(t)
	f.initSibling(t)

	secretTarget := filepath.Join(f.tmpRoot, "outside-secret.txt")
	writeFile(t, secretTarget, "super secret content\n")
	symlink(t, secretTarget, f.omc("linked.md"))
	// A legitimate entry alongside it, so the push has something to commit.
	writeFile(t, f.omc("clean.md"), "clean content\n")

	allow(t, f.anchor, "linked.md")
	allow(t, f.anchor, "clean.md")

	var pushErr error
	_, warnings := capture(t, func() { pushErr = Push(nil) })
	if pushErr != nil {
		t.Fatalf("Push: %v", pushErr)
	}
	if !strings.Contains(warnings, "linked.md") {
		t.Fatalf("expected a warning naming linked.md, got:\n%s", warnings)
	}

	if exists(filepath.Join(f.clone, "linked.md")) {
		t.Fatal("the symlink was dereferenced into the clone")
	}
	if log := runGit(t, f.clone, "log", "-p", "--all"); strings.Contains(log, "super secret content") {
		t.Fatal("the symlink target's content reached the clone's history")
	}
}

// TestPushSymlinkedDirectoryComponentCannotEscape (N2): a symlinked
// directory component in the CLONE's destination path must not let push
// write outside the clone (docs/HARDENING-HISTORY.md finding 8).
func TestPushSymlinkedDirectoryComponentCannotEscape(t *testing.T) {
	f := newFixture(t)
	f.initSibling(t)

	writeFile(t, f.omc("plans", "foo.md"), "plan content\n")
	writeFile(t, f.omc("clean.md"), "clean content\n")
	allow(t, f.anchor, "plans/foo.md")
	allow(t, f.anchor, "clean.md")

	outsideDir := filepath.Join(f.tmpRoot, "outside-clone-plans")
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatalf("creating outside dir: %v", err)
	}
	symlink(t, outsideDir, filepath.Join(f.clone, "plans"))

	var pushErr error
	_, warnings := capture(t, func() { pushErr = Push(nil) })
	if pushErr != nil {
		t.Fatalf("Push: %v", pushErr)
	}
	if !strings.Contains(warnings, "plans") {
		t.Fatalf("expected a refusal warning naming plans, got:\n%s", warnings)
	}

	if exists(filepath.Join(outsideDir, "foo.md")) {
		t.Fatal("push wrote through the symlinked directory component")
	}
}

// TestPushDanglingSymlinkDestinationIsNotCreatedThrough (N3): a DANGLING
// symlink at the clone destination reports "does not exist" to any
// stat-based check, so only an lstat-based guard catches it
// (docs/HARDENING-HISTORY.md findings 6 and 7).
func TestPushDanglingSymlinkDestinationIsNotCreatedThrough(t *testing.T) {
	f := newFixture(t)
	f.initSibling(t)

	writeFile(t, f.omc("linked.md"), "new content\n")
	writeFile(t, f.omc("clean.md"), "clean content\n")
	allow(t, f.anchor, "linked.md")
	allow(t, f.anchor, "clean.md")

	danglingTarget := filepath.Join(f.tmpRoot, "does-not-exist.txt")
	symlink(t, danglingTarget, filepath.Join(f.clone, "linked.md"))

	var pushErr error
	_, warnings := capture(t, func() { pushErr = Push(nil) })
	if pushErr != nil {
		t.Fatalf("Push: %v", pushErr)
	}
	if !strings.Contains(warnings, "linked.md") {
		t.Fatalf("expected a refusal warning naming linked.md, got:\n%s", warnings)
	}

	if !isSymlinkPath(t, filepath.Join(f.clone, "linked.md")) {
		t.Fatal("the dangling symlink was replaced instead of refused")
	}
	if exists(danglingTarget) {
		t.Fatal("push created the dangling symlink's target")
	}
}

// TestPushSymlinkedAncestorAtDepthTwoCannotEscape (N3): the symlinked
// ancestor is two levels above the write target and the immediate parent
// does not exist at all, so an immediate-parent-only guard would miss it
// entirely (docs/HARDENING-HISTORY.md finding 8).
func TestPushSymlinkedAncestorAtDepthTwoCannotEscape(t *testing.T) {
	f := newFixture(t)
	f.initSibling(t)

	writeFile(t, f.omc("a", "b", "c", "deep.md"), "deep content\n")
	writeFile(t, f.omc("clean.md"), "clean content\n")
	allow(t, f.anchor, "a/b/c/deep.md")
	allow(t, f.anchor, "clean.md")

	outsideDir := filepath.Join(f.tmpRoot, "outside-clone-deep-a")
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatalf("creating outside dir: %v", err)
	}
	symlink(t, outsideDir, filepath.Join(f.clone, "a"))

	var pushErr error
	_, warnings := capture(t, func() { pushErr = Push(nil) })
	if pushErr != nil {
		t.Fatalf("Push: %v", pushErr)
	}
	if !strings.Contains(warnings, "a/b/c/deep.md") {
		t.Fatalf("expected a refusal warning naming a/b/c/deep.md, got:\n%s", warnings)
	}

	if exists(filepath.Join(outsideDir, "b", "c", "deep.md")) {
		t.Fatal("push wrote through the symlinked ancestor")
	}
}

// TestPushDeletionBranchIsGuardedLikeTheWriteBranch (US-010): push's
// deletion propagation is a destination mutation too, and must be refused
// through a symlinked ancestor exactly as a write is
// (docs/HARDENING-HISTORY.md finding 11, which found this very call site
// unguarded in the TypeScript original).
func TestPushDeletionBranchIsGuardedLikeTheWriteBranch(t *testing.T) {
	f := newFixture(t)
	f.initSibling(t)

	// "plans/foo.md" is manifest-listed but never created on the anchor
	// side, so push's deletion branch runs on the very first push.
	allow(t, f.anchor, "plans/foo.md")
	writeFile(t, f.omc("clean.md"), "clean content\n")
	allow(t, f.anchor, "clean.md")

	outsideDir := filepath.Join(f.tmpRoot, "outside-clone-plans-delete")
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatalf("creating outside dir: %v", err)
	}
	symlink(t, outsideDir, filepath.Join(f.clone, "plans"))

	var pushErr error
	_, warnings := capture(t, func() { pushErr = Push(nil) })
	if pushErr != nil {
		t.Fatalf("Push: %v", pushErr)
	}
	if !strings.Contains(warnings, "plans") {
		t.Fatalf("expected a refusal warning naming plans, got:\n%s", warnings)
	}

	if !isSymlinkPath(t, filepath.Join(f.clone, "plans")) {
		t.Fatal("the deletion branch removed the symlink itself")
	}
	entries, err := os.ReadDir(outsideDir)
	if err != nil {
		t.Fatalf("reading outside dir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("the deletion branch touched the outside directory: %v", entries)
	}

	// The legitimate, non-escaping file must still have been committed.
	if got := readFile(t, filepath.Join(f.clone, "clean.md")); got != "clean content\n" {
		t.Fatalf("clone clean.md = %q", got)
	}
}
