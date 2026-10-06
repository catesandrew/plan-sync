package shadow

import (
	"crypto/sha256"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"plan-sync/go/internal/cli"
)

// initAndSeedRef runs Init and then builds `commits` (in order) as a real
// commit chain on the shadow ref, returning the shadow repo path and ref
// name. Each element is a FULL tree snapshot, so a path present in an
// earlier element and absent from a later one is a genuine, history-visible
// deletion — which is exactly the signal restore's deletion scoping reads.
func initAndSeedRef(t *testing.T, f *fixture, commits ...map[string]string) (shadowRepoPath, refName string) {
	t.Helper()
	if err := Init(nil); err != nil {
		t.Fatalf("Init: %v", err)
	}
	shadowRepoPath = f.shadowRepoPath(".omc")
	refName = f.refName(".omc")
	for _, files := range commits {
		f.commitFixtureTree(shadowRepoPath, refName, files)
	}
	return shadowRepoPath, refName
}

// captureStderr redirects os.Stderr for the duration of fn and returns
// everything written to it. safewrite's refusal warnings and restore's
// skip-and-warn diagnostics both go straight to os.Stderr, so this is the
// only way to assert on them.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	orig := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("creating pipe: %v", err)
	}
	os.Stderr = w

	done := make(chan string, 1)
	go func() {
		out, _ := io.ReadAll(r)
		done <- string(out)
	}()

	fn()

	os.Stderr = orig
	_ = w.Close()
	out := <-done
	_ = r.Close()
	return out
}

// rewindLocalRef moves the local shadow ref back one commit (after it was
// pushed to origin), so Restore sees origin one push ahead of what this
// machine last synced (the merge base) — as if another machine pushed.
func rewindLocalRef(f *fixture, shadowRepoPath, refName string) {
	f.t.Helper()
	f.git(shadowRepoPath, "--git-dir="+shadowRepoPath, "update-ref", refName, refName+"~1")
}

// seedRemoteV1ToV2 seeds a.md at v1 then v2, publishes to origin, and
// rewinds the local ref so this machine's merge base is v1.
func seedRemoteV1ToV2(t *testing.T, f *fixture, v1, v2 string) {
	t.Helper()
	shadowRepoPath, refName := initAndSeedRef(t, f,
		map[string]string{"a.md": v1},
		map[string]string{"a.md": v2},
	)
	f.pushRefToOrigin(shadowRepoPath, refName)
	rewindLocalRef(f, shadowRepoPath, refName)
	f.writeManifest("a.md")
}

// Ports "3-way: a locally edited, unpushed file is preserved when the
// remote is unchanged".
func TestRestorePreservesLocallyEditedFile(t *testing.T) {
	f := newFixture(t)

	shadowRepoPath, refName := initAndSeedRef(t, f, map[string]string{"a.md": "synced\n"})
	f.pushRefToOrigin(shadowRepoPath, refName)
	f.writeManifest("a.md")
	f.writeOmcFile("a.md", "local edit\n")

	var err error
	warnings := captureStderr(t, func() { err = Restore(nil) })
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	assertFileContent(t, f.omcPath("a.md"), "local edit\n")
	assertNotExists(t, f.omcPath("a.md.remote"))
	if strings.Contains(warnings, "conflict") {
		t.Fatalf("unexpected conflict warning: %q", warnings)
	}
}

// Ports "3-way: an unmodified local file is overwritten by a remote update".
func TestRestoreOverwritesUnmodifiedFileWithRemoteUpdate(t *testing.T) {
	f := newFixture(t)
	seedRemoteV1ToV2(t, f, "v1\n", "v2\n")
	f.writeOmcFile("a.md", "v1\n")

	if err := Restore(nil); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	assertFileContent(t, f.omcPath("a.md"), "v2\n")
	assertNotExists(t, f.omcPath("a.md.remote"))
}

// restoreCapturingStderr runs Restore, failing the test on error, and
// returns everything it wrote to stderr.
func restoreCapturingStderr(t *testing.T) string {
	t.Helper()
	var err error
	warnings := captureStderr(t, func() { err = Restore(nil) })
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	return warnings
}

func assertContains(t *testing.T, haystack, needle string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Fatalf("expected %q in %q", needle, haystack)
	}
}

// Ports "3-way: both changed, non-overlapping edits merge cleanly in place".
func TestRestoreBothChangedNonOverlappingMergesCleanly(t *testing.T) {
	f := newFixture(t)
	seedRemoteV1ToV2(t, f, "1\n2\n3\n4\n5\n", "1 remote\n2\n3\n4\n5\n")
	f.writeOmcFile("a.md", "1\n2\n3\n4\n5 local\n")

	warnings := restoreCapturingStderr(t)

	assertFileContent(t, f.omcPath("a.md"), "1 remote\n2\n3\n4\n5 local\n")
	assertNotExists(t, f.omcPath("a.md.remote"))
	assertContains(t, warnings, "plan-sync: merged a.md\n")
}

