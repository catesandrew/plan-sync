package commands

import (
	"path/filepath"
	"strings"
	"testing"
)

// --- allow / unallow (track-agnostic: manifest-only, no --track) --------

func TestAllowAddsEveryTargetVerbatimAndReportsMatchCounts(t *testing.T) {
	f := newCommandFixture(t)

	writeFile(t, f.omc("notes.md"), "notes\n")
	writeFile(t, f.omc("plans", "a.md"), "a\n")
	writeFile(t, f.omc("plans", "b.md"), "b\n")

	var err error
	out, _ := capture(t, func() { err = Allow([]string{"notes.md", "plans/*.md"}) })
	if err != nil {
		t.Fatalf("Allow: %v", err)
	}

	// The glob is stored VERBATIM — never expanded into literal matches.
	if got := manifestEntries(t, f); !equalStrings(got, []string{"notes.md", "plans/*.md"}) {
		t.Fatalf("manifest = %v, want [notes.md plans/*.md]", got)
	}
	if !strings.Contains(out, "'notes.md' added (currently matches 1 file(s))") {
		t.Fatalf("expected a match count for notes.md, got:\n%s", out)
	}
	if !strings.Contains(out, "'plans/*.md' added (currently matches 2 file(s))") {
		t.Fatalf("expected a match count for plans/*.md, got:\n%s", out)
	}
}

func TestAllowAddsAPatternThatCurrentlyMatchesNothing(t *testing.T) {
	f := newCommandFixture(t)

	var err error
	out, _ := capture(t, func() { err = Allow([]string{"plans/*.md"}) })
	if err != nil {
		t.Fatalf("Allow: %v", err)
	}

	if got := manifestEntries(t, f); !equalStrings(got, []string{"plans/*.md"}) {
		t.Fatalf("manifest = %v, want [plans/*.md]", got)
	}
	if !strings.Contains(out, "currently matches 0 file(s)") {
		t.Fatalf("expected a zero match count, got:\n%s", out)
	}
}

func TestAllowRequiresAPathArgument(t *testing.T) {
	newCommandFixture(t)

	err := Allow([]string{"--root", ".omc"})
	if err == nil || !strings.Contains(err.Error(), "<path> argument is required") {
		t.Fatalf("expected a missing-argument error, got: %v", err)
	}
}

func TestAllowRejectsAnOutOfBoundsTarget(t *testing.T) {
	f := newCommandFixture(t)

	err := Allow([]string{"../escape.md"})
	if err == nil || !strings.Contains(err.Error(), "resolves outside") {
		t.Fatalf("expected an out-of-bounds rejection, got: %v", err)
	}
	if got := manifestEntries(t, f); len(got) != 0 {
		t.Fatalf("expected nothing written to the manifest, got %v", got)
	}
}

func TestUnallowRemovesALiteralEntryAndWarnsOnAMiss(t *testing.T) {
	f := newCommandFixture(t)

	capture(t, func() {
		if err := Allow([]string{"notes.md", "plans/foo.md"}); err != nil {
			t.Fatalf("Allow: %v", err)
		}
	})

	var err error
	_, warnings := capture(t, func() { err = Unallow([]string{"notes.md", "absent.md"}) })
	if err != nil {
		t.Fatalf("Unallow: %v", err)
	}

	if got := manifestEntries(t, f); !equalStrings(got, []string{"plans/foo.md"}) {
		t.Fatalf("manifest = %v, want [plans/foo.md]", got)
	}
	if !strings.Contains(warnings, "'absent.md' was not in the manifest (no-op)") {
		t.Fatalf("expected a no-op warning, got:\n%s", warnings)
	}
}

// TestUnallowMatchesAPatternAgainstManifestEntriesNotTheFilesystem is the
// behavioral difference from `allow`: an entry whose file was already
// deleted from disk must still be removable.
func TestUnallowMatchesAPatternAgainstManifestEntriesNotTheFilesystem(t *testing.T) {
	f := newCommandFixture(t)

	capture(t, func() {
		if err := Allow([]string{"plans/a.md", "plans/b.md", "notes.md"}); err != nil {
			t.Fatalf("Allow: %v", err)
		}
	})
	// None of these files ever existed on disk.

	var err error
	out, _ := capture(t, func() { err = Unallow([]string{"plans/*.md"}) })
	if err != nil {
		t.Fatalf("Unallow: %v", err)
	}

	if got := manifestEntries(t, f); !equalStrings(got, []string{"notes.md"}) {
		t.Fatalf("manifest = %v, want [notes.md]", got)
	}
	if !strings.Contains(out, "pattern 'plans/*.md' removed 2 manifest entries") {
		t.Fatalf("expected a plural removal summary, got:\n%s", out)
	}
}

