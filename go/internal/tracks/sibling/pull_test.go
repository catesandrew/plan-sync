package sibling

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// twoMachines simulates two machines (A and B), each with its own anchor
// repo and its own sibling clone, both pointed at the same bare "remote".
// Ported from test/tracks-sibling-pull.test.ts's beforeEach.
type twoMachines struct {
	tmpRoot string
	remote  string
	anchorA string
	cloneA  string
	anchorB string
	cloneB  string
}

func newTwoMachines(t *testing.T) *twoMachines {
	t.Helper()

	tmpRoot := realTempDir(t)
	m := &twoMachines{
		tmpRoot: tmpRoot,
		remote:  filepath.Join(tmpRoot, "remote.git"),
		anchorA: filepath.Join(tmpRoot, "machine-a"),
		cloneA:  filepath.Join(tmpRoot, "machine-a-clone"),
		anchorB: filepath.Join(tmpRoot, "machine-b"),
		cloneB:  filepath.Join(tmpRoot, "machine-b-clone"),
	}

	newBareRemote(t, m.remote)
	newAnchorRepo(t, m.anchorA)
	newAnchorRepo(t, m.anchorB)

	return m
}

// onA/onB switch the process into the given machine's anchor repo, the way
// a user running the CLI on that machine would.
func (m *twoMachines) onA(t *testing.T) { t.Helper(); t.Chdir(m.anchorA) }
func (m *twoMachines) onB(t *testing.T) { t.Helper(); t.Chdir(m.anchorB) }

func (m *twoMachines) initA(t *testing.T) {
	t.Helper()
	if err := Init([]string{"--remote", m.remote, "--clone-path", m.cloneA}); err != nil {
		t.Fatalf("Init on machine A: %v", err)
	}
}

func (m *twoMachines) initB(t *testing.T) {
	t.Helper()
	if err := Init([]string{"--remote", m.remote, "--clone-path", m.cloneB}); err != nil {
		t.Fatalf("Init on machine B: %v", err)
	}
}

func mustPush(t *testing.T, label string) {
	t.Helper()
	if err := Push(nil); err != nil {
		t.Fatalf("Push (%s): %v", label, err)
	}
}

func mustPull(t *testing.T, label string) {
	t.Helper()
	if err := Pull(nil); err != nil {
		t.Fatalf("Pull (%s): %v", label, err)
	}
}

// TestPullPropagatesDeletionsAcrossMachines is AC-A2: a file added+pushed
// from A lands on B after pull; deleted+re-pushed from A it disappears from
// B after pull, and stays absent after B's own next push (no resurrection).
func TestPullPropagatesDeletionsAcrossMachines(t *testing.T) {
	m := newTwoMachines(t)

	// --- Machine A: init, add a manifest-listed file, push. ---
	m.onA(t)
	m.initA(t)
	writeFile(t, filepath.Join(m.anchorA, ".omc", "notes.md"), "hello from A\n")
	allow(t, m.anchorA, "notes.md")
	mustPush(t, "A initial")

	// --- Machine B: init, allow the same path, pull. ---
	m.onB(t)
	m.initB(t)
	allow(t, m.anchorB, "notes.md")
	mustPull(t, "B first")

	if got := readFile(t, filepath.Join(m.anchorB, ".omc", "notes.md")); got != "hello from A\n" {
		t.Fatalf("machine B .omc/notes.md = %q", got)
	}

	// --- Machine A: delete the file and push again. ---
	m.onA(t)
	if err := os.Remove(filepath.Join(m.anchorA, ".omc", "notes.md")); err != nil {
		t.Fatalf("deleting notes.md on A: %v", err)
	}
	mustPush(t, "A deletion")
	if exists(filepath.Join(m.cloneA, "notes.md")) {
		t.Fatal("A's clone still has notes.md after the deletion push")
	}

	// --- Machine B: pull again — the file must now be gone locally. ---
	m.onB(t)
	mustPull(t, "B second")
	if exists(filepath.Join(m.anchorB, ".omc", "notes.md")) {
		t.Fatal("deletion did not propagate to machine B's .omc/")
	}
	if exists(filepath.Join(m.cloneB, "notes.md")) {
		t.Fatal("deletion did not propagate to machine B's clone")
	}

	// --- B's own next push must not resurrect the file or error. ---
	mustPush(t, "B after deletion")
	if exists(filepath.Join(m.anchorB, ".omc", "notes.md")) {
		t.Fatal("B's push resurrected notes.md locally")
	}
	if exists(filepath.Join(m.cloneB, "notes.md")) {
		t.Fatal("B's push resurrected notes.md in the clone")
	}
}