// Ports "3-way: both changed, overlapping edits leave conflict markers and
// warn".
func TestRestoreBothChangedOverlappingLeavesConflictMarkers(t *testing.T) {
	f := newFixture(t)
	seedRemoteV1ToV2(t, f, "v1\n", "v2\n")
	f.writeOmcFile("a.md", "local edit\n")

	warnings := restoreCapturingStderr(t)

	merged, _ := os.ReadFile(f.omcPath("a.md"))
	assertContains(t, string(merged), "<<<<<<< local\nlocal edit\n")
	assertContains(t, string(merged), "=======\nv2\n>>>>>>> remote\n")
	assertNotExists(t, f.omcPath("a.md.remote"))
	assertContains(t, warnings, "plan-sync: conflict in a.md (1 hunk(s)); resolve markers, then push")
}

// Ports "3-way: both changed, binary content falls back to keeping local +
// <file>.remote".
func TestRestoreBothChangedBinaryFallsBackToRemoteCopy(t *testing.T) {
	f := newFixture(t)
	seedRemoteV1ToV2(t, f, "\x00\x01\x02", "\x00\x01\x03")
	f.writeOmcFile("a.md", "\x00\x01\x04")

	warnings := restoreCapturingStderr(t)

	assertFileContent(t, f.omcPath("a.md"), "\x00\x01\x04")
	assertFileContent(t, f.omcPath("a.md.remote"), "\x00\x01\x03")
	assertContains(t, warnings, "plan-sync: conflict on a.md: kept local, remote copy at a.md.remote")
}

// Ports "3-way: no base (never synced on this machine) and differing content
// is an add/add conflict".
func TestRestoreNoBaseDifferingContentIsAddAddConflict(t *testing.T) {
	f := newFixture(t)
	shadowRepoPath, refName := initAndSeedRef(t, f, map[string]string{"a.md": "remote\n"})
	f.pushRefToOrigin(shadowRepoPath, refName)
	f.writeManifest("a.md")

	f.switchToFreshMachine("no-base")
	f.writeOmcFile("a.md", "local\n")
	warnings := restoreCapturingStderr(t)

	merged, _ := os.ReadFile(f.omcPath("a.md"))
	assertContains(t, string(merged), "<<<<<<< local\nlocal\n")
	assertContains(t, string(merged), "=======\nremote\n>>>>>>> remote\n")
	assertContains(t, warnings, "plan-sync: conflict in a.md (1 hunk(s)); resolve markers, then push")
}

// Ports "3-way: a locally modified file is not deleted when the remote
// deleted it".
func TestRestoreDoesNotDeleteLocallyModifiedFile(t *testing.T) {
	f := newFixture(t)

	shadowRepoPath, refName := initAndSeedRef(t, f,
		map[string]string{"keep.md": "keep me\n", "gone.md": "delete me\n"},
		map[string]string{"keep.md": "keep me\n"},
	)
	f.pushRefToOrigin(shadowRepoPath, refName)
	rewindLocalRef(f, shadowRepoPath, refName)
	f.writeManifest("keep.md", "gone.md")
	f.writeOmcFile("gone.md", "local edit\n")

	if err := Restore(nil); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	assertFileContent(t, f.omcPath("gone.md"), "local edit\n")
}

// captureStdout is captureStderr for os.Stdout (pull --dry-run's report).
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	orig := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("creating pipe: %v", err)
	}
	os.Stdout = w

	done := make(chan string, 1)
	go func() {
		out, _ := io.ReadAll(r)
		done <- string(out)
	}()

	fn()

	os.Stdout = orig
	_ = w.Close()
	out := <-done
	_ = r.Close()
	return out
}

// snapshotOmc maps every regular file under .omc/ to its content.
func snapshotOmc(t *testing.T, f *fixture) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(f.omcPath(), func(p string, d os.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() {
			return err
		}
		content, err := os.ReadFile(p)
		out[p] = string(content)
		return err
	})
	if err != nil {
		t.Fatalf("snapshotting .omc: %v", err)
	}
	return out
}