func TestUnallowWarnsWhenAPatternMatchesNoEntries(t *testing.T) {
	newCommandFixture(t)

	var err error
	_, warnings := capture(t, func() { err = Unallow([]string{"plans/*.md"}) })
	if err != nil {
		t.Fatalf("Unallow: %v", err)
	}
	if !strings.Contains(warnings, "pattern 'plans/*.md' matched no manifest entries") {
		t.Fatalf("expected a no-match warning, got:\n%s", warnings)
	}
}

func TestUnallowRequiresAPathArgument(t *testing.T) {
	newCommandFixture(t)

	err := Unallow(nil)
	if err == nil || !strings.Contains(err.Error(), "<path> argument is required") {
		t.Fatalf("expected a missing-argument error, got: %v", err)
	}
}

// --- track routing -----------------------------------------------------

// TestInitRequiresAnExplicitTrack: init ESTABLISHES the default track, so
// unlike push/pull/status it never falls back to a persisted one.
func TestInitRequiresAnExplicitTrack(t *testing.T) {
	f := newCommandFixture(t)
	f.initSibling(t)

	// A default track is now persisted, and init must still demand --track.
	err := Init(nil)
	if err == nil || !strings.Contains(err.Error(), "--track is required") {
		t.Fatalf("expected init to require --track, got: %v", err)
	}
	if !strings.HasPrefix(err.Error(), "init: ") {
		t.Fatalf("expected the error to be prefixed with the command name, got: %v", err)
	}
}

// TestPushPullStatusUseThePersistedDefaultTrack: after `init --track
// sibling`, a bare `push` routes to the sibling track with no flag.
func TestPushPullStatusUseThePersistedDefaultTrack(t *testing.T) {
	f := newCommandFixture(t)
	f.initSibling(t)

	writeFile(t, f.omc("notes.md"), "synced notes\n")
	capture(t, func() {
		if err := Allow([]string{"notes.md"}); err != nil {
			t.Fatalf("Allow: %v", err)
		}
	})

	if err := Push(nil); err != nil {
		t.Fatalf("Push with no --track: %v", err)
	}
	if got := readFile(t, filepath.Join(f.clone, "notes.md")); got != "synced notes\n" {
		t.Fatalf("clone notes.md = %q", got)
	}

	var statusErr error
	out, _ := capture(t, func() { statusErr = Status(nil) })
	if statusErr != nil {
		t.Fatalf("Status with no --track: %v", statusErr)
	}
	if !strings.Contains(out, "notes.md: in sync") {
		t.Fatalf("expected the sibling per-file report, got:\n%s", out)
	}

	if err := Pull(nil); err != nil {
		t.Fatalf("Pull with no --track: %v", err)
	}
}

// TestCommandsErrorWithoutATrackOrAPersistedDefault: with no init having
// run, there is nothing to fall back to.
func TestCommandsErrorWithoutATrackOrAPersistedDefault(t *testing.T) {
	newCommandFixture(t)

	for name, run := range map[string]func([]string) error{
		"push":   Push,
		"pull":   Pull,
		"status": Status,
	} {
		err := run(nil)
		if err == nil || !strings.Contains(err.Error(), "--track is required") {
			t.Fatalf("%s: expected a --track-required error, got: %v", name, err)
		}
		if !strings.HasPrefix(err.Error(), name+": ") {
			t.Fatalf("%s: expected the error to be prefixed with the command name, got: %v", name, err)
		}
	}
}

// TestShadowTrackRoutesThroughTheShadowSeams: an explicit `--track shadow`
// reaches the shadow entry point (never the sibling one), with the --track
// flag itself stripped from the forwarded arguments.
func TestShadowTrackRoutesThroughTheShadowSeams(t *testing.T) {
	f := newCommandFixture(t)
	f.initSibling(t) // persists "sibling" as the default, which --track must override

	calls := stubShadow(t)

	for name, run := range map[string]func([]string) error{
		"init":   Init,
		"push":   Push,
		"pull":   Pull,
		"status": Status,
	} {
		if err := run([]string{"--track", "shadow", "--root", ".omc"}); err != nil {
			t.Fatalf("%s --track shadow: %v", name, err)
		}
	}

	for name, got := range map[string][][]string{
		"init":   calls.init,
		"push":   calls.push,
		"pull":   calls.pull,
		"status": calls.status,
	} {
		if len(got) != 1 {
			t.Fatalf("expected exactly one shadow %s call, got %d", name, len(got))
		}
		if !equalStrings(got[0], []string{"--root", ".omc"}) {
			t.Fatalf("shadow %s received %v, want [--root .omc]", name, got[0])
		}
	}
}

