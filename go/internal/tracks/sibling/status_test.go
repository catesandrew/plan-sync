package sibling

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStatusErrorsWhenInitHasNotBeenRun(t *testing.T) {
	newFixture(t)

	err := Status(nil)
	if err == nil || !strings.Contains(err.Error(), "init --track sibling") {
		t.Fatalf("expected an error pointing at `init --track sibling`, got: %v", err)
	}
}

// TestStatusReportsAllFourStates exercises every state the per-file report
// can produce, in one run: in sync / pending (local changes) / pending
// (never synced) / missing locally.
func TestStatusReportsAllFourStates(t *testing.T) {
	f := newFixture(t)
	f.initSibling(t)

	writeFile(t, f.omc("synced.md"), "unchanged content\n")
	writeFile(t, f.omc("modified.md"), "original content\n")
	writeFile(t, f.omc("gone.md"), "will be deleted locally\n")
	// "never-synced.md" is deliberately never created on disk.

	allow(t, f.anchor, "synced.md")
	allow(t, f.anchor, "modified.md")
	allow(t, f.anchor, "never-synced.md")
	allow(t, f.anchor, "gone.md")

	if err := Push(nil); err != nil {
		t.Fatalf("Push: %v", err)
	}

	// After the push: edit one file locally and delete another locally,
	// leaving the manifest untouched — the ordinary workflow.
	writeFile(t, f.omc("modified.md"), "changed after push\n")
	if err := os.Remove(f.omc("gone.md")); err != nil {
		t.Fatalf("deleting gone.md: %v", err)
	}

	var statusErr error
	out, _ := capture(t, func() { statusErr = Status(nil) })
	if statusErr != nil {
		t.Fatalf("Status: %v", statusErr)
	}

	for _, want := range []string{
		"synced.md: in sync",
		"modified.md: pending (local changes)",
		"never-synced.md: pending (never synced)",
		"gone.md: missing locally",
		"4 file(s) tracked",
		"1 in sync, 1 pending (local changes), 1 pending (never synced), 1 missing locally",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("expected status output to contain %q, got:\n%s", want, out)
		}
	}
}

// TestStatusReportsNeverSyncedForAPathPresentOnNeitherSide covers the
// fallback branch: a literal manifest entry that exists neither locally nor
// in the clone is reported as "pending (never synced)", the closest fit of
// the four states.
func TestStatusReportsNeverSyncedForAPathPresentOnNeitherSide(t *testing.T) {
	f := newFixture(t)
	f.initSibling(t)

	allow(t, f.anchor, "ghost.md")

	var statusErr error
	out, _ := capture(t, func() { statusErr = Status(nil) })
	if statusErr != nil {
		t.Fatalf("Status: %v", statusErr)
	}

	if !strings.Contains(out, "ghost.md: pending (never synced)") {
		t.Fatalf("expected ghost.md reported as never synced, got:\n%s", out)
	}
	if exists(filepath.Join(f.clone, "ghost.md")) {
		t.Fatal("status must never create anything in the clone")
	}
}