// Ports "--dry-run reports every action, mutates nothing (disk, manifest,
// local ref), and a real pull afterwards still merges".
func TestRestoreDryRunReportsAndMutatesNothing(t *testing.T) {
	f := newFixture(t)

	shadowRepoPath, refName := initAndSeedRef(t, f,
		map[string]string{
			".sync-manifest": "a.md\nb.md\nc.md\ngone.md\nkept.md\n",
			"a.md":           "1\n2\n3\n4\n5\n", "b.md": "b1\n", "c.md": "c1\n",
			"gone.md": "g\n", "kept.md": "k\n",
		},
		map[string]string{
			".sync-manifest": "a.md\nb.md\nc.md\ngone.md\nkept.md\nnew.md\n",
			"a.md":           "1 remote\n2\n3\n4\n5\n", "b.md": "b remote\n", "c.md": "c1\n",
			"new.md": "new\n",
		},
	)
	f.pushRefToOrigin(shadowRepoPath, refName)
	rewindLocalRef(f, shadowRepoPath, refName)

	f.writeManifest("a.md", "b.md", "c.md", "gone.md", "kept.md")
	f.writeOmcFile("a.md", "1\n2\n3\n4\n5 local\n")
	f.writeOmcFile("b.md", "b local\n")
	f.writeOmcFile("c.md", "c local\n")
	f.writeOmcFile("gone.md", "g\n")
	f.writeOmcFile("kept.md", "k local\n")

	diskBefore := snapshotOmc(t, f)
	refBefore := f.git(shadowRepoPath, "--git-dir="+shadowRepoPath, "rev-parse", refName)

	var err error
	out := captureStdout(t, func() { err = Restore([]string{"--dry-run"}) })
	if err != nil {
		t.Fatalf("Restore --dry-run: %v", err)
	}

	got := strings.Split(strings.TrimSpace(out), "\n")
	slices.Sort(got)
	want := []string{
		"would-merge a.md",
		"would-conflict b.md (1 hunk(s))",
		"would-keep-local c.md",
		"would-write new.md",
		"would-delete gone.md",
		"would-keep kept.md",
		"plan-sync: dry-run: 6 file(s) would change (1 would-merge, 1 would-conflict, 1 would-keep-local, 1 would-write, 1 would-delete, 1 would-keep); nothing was modified",
	}
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("dry-run report:\n got %q\nwant %q", got, want)
	}
	if diskAfter := snapshotOmc(t, f); !maps.Equal(diskAfter, diskBefore) {
		t.Fatalf("dry-run modified .omc:\nbefore %v\nafter  %v", diskBefore, diskAfter)
	}
	if refAfter := f.git(shadowRepoPath, "--git-dir="+shadowRepoPath, "rev-parse", refName); refAfter != refBefore {
		t.Fatalf("dry-run moved the local ref: %s -> %s", refBefore, refAfter)
	}

	// The real pull afterwards still sees the untouched base and merges.
	warnings := restoreCapturingStderr(t)
	assertFileContent(t, f.omcPath("a.md"), "1 remote\n2\n3\n4\n5 local\n")
	merged, _ := os.ReadFile(f.omcPath("b.md"))
	assertContains(t, string(merged), "<<<<<<< local\nb local\n")
	assertFileContent(t, f.omcPath("c.md"), "c local\n")
	assertFileContent(t, f.omcPath("new.md"), "new\n")
	assertFileContent(t, f.omcPath("kept.md"), "k local\n")
	assertNotExists(t, f.omcPath("gone.md"))
	manifestAfter, _ := os.ReadFile(f.omcPath(".sync-manifest"))
	assertContains(t, string(manifestAfter), "new.md")
	assertContains(t, warnings, "plan-sync: merged a.md")
}

// Ports "throws a clear error when the shadow repo hasn't been initialized".
func TestRestoreFailsWhenShadowRepoNotInitialized(t *testing.T) {
	newFixture(t)

	err := Restore(nil)
	if err == nil {
		t.Fatal("expected Restore to fail when the shadow repo doesn't exist")
	}
	if !strings.Contains(err.Error(), "init --track shadow") {
		t.Fatalf("error should point at `init --track shadow`, got: %v", err)
	}
}

// Ports "AC-B2 (genuine): a file deleted locally (manifest left unchanged)
// then pushed is absent after restore against a fresh shadow clone".
//
// Also exercises the tryFetchRef path end-to-end: the local ref is one
// commit behind origin, so restore only sees the deletion if it fetches
// the ref from origin first.
func TestRestoreDeletesPathGenuinelySyncedThenRemoved(t *testing.T) {
	f := newFixture(t)

	shadowRepoPath, refName := initAndSeedRef(t, f,
		map[string]string{"keep.md": "keep me\n", "gone.md": "delete me\n"},
		map[string]string{"keep.md": "keep me\n"},
	)
	f.pushRefToOrigin(shadowRepoPath, refName)
	rewindLocalRef(f, shadowRepoPath, refName)

	f.writeManifest("keep.md", "gone.md")

	// This machine last synced the pre-deletion commit and still holds that
	// unmodified copy, so the assertion proves restore actively deletes it
	// rather than merely observing it was already gone.
	f.writeOmcFile("gone.md", "delete me\n")

	if err := Restore(nil); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	assertFileContent(t, f.omcPath("keep.md"), "keep me\n")
	assertNotExists(t, f.omcPath("gone.md"))
}