// TestShadowPushAndStatusReportPhaseTwo pins the CURRENT shadow-seam
// defaults: push/status are out of Phase 1 scope and must say so clearly
// rather than failing obscurely. (init/pull are wired to the real shadow
// track and are covered by that package's own tests.)
func TestShadowPushAndStatusReportPhaseTwo(t *testing.T) {
	newCommandFixture(t)

	if err := ShadowPush(nil); err == nil || !strings.Contains(err.Error(), "not available until Phase 2") {
		t.Fatalf("expected a Phase 2 message from push --track shadow, got: %v", err)
	}
	if err := ShadowStatus(nil); err == nil || !strings.Contains(err.Error(), "not available until Phase 2") {
		t.Fatalf("expected a Phase 2 message from status --track shadow, got: %v", err)
	}
}

// --- help --------------------------------------------------------------

// TestHelpFlagPrintsUsageWithoutSideEffects: --help is handled FIRST, before
// any flag parsing or track resolution, so it works even in a state where
// the command itself would otherwise error.
func TestHelpFlagPrintsUsageWithoutSideEffects(t *testing.T) {
	f := newCommandFixture(t)

	cases := map[string]struct {
		run  func([]string) error
		want string
	}{
		"init":    {Init, "Usage: plan-sync init"},
		"allow":   {Allow, "Usage: plan-sync allow"},
		"unallow": {Unallow, "Usage: plan-sync unallow"},
		"push":    {Push, "Usage: plan-sync push"},
		"pull":    {Pull, "Usage: plan-sync pull"},
		"status":  {Status, "Usage: plan-sync status"},
	}

	for _, flag := range []string{"--help", "-h"} {
		for name, tc := range cases {
			var err error
			out, _ := capture(t, func() { err = tc.run([]string{flag}) })
			if err != nil {
				t.Fatalf("%s %s: %v", name, flag, err)
			}
			if !strings.Contains(out, tc.want) {
				t.Fatalf("%s %s: expected usage containing %q, got:\n%s", name, flag, tc.want, out)
			}
		}
	}

	// No command touched the filesystem: no manifest, no config, no clone.
	if exists(f.manifestPath()) {
		t.Fatal("--help created a manifest")
	}
	if exists(f.clone) {
		t.Fatal("--help created a clone")
	}
}

// --- end to end --------------------------------------------------------

// TestSiblingLifecycleThroughTheCommandLayer runs the recommended track's
// whole happy path exactly as a user would: init, allow, push, status.
func TestSiblingLifecycleThroughTheCommandLayer(t *testing.T) {
	f := newCommandFixture(t)

	if err := Init([]string{"--track", "sibling", "--remote", f.remote, "--clone-path", f.clone}); err != nil {
		t.Fatalf("init: %v", err)
	}

	writeFile(t, f.omc("notes.md"), "hello\n")
	writeFile(t, f.omc("plans", "foo.md"), "plan\n")
	writeFile(t, f.omc("unlisted.md"), "must not travel\n")

	capture(t, func() {
		if err := Allow([]string{"notes.md", "plans/foo.md"}); err != nil {
			t.Fatalf("allow: %v", err)
		}
	})

	if err := Push(nil); err != nil {
		t.Fatalf("push: %v", err)
	}

	tracked := strings.Fields(runGit(t, f.clone, "ls-tree", "-r", "--name-only", "HEAD"))
	if len(tracked) != 3 {
		t.Fatalf("expected exactly 3 tracked files in the clone, got %v", tracked)
	}
	if exists(filepath.Join(f.clone, "unlisted.md")) {
		t.Fatal("an unlisted file travelled to the clone")
	}

	var statusErr error
	out, _ := capture(t, func() { statusErr = Status(nil) })
	if statusErr != nil {
		t.Fatalf("status: %v", statusErr)
	}
	if !strings.Contains(out, "2 file(s) tracked — 2 in sync") {
		t.Fatalf("expected an all-in-sync summary, got:\n%s", out)
	}

	// unallow then removes an entry from the scope list.
	capture(t, func() {
		if err := Unallow([]string{"notes.md"}); err != nil {
			t.Fatalf("unallow: %v", err)
		}
	})
	if got := manifestEntries(t, f); !equalStrings(got, []string{"plans/foo.md"}) {
		t.Fatalf("manifest after unallow = %v, want [plans/foo.md]", got)
	}
}