// TestPullSurfacesConcurrentEditsAsARealGitConflict is AC-A3: the same
// manifest-listed file edited differently on two clones produces a REAL
// rebase conflict with standard markers on whichever side pulls second —
// no silent discard of either version.
func TestPullSurfacesConcurrentEditsAsARealGitConflict(t *testing.T) {
	m := newTwoMachines(t)

	// --- Machine A: seed the shared file and push a baseline. ---
	m.onA(t)
	m.initA(t)
	writeFile(t, filepath.Join(m.anchorA, ".omc", "shared.md"), "base\n")
	allow(t, m.anchorA, "shared.md")
	mustPush(t, "A baseline")

	// --- Machine B: init, allow, pull the baseline. ---
	m.onB(t)
	m.initB(t)
	allow(t, m.anchorB, "shared.md")
	mustPull(t, "B baseline")
	if got := readFile(t, filepath.Join(m.anchorB, ".omc", "shared.md")); got != "base\n" {
		t.Fatalf("machine B .omc/shared.md = %q", got)
	}

	// --- A edits and pushes first. ---
	m.onA(t)
	writeFile(t, filepath.Join(m.anchorA, ".omc", "shared.md"), "edited on A\n")
	mustPush(t, "A edit")

	// --- B edits the same file differently and commits it in its own
	// clone WITHOUT pushing, simulating a commit made before B ever tried
	// to sync with the now-diverged remote. ---
	m.onB(t)
	writeFile(t, filepath.Join(m.anchorB, ".omc", "shared.md"), "edited on B\n")
	writeFile(t, filepath.Join(m.cloneB, "shared.md"), "edited on B\n")
	runGit(t, m.cloneB, "add", "--", "shared.md")
	if _, err := runGitEnv(t, m.cloneB, testCommitEnv, "commit", "-m", "B's local edit"); err != nil {
		t.Fatalf("committing B's local edit: %v", err)
	}

	err := Pull(nil)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "merge conflict") {
		t.Fatalf("expected a merge-conflict error, got: %v", err)
	}

	// Real git rebase-conflict state, with actual conflict markers — not a
	// mocked outcome.
	conflicted := readFile(t, filepath.Join(m.cloneB, "shared.md"))
	for _, marker := range []string{"<<<<<<<", "=======", ">>>>>>>"} {
		if !strings.Contains(conflicted, marker) {
			t.Fatalf("expected conflict marker %q in:\n%s", marker, conflicted)
		}
	}
	// Neither side's content was silently discarded.
	for _, side := range []string{"edited on A", "edited on B"} {
		if !strings.Contains(conflicted, side) {
			t.Fatalf("expected %q to survive in the conflicted file:\n%s", side, conflicted)
		}
	}

	status := runGit(t, m.cloneB, "status", "--short")
	if !strings.Contains(status, "UU") {
		t.Fatalf("expected an unmerged (UU) path in git status, got:\n%s", status)
	}
}

// TestPullCopyInCannotEscapeViaSymlinkedDirectoryComponent: pull's copy-in
// path is a destination mutation and must be refused through a symlinked
// component under the local sync root (docs/HARDENING-HISTORY.md finding
// 11 found this call site unguarded in the TypeScript original).
func TestPullCopyInCannotEscapeViaSymlinkedDirectoryComponent(t *testing.T) {
	m := newTwoMachines(t)

	m.onA(t)
	m.initA(t)
	writeFile(t, filepath.Join(m.anchorA, ".omc", "plans", "foo.md"), "plan content\n")
	allow(t, m.anchorA, "plans/foo.md")
	mustPush(t, "A")

	m.onB(t)
	m.initB(t)
	allow(t, m.anchorB, "plans/foo.md")

	outsideDir := filepath.Join(m.tmpRoot, "outside-plans-copyin")
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatalf("creating outside dir: %v", err)
	}
	symlink(t, outsideDir, filepath.Join(m.anchorB, ".omc", "plans"))

	var pullErr error
	_, warnings := capture(t, func() { pullErr = Pull(nil) })
	if pullErr != nil {
		t.Fatalf("Pull: %v", pullErr)
	}
	if !strings.Contains(warnings, "plans") {
		t.Fatalf("expected a refusal warning naming plans, got:\n%s", warnings)
	}

	if exists(filepath.Join(outsideDir, "foo.md")) {
		t.Fatal("pull's copy-in wrote through the symlinked directory component")
	}
}