// Ports "does not delete a local file that was never successfully synced
// (always scan-matched), even though absent from the target tree".
//
// This is the deletion-scoping invariant: deletion is (ref history \ target
// tree), never (manifest \ target tree).
func TestRestoreDoesNotDeleteNeverSyncedPath(t *testing.T) {
	f := newFixture(t)

	// `secret.md` never appears in ANY commit on this ref — the Phase-1
	// stand-in for "push's advisory secret-shape scan always skipped it".
	initAndSeedRef(t, f, map[string]string{"keep.md": "keep me\n"})

	f.writeManifest("keep.md", "secret.md")
	f.writeOmcFile("secret.md", "my ssn is 123-45-6789\n")

	if err := Restore(nil); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	assertFileContent(t, f.omcPath("keep.md"), "keep me\n")
	assertFileContent(t, f.omcPath("secret.md"), "my ssn is 123-45-6789\n")
}

// A manifest-listed path that was never synced AND has an outdated-looking
// sibling that WAS synced-then-removed: only the latter is deleted. Guards
// against a regression that scopes deletion per-run rather than per-path.
func TestRestoreDeletionScopingIsPerPath(t *testing.T) {
	f := newFixture(t)

	shadowRepoPath, refName := initAndSeedRef(t, f,
		map[string]string{"keep.md": "k\n", "was-synced.md": "s\n"},
		map[string]string{"keep.md": "k\n"},
	)
	f.pushRefToOrigin(shadowRepoPath, refName)
	rewindLocalRef(f, shadowRepoPath, refName)

	f.writeManifest("keep.md", "was-synced.md", "never-synced.md")
	f.writeOmcFile("was-synced.md", "s\n")
	f.writeOmcFile("never-synced.md", "never backed up\n")

	if err := Restore(nil); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	assertNotExists(t, f.omcPath("was-synced.md"))
	assertFileContent(t, f.omcPath("never-synced.md"), "never backed up\n")
}

// Ports "AC-B3: push/restore round-trip is byte-for-byte identical for CRLF
// content".
func TestRestoreRoundTripsCRLFByteForByte(t *testing.T) {
	f := newFixture(t)

	original := "line one\r\nline two\r\nline three\r\n"
	initAndSeedRef(t, f, map[string]string{"crlf.md": original})
	f.writeManifest("crlf.md")

	if err := Restore(nil); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	restored, err := os.ReadFile(f.omcPath("crlf.md"))
	if err != nil {
		t.Fatalf("reading crlf.md: %v", err)
	}
	if sha256.Sum256(restored) != sha256.Sum256([]byte(original)) {
		t.Fatalf("CRLF round-trip is not byte-for-byte: got %q, want %q", restored, original)
	}
}

// Verifies US-002 AC7 / US-009's blob bound: a blob at/over maxBlobBytes is
// refused rather than buffered unboundedly, before any target path is
// written. Shrinks maxBlobBytes for the duration of the test (save/restore)
// so this runs fast without allocating a real 100MB fixture — the mechanism
// under test (runGitBytesBounded's LimitReader-based cutoff) doesn't care
// what the actual limit value is.
func TestRestoreRefusesBlobAtOrOverTheSizeBound(t *testing.T) {
	const testLimit = 1024
	original := maxBlobBytes
	maxBlobBytes = testLimit
	t.Cleanup(func() { maxBlobBytes = original })

	f := newFixture(t)
	overLimit := strings.Repeat("x", testLimit+1)
	initAndSeedRef(t, f, map[string]string{"big.md": overLimit, "small.md": "fits fine\n"})
	f.writeManifest("big.md", "small.md")

	err := Restore(nil)
	if err == nil {
		t.Fatal("Restore: expected an error for a blob exceeding the size bound, got nil")
	}
	if !strings.Contains(err.Error(), "exceeds") {
		t.Errorf("Restore error = %q, want it to mention the size bound", err.Error())
	}

	// No partial write: listTree enumerates before any mutation, so the
	// over-limit blob being ordered before "small.md" in the tree must not
	// have let small.md be written either.
	if _, statErr := os.Stat(f.omcPath("small.md")); !os.IsNotExist(statErr) {
		t.Errorf("small.md should not have been written when an earlier blob in the tree exceeded the size bound; stat err = %v", statErr)
	}
}

