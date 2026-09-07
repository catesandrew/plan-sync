package sibling

import (
	"path/filepath"
	"strings"
	"testing"

	"plan-sync/go/internal/manifest"
)

// The manifest itself travels as part of the sync payload, so a second
// machine's `pull` recovers the scope list, not just file content. Ported
// from test/tracks-sibling-manifest.test.ts.

func localManifest(t *testing.T, anchorDir string) []string {
	t.Helper()
	entries := manifest.ReadManifest(filepath.Join(anchorDir, ".omc", manifest.ManifestFilename))
	sortStrings(entries)
	return entries
}

// TestManifestTravelsWithThePayloadToAFreshMachine: a machine that has
// never run `allow` at all gets BOTH the file content and the manifest
// from a single pull.
func TestManifestTravelsWithThePayloadToAFreshMachine(t *testing.T) {
	m := newTwoMachines(t)

	m.onA(t)
	m.initA(t)
	writeFile(t, filepath.Join(m.anchorA, ".omc", "one.md"), "first file\n")
	writeFile(t, filepath.Join(m.anchorA, ".omc", "two.md"), "second file\n")
	allow(t, m.anchorA, "one.md")
	allow(t, m.anchorA, "two.md")
	mustPush(t, "A")

	if !exists(filepath.Join(m.cloneA, ".sync-manifest")) {
		t.Fatal("push did not copy the manifest into the clone")
	}
	want := []string{".sync-manifest", "one.md", "two.md"}
	if got := trackedFiles(t, m.cloneA); !equalStrings(got, want) {
		t.Fatalf("clone tracked files = %v, want %v", got, want)
	}

	// Machine B is a fresh machine: init only, no `allow` calls at all.
	m.onB(t)
	m.initB(t)
	if got := localManifest(t, m.anchorB); len(got) != 0 {
		t.Fatalf("expected machine B's manifest to start empty, got %v", got)
	}

	mustPull(t, "B fresh")

	if got := readFile(t, filepath.Join(m.anchorB, ".omc", "one.md")); got != "first file\n" {
		t.Fatalf("machine B one.md = %q", got)
	}
	if got := readFile(t, filepath.Join(m.anchorB, ".omc", "two.md")); got != "second file\n" {
		t.Fatalf("machine B two.md = %q", got)
	}
	if got := localManifest(t, m.anchorB); !equalStrings(got, []string{"one.md", "two.md"}) {
		t.Fatalf("machine B manifest = %v, want [one.md two.md]", got)
	}
}

// TestPullMergesTheIncomingManifestAsAUnionNotAnOverwrite: a pre-existing
// local-only entry (already pushed by this same machine) must survive a
// later pull's manifest merge.
func TestPullMergesTheIncomingManifestAsAUnionNotAnOverwrite(t *testing.T) {
	m := newTwoMachines(t)

	// B establishes its own entry first and genuinely pushes it.
	m.onB(t)
	m.initB(t)
	writeFile(t, filepath.Join(m.anchorB, ".omc", "local-only.md"), "only known to machine B\n")
	allow(t, m.anchorB, "local-only.md")
	mustPush(t, "B initial")

	// A joins later with no knowledge of "local-only.md": its push
	// overwrites the shared manifest blob with A's own list, but never
	// touches local-only.md itself.
	m.onA(t)
	m.initA(t)
	writeFile(t, filepath.Join(m.anchorA, ".omc", "one.md"), "first file\n")
	allow(t, m.anchorA, "one.md")
	mustPush(t, "A")

	remoteManifest := strings.TrimSpace(runGit(t, m.cloneA, "show", "HEAD:.sync-manifest"))
	if remoteManifest != "one.md" {
		t.Fatalf("shared manifest after A's push = %q, want %q", remoteManifest, "one.md")
	}

	// B pulls A's update: the incoming manifest must be UNION-merged, so
	// B's own entry (and its file, still present in the clone) survives.
	m.onB(t)
	mustPull(t, "B after A")

	if got := readFile(t, filepath.Join(m.anchorB, ".omc", "one.md")); got != "first file\n" {
		t.Fatalf("machine B one.md = %q", got)
	}
	if got := readFile(t, filepath.Join(m.anchorB, ".omc", "local-only.md")); got != "only known to machine B\n" {
		t.Fatalf("machine B local-only.md = %q", got)
	}
	if got := localManifest(t, m.anchorB); !equalStrings(got, []string{"local-only.md", "one.md"}) {
		t.Fatalf("machine B manifest = %v, want [local-only.md one.md]", got)
	}
}

// TestPullSkipsAnInvalidIncomingManifestEntry: an out-of-bounds line in the
// incoming manifest is warned about and skipped, never merged into the
// local manifest (docs/HARDENING-HISTORY.md finding 3).
func TestPullSkipsAnInvalidIncomingManifestEntry(t *testing.T) {
	m := newTwoMachines(t)

	m.onA(t)
	m.initA(t)
	writeFile(t, filepath.Join(m.anchorA, ".omc", "one.md"), "first file\n")
	allow(t, m.anchorA, "one.md")
	mustPush(t, "A")

	// Hand-craft a hostile manifest directly in the clone and publish it.
	writeFile(t, filepath.Join(m.cloneA, ".sync-manifest"), "one.md\n../escape.md\n")
	runGit(t, m.cloneA, "add", "--", ".sync-manifest")
	if _, err := runGitEnv(t, m.cloneA, testCommitEnv, "commit", "-m", "hostile manifest"); err != nil {
		t.Fatalf("committing hostile manifest: %v", err)
	}
	runGit(t, m.cloneA, "push", "-u", "origin", "HEAD")

	m.onB(t)
	m.initB(t)

	var pullErr error
	_, warnings := capture(t, func() { pullErr = Pull(nil) })
	if pullErr != nil {
		t.Fatalf("Pull: %v", pullErr)
	}
	if !strings.Contains(warnings, "../escape.md") {
		t.Fatalf("expected a warning naming the rejected entry, got:\n%s", warnings)
	}

	if got := localManifest(t, m.anchorB); !equalStrings(got, []string{"one.md"}) {
		t.Fatalf("machine B manifest = %v, want [one.md]", got)
	}
	if exists(filepath.Join(m.anchorB, "escape.md")) {
		t.Fatal("an out-of-bounds manifest entry materialized outside the sync root")
	}
}