// TestPullDeletePropagationCannotEscapeViaSymlinkedDirectoryComponent:
// same guard, for pull's OTHER destination mutation — the delete branch.
func TestPullDeletePropagationCannotEscapeViaSymlinkedDirectoryComponent(t *testing.T) {
	m := newTwoMachines(t)

	// A: publish plans/foo.md, then delete + re-push so the clone no longer
	// has it (the deletion-propagation source).
	m.onA(t)
	m.initA(t)
	writeFile(t, filepath.Join(m.anchorA, ".omc", "plans", "foo.md"), "plan content\n")
	allow(t, m.anchorA, "plans/foo.md")
	mustPush(t, "A initial")
	if err := os.Remove(filepath.Join(m.anchorA, ".omc", "plans", "foo.md")); err != nil {
		t.Fatalf("deleting plans/foo.md on A: %v", err)
	}
	mustPush(t, "A deletion")

	// B: same manifest entry, but its local .omc/plans is a symlink to an
	// outside directory holding a same-named file that must never be
	// touched by the delete propagation.
	m.onB(t)
	m.initB(t)
	allow(t, m.anchorB, "plans/foo.md")

	outsideDir := filepath.Join(m.tmpRoot, "outside-plans-delete")
	outsideFile := filepath.Join(outsideDir, "foo.md")
	writeFile(t, outsideFile, "outside content that must survive\n")
	symlink(t, outsideDir, filepath.Join(m.anchorB, ".omc", "plans"))

	var pullErr error
	_, warnings := capture(t, func() { pullErr = Pull(nil) })
	if pullErr != nil {
		t.Fatalf("Pull: %v", pullErr)
	}
	if !strings.Contains(warnings, "plans") {
		t.Fatalf("expected a refusal warning naming plans, got:\n%s", warnings)
	}

	if !exists(outsideFile) {
		t.Fatal("pull's delete propagation removed a file outside the repo")
	}
	if got := readFile(t, outsideFile); got != "outside content that must survive\n" {
		t.Fatalf("outside file was modified: %q", got)
	}
}

// TestPullSkipsASymlinkPresentInTheClone: the tool's own push never
// commits a symlink, but pull must still defend against one being present
// in the clone however it got there — it must not be dereferenced.
func TestPullSkipsASymlinkPresentInTheClone(t *testing.T) {
	m := newTwoMachines(t)

	m.onA(t)
	m.initA(t)

	secretTarget := filepath.Join(m.tmpRoot, "outside-secret.txt")
	writeFile(t, secretTarget, "super secret content\n")
	symlink(t, secretTarget, filepath.Join(m.cloneA, "notes.md"))

	runGit(t, m.cloneA, "add", "--", "notes.md")
	if _, err := runGitEnv(t, m.cloneA, testCommitEnv, "commit", "-m", "commit a symlink directly"); err != nil {
		t.Fatalf("committing the symlink: %v", err)
	}
	runGit(t, m.cloneA, "push", "-u", "origin", "HEAD")

	m.onB(t)
	m.initB(t)
	allow(t, m.anchorB, "notes.md")

	var pullErr error
	_, warnings := capture(t, func() { pullErr = Pull(nil) })
	if pullErr != nil {
		t.Fatalf("Pull: %v", pullErr)
	}
	if !strings.Contains(warnings, "notes.md") {
		t.Fatalf("expected a warning naming notes.md, got:\n%s", warnings)
	}

	if exists(filepath.Join(m.anchorB, ".omc", "notes.md")) {
		t.Fatal("the clone's symlink was dereferenced into machine B's .omc/")
	}
}