// The at-the-boundary case: exactly testLimit bytes must succeed (only
// testLimit+1 and above are refused).
func TestRestoreAllowsBlobExactlyAtTheSizeBound(t *testing.T) {
	const testLimit = 1024
	original := maxBlobBytes
	maxBlobBytes = testLimit
	t.Cleanup(func() { maxBlobBytes = original })

	f := newFixture(t)
	exactlyAtLimit := strings.Repeat("x", testLimit)
	initAndSeedRef(t, f, map[string]string{"exact.md": exactlyAtLimit})
	f.writeManifest("exact.md")

	if err := Restore(nil); err != nil {
		t.Fatalf("Restore: blob exactly at the size bound should be allowed, got: %v", err)
	}
	restored, err := os.ReadFile(f.omcPath("exact.md"))
	if err != nil {
		t.Fatalf("reading exact.md: %v", err)
	}
	if string(restored) != exactlyAtLimit {
		t.Errorf("restored content does not match the at-boundary fixture")
	}
}

// Ports "supports a --ref override pointing at an explicit sha".
func TestRestoreSupportsExplicitRefOverride(t *testing.T) {
	f := newFixture(t)

	if err := Init(nil); err != nil {
		t.Fatalf("Init: %v", err)
	}
	shadowRepoPath := f.shadowRepoPath(".omc")
	refName := f.refName(".omc")

	firstSha := f.commitFixtureTree(shadowRepoPath, refName, map[string]string{"a.md": "version one\n"})
	f.commitFixtureTree(shadowRepoPath, refName, map[string]string{"a.md": "version two\n"})
	f.writeManifest("a.md")

	if err := Restore([]string{"--ref", firstSha}); err != nil {
		t.Fatalf("Restore --ref: %v", err)
	}
	assertFileContent(t, f.omcPath("a.md"), "version one\n")

	// Without the override, the rolled-back file now differs from the
	// merge base (the tip, version two) while the remote hasn't moved, so
	// it reads as an unpushed local change and is kept.
	if err := Restore(nil); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	assertFileContent(t, f.omcPath("a.md"), "version one\n")
}

// Ports "N2: a symlink at a manifest-listed destination path is not
// clobbered by restore" (HARDENING-HISTORY findings 6/11, write path).
func TestRestoreRefusesToWriteThroughSymlinkAtDestination(t *testing.T) {
	f := newFixture(t)

	initAndSeedRef(t, f, map[string]string{"a.md": "repo content\n"})
	f.writeManifest("a.md")

	outsideFile := filepath.Join(f.tmpDir, "OUTSIDE.txt")
	f.writeFile(outsideFile, []byte("original outside content\n"))
	if err := os.MkdirAll(f.omcPath(), 0o755); err != nil {
		t.Fatalf("mkdir .omc: %v", err)
	}
	if err := os.Symlink(outsideFile, f.omcPath("a.md")); err != nil {
		t.Fatalf("symlinking a.md: %v", err)
	}

	var err error
	warnings := captureStderr(t, func() { err = Restore(nil) })
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	if !strings.Contains(warnings, "a.md") {
		t.Fatalf("expected a refusal warning mentioning a.md, got: %q", warnings)
	}
	assertFileContent(t, outsideFile, "original outside content\n")
	assertIsSymlink(t, f.omcPath("a.md"))
}

// Ports "N3: a DANGLING symlink at a manifest-listed destination path is not
// silently created-through by restore" (HARDENING-HISTORY finding 7 — the
// lstat-vs-stat distinction).
func TestRestoreRefusesToWriteThroughDanglingSymlinkAtDestination(t *testing.T) {
	f := newFixture(t)

	initAndSeedRef(t, f, map[string]string{"a.md": "repo content\n"})
	f.writeManifest("a.md")

	danglingTarget := filepath.Join(f.tmpDir, "does-not-exist.txt")
	if err := os.MkdirAll(f.omcPath(), 0o755); err != nil {
		t.Fatalf("mkdir .omc: %v", err)
	}
	if err := os.Symlink(danglingTarget, f.omcPath("a.md")); err != nil {
		t.Fatalf("symlinking a.md: %v", err)
	}

	var err error
	warnings := captureStderr(t, func() { err = Restore(nil) })
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	if !strings.Contains(warnings, "a.md") {
		t.Fatalf("expected a refusal warning mentioning a.md, got: %q", warnings)
	}
	assertIsSymlink(t, f.omcPath("a.md"))
	assertNotExists(t, danglingTarget)
}

// Ports "N2: a symlinked directory component under .omc/ does not allow
// restore to write outside the repo" (HARDENING-HISTORY finding 8, depth 1).
func TestRestoreRefusesToWriteThroughSymlinkedDirectoryComponent(t *testing.T) {
	f := newFixture(t)

	initAndSeedRef(t, f, map[string]string{"plans/foo.md": "plan content\n"})
	f.writeManifest("plans/foo.md")

	outsideDir := filepath.Join(f.tmpDir, "outside-plans")
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatalf("mkdir outside dir: %v", err)
	}
	if err := os.MkdirAll(f.omcPath(), 0o755); err != nil {
		t.Fatalf("mkdir .omc: %v", err)
	}
	if err := os.Symlink(outsideDir, f.omcPath("plans")); err != nil {
		t.Fatalf("symlinking .omc/plans: %v", err)
	}

	var err error
	captureStderr(t, func() { err = Restore(nil) })
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	assertNotExists(t, filepath.Join(outsideDir, "foo.md"))
}

// Ports "N3: a symlinked directory ancestor at depth >=2 below the write
// target still does not allow restore to escape" — the immediate parent
// (`.omc/a/b/c`) doesn't exist at all, so an immediate-parent-only guard
// would see "fresh write, nothing here" and walk straight through the
// symlink two levels up (HARDENING-HISTORY finding 8).
func TestRestoreRefusesToWriteThroughSymlinkedAncestorAtDepth(t *testing.T) {
	f := newFixture(t)

	initAndSeedRef(t, f, map[string]string{"a/b/c/deep.md": "deep content\n"})
	f.writeManifest("a/b/c/deep.md")

	outsideDir := filepath.Join(f.tmpDir, "outside-deep-a")
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatalf("mkdir outside dir: %v", err)
	}
	if err := os.MkdirAll(f.omcPath(), 0o755); err != nil {
		t.Fatalf("mkdir .omc: %v", err)
	}
	if err := os.Symlink(outsideDir, f.omcPath("a")); err != nil {
		t.Fatalf("symlinking .omc/a: %v", err)
	}

	var err error
	captureStderr(t, func() { err = Restore(nil) })
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	assertNotExists(t, filepath.Join(outsideDir, "b", "c", "deep.md"))
}

// A DANGLING symlinked ancestor two levels up: EvalSymlinks fails resolving
// it, which must fail CLOSED (refuse) rather than being absorbed as "this
// component is just absent, keep walking" (HARDENING-HISTORY finding 12 and
// the Go-vs-Node primitive-parity note).
func TestRestoreRefusesToWriteThroughDanglingSymlinkedAncestor(t *testing.T) {
	f := newFixture(t)

	initAndSeedRef(t, f, map[string]string{"a/b/c/deep.md": "deep content\n"})
	f.writeManifest("a/b/c/deep.md")

	if err := os.MkdirAll(f.omcPath(), 0o755); err != nil {
		t.Fatalf("mkdir .omc: %v", err)
	}
	if err := os.Symlink(filepath.Join(f.tmpDir, "nowhere-at-all"), f.omcPath("a")); err != nil {
		t.Fatalf("symlinking .omc/a: %v", err)
	}

	var err error
	captureStderr(t, func() { err = Restore(nil) })
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	assertNotExists(t, filepath.Join(f.tmpDir, "nowhere-at-all"))
	assertIsSymlink(t, f.omcPath("a"))
}

// Ports "US-010: a symlinked directory component under .omc/ does not allow
// restore's DELETE path to remove a file outside the repo"
// (HARDENING-HISTORY finding 11 — the delete path was one of the four
// unguarded call sites).
func TestRestoreDeletePathRefusesSymlinkedDirectoryComponent(t *testing.T) {
	f := newFixture(t)

	// Genuinely synced, then genuinely removed — so the delete loop really
	// does try to remove `.omc/plans/foo.md`.
	initAndSeedRef(t, f,
		map[string]string{"plans/foo.md": "plan content\n"},
		map[string]string{"other.md": "other\n"},
	)
	f.writeManifest("plans/foo.md")

	outsideDir := filepath.Join(f.tmpDir, "outside-plans-delete")
	outsideFile := filepath.Join(outsideDir, "foo.md")
	f.writeFile(outsideFile, []byte("outside content that must survive\n"))
	if err := os.Symlink(outsideDir, f.omcPath("plans")); err != nil {
		t.Fatalf("symlinking .omc/plans: %v", err)
	}

	var err error
	captureStderr(t, func() { err = Restore(nil) })
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	assertFileContent(t, outsideFile, "outside content that must survive\n")
}

// The delete path's equivalent of the destination-symlink case: a symlink
// AT the manifest-listed path itself must not be followed to unlink the
// outside target, and must not be unlinked either.
func TestRestoreDeletePathRefusesSymlinkAtDestination(t *testing.T) {
	f := newFixture(t)

	initAndSeedRef(t, f,
		map[string]string{"gone.md": "was here\n"},
		map[string]string{"other.md": "other\n"},
	)
	f.writeManifest("gone.md")

	outsideFile := filepath.Join(f.tmpDir, "OUTSIDE-DELETE.txt")
	f.writeFile(outsideFile, []byte("outside content that must survive\n"))
	if err := os.Symlink(outsideFile, f.omcPath("gone.md")); err != nil {
		t.Fatalf("symlinking gone.md: %v", err)
	}

	var err error
	warnings := captureStderr(t, func() { err = Restore(nil) })
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	if !strings.Contains(warnings, "gone.md") {
		t.Fatalf("expected a refusal warning mentioning gone.md, got: %q", warnings)
	}
	assertFileContent(t, outsideFile, "outside content that must survive\n")
	assertIsSymlink(t, f.omcPath("gone.md"))
}

// The delete path's equivalent of the dangling-destination case: os.Stat
// would report this path as "doesn't exist" (the target is missing), so a
// stat-based existence check would skip the containment check entirely.
func TestRestoreDeletePathRefusesDanglingSymlinkAtDestination(t *testing.T) {
	f := newFixture(t)

	initAndSeedRef(t, f,
		map[string]string{"gone.md": "was here\n"},
		map[string]string{"other.md": "other\n"},
	)
	f.writeManifest("gone.md")

	if err := os.Symlink(filepath.Join(f.tmpDir, "no-such-target.txt"), f.omcPath("gone.md")); err != nil {
		t.Fatalf("symlinking gone.md: %v", err)
	}

	var err error
	captureStderr(t, func() { err = Restore(nil) })
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	assertIsSymlink(t, f.omcPath("gone.md"))
}

// The delete path's equivalent of the depth->=2 symlinked-ancestor case.
func TestRestoreDeletePathRefusesSymlinkedAncestorAtDepth(t *testing.T) {
	f := newFixture(t)

	initAndSeedRef(t, f,
		map[string]string{"a/b/c/deep.md": "deep content\n"},
		map[string]string{"other.md": "other\n"},
	)
	f.writeManifest("a/b/c/deep.md")

	outsideDir := filepath.Join(f.tmpDir, "outside-deep-delete")
	outsideFile := filepath.Join(outsideDir, "b", "c", "deep.md")
	f.writeFile(outsideFile, []byte("outside deep content that must survive\n"))
	if err := os.Symlink(outsideDir, f.omcPath("a")); err != nil {
		t.Fatalf("symlinking .omc/a: %v", err)
	}

	var err error
	captureStderr(t, func() { err = Restore(nil) })
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}

	assertFileContent(t, outsideFile, "outside deep content that must survive\n")
}

// Ports "does not touch manifest-scoped files that are still present in the
// target tree".
func TestRestoreLeavesPathsStillInTargetTreeIntact(t *testing.T) {
	f := newFixture(t)

	shadowRepoPath, refName := initAndSeedRef(t, f, map[string]string{
		"a.md": "a content\n",
		"b.md": "b content\n",
	})
	f.pushRefToOrigin(shadowRepoPath, refName)
	f.writeManifest("a.md", "b.md")

	f.switchToFreshMachine("still-present")
	if err := Restore(nil); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	assertFileContent(t, f.omcPath("a.md"), "a content\n")
	assertFileContent(t, f.omcPath("b.md"), "b content\n")
}

// The incoming manifest travels in the tree but is UNION-merged into the
// local one, never wholesale-overwritten: a local-only entry survives, and
// (because it was never in the ref's history) its local file is not deleted.
func TestRestoreUnionMergesIncomingManifest(t *testing.T) {
	f := newFixture(t)

	initAndSeedRef(t, f, map[string]string{
		".sync-manifest": "incoming.md\nshared.md\n",
		"incoming.md":    "incoming content\n",
		"shared.md":      "shared content\n",
	})

	f.writeManifest("local-only.md", "shared.md")
	f.writeOmcFile("local-only.md", "local only content\n")

	if err := Restore(nil); err != nil {
		t.Fatalf("Restore: %v", err)
	}

	manifestBytes, err := os.ReadFile(f.omcPath(".sync-manifest"))
	if err != nil {
		t.Fatalf("reading local manifest: %v", err)
	}
	for _, want := range []string{"local-only.md", "shared.md", "incoming.md"} {
		if !strings.Contains(string(manifestBytes), want) {
			t.Fatalf("merged manifest should contain %q, got: %q", want, manifestBytes)
		}
	}
	assertFileContent(t, f.omcPath("local-only.md"), "local only content\n")
	assertFileContent(t, f.omcPath("incoming.md"), "incoming content\n")
}

// A malformed incoming manifest entry (absolute path / `../` traversal) is
// skipped with a warning rather than aborting the whole restore, and never
// lands in the local manifest.
func TestRestoreSkipsInvalidIncomingManifestEntries(t *testing.T) {
	f := newFixture(t)

	initAndSeedRef(t, f, map[string]string{
		".sync-manifest": "ok.md\n../escape.md\n/etc/passwd\n# a comment\n\n",
		"ok.md":          "ok content\n",
	})
	f.writeManifest("ok.md")

	var err error
	warnings := captureStderr(t, func() { err = Restore(nil) })
	if err != nil {
		t.Fatalf("Restore should not abort on a bad incoming manifest line: %v", err)
	}
	if !strings.Contains(warnings, "escape.md") || !strings.Contains(warnings, "/etc/passwd") {
		t.Fatalf("expected skip warnings for both invalid entries, got: %q", warnings)
	}

	manifestBytes, err := os.ReadFile(f.omcPath(".sync-manifest"))
	if err != nil {
		t.Fatalf("reading local manifest: %v", err)
	}
	if strings.Contains(string(manifestBytes), "escape.md") ||
		strings.Contains(string(manifestBytes), "/etc/passwd") {
		t.Fatalf("invalid entries must never be merged in, got: %q", manifestBytes)
	}
	if !strings.Contains(string(manifestBytes), "ok.md") {
		t.Fatalf("valid entry should survive, got: %q", manifestBytes)
	}
	assertNotExists(t, filepath.Join(f.tmpDir, "escape.md"))
}

// Observability (Phase-1 requirement), corrupt ref: `pull --track shadow`
// against a ref whose stored object doesn't exist must exit NON-ZERO with
// NON-EMPTY stderr, and must leave every already-on-disk local file
// completely untouched — no partial writes.
func TestRestoreObservabilityCorruptRefExitsNonZeroAndTouchesNothing(t *testing.T) {
	f := newFixture(t)

	shadowRepoPath, refName := initAndSeedRef(t, f, map[string]string{"a.md": "synced content\n"})
	f.writeManifest("a.md", "gone.md")
	f.writeOmcFile("a.md", "PRISTINE local a\n")
	f.writeOmcFile("gone.md", "PRISTINE local gone\n")

	// Corrupt the ref: point it at a well-formed sha that names no object.
	refPath := filepath.Join(shadowRepoPath, filepath.FromSlash(refName))
	f.writeFile(refPath, []byte(strings.Repeat("dead1234", 5)[:40]+"\n"))
	// A packed-refs entry would otherwise still resolve the ref.
	_ = os.Remove(filepath.Join(shadowRepoPath, "packed-refs"))

	exitCode, stderr := dispatchPullShadow(t)

	if exitCode == 0 {
		t.Fatalf("expected a non-zero exit code, got %d (stderr: %q)", exitCode, stderr)
	}
	if strings.TrimSpace(stderr) == "" {
		t.Fatal("expected non-empty stderr explaining the failure")
	}
	if !strings.Contains(stderr, refName) {
		t.Fatalf("stderr should name the unresolvable ref, got: %q", stderr)
	}

	// No partial writes: both local files are byte-for-byte as they were.
	assertFileContent(t, f.omcPath("a.md"), "PRISTINE local a\n")
	assertFileContent(t, f.omcPath("gone.md"), "PRISTINE local gone\n")
}

// Observability, unreachable origin: a fresh shadow repo whose origin does
// not exist and whose ref was never fetched must exit non-zero with
// non-empty stderr, leaving local files untouched. The best-effort fetch
// swallows its own failure; the real diagnostic comes from ls-tree.
func TestRestoreObservabilityUnreachableOriginExitsNonZeroAndTouchesNothing(t *testing.T) {
	f := newFixture(t)

	unreachable := filepath.Join(f.tmpDir, "no-such-remote.git")
	if err := Init([]string{"--remote", unreachable}); err != nil {
		t.Fatalf("Init: %v", err)
	}

	f.writeManifest("a.md")
	f.writeOmcFile("a.md", "PRISTINE local a\n")

	exitCode, stderr := dispatchPullShadow(t)

	if exitCode == 0 {
		t.Fatalf("expected a non-zero exit code, got %d (stderr: %q)", exitCode, stderr)
	}
	if strings.TrimSpace(stderr) == "" {
		t.Fatal("expected non-empty stderr explaining the failure")
	}
	assertFileContent(t, f.omcPath("a.md"), "PRISTINE local a\n")
}

// dispatchPullShadow runs `plan-sync pull --track shadow` through the real
// CLI dispatcher, returning the process exit code and everything the
// dispatcher wrote to stderr. This is what makes the observability
// assertions about "non-zero exit + non-empty stderr" real rather than a
// restatement of `err != nil`.
func dispatchPullShadow(t *testing.T) (exitCode int, stderr string) {
	t.Helper()
	original, hadOriginal := cli.Commands["pull"]
	cli.Commands["pull"] = cli.CommandFunc(Restore)
	t.Cleanup(func() {
		if hadOriginal {
			cli.Commands["pull"] = original
		} else {
			delete(cli.Commands, "pull")
		}
	})

	stderr = captureStderr(t, func() {
		exitCode = cli.Dispatch([]string{"pull", "--track", "shadow"})
	})
	return exitCode, stderr
}
