package manifest

import (
	"bytes"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// newManifestPath returns `<tmp>/.omc/.sync-manifest` for a fresh temp dir,
// mirroring the TS suite's beforeEach fixture. The `.omc` directory is
// deliberately NOT created, so tests can exercise the create-parent-dir path.
func newManifestPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), ".omc", ManifestFilename)
}

func writeManifest(t *testing.T, manifestPath, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(manifestPath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(manifestPath, []byte(contents), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
}

func readRaw(t *testing.T, manifestPath string) string {
	t.Helper()
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	return string(data)
}

// captureStderr swaps the package's warning sink for the duration of fn and
// returns everything written to it.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	prev := stderr
	stderr = &buf
	defer func() { stderr = prev }()
	fn()
	return buf.String()
}

func assertEntries(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("entries = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("entries = %#v, want %#v", got, want)
		}
	}
}

func assertEntriesSorted(t *testing.T, got, want []string) {
	t.Helper()
	g := append([]string(nil), got...)
	sort.Strings(g)
	assertEntries(t, g, want)
}

// --- IsPathContained -------------------------------------------------------

func TestIsPathContained(t *testing.T) {
	root := t.TempDir()

	cases := []struct {
		relPath string
		want    bool
	}{
		{"notes.md", true},
		{"plans/foo.md", true},
		{"plans/../notes.md", true},
		{"", true},
		{".", true},
		{"../escape.md", false},
		{"../../etc/passwd", false},
		{"plans/../../escape.md", false},
		{"/etc/passwd", false},
	}

	for _, c := range cases {
		if got := IsPathContained(root, c.relPath); got != c.want {
			t.Errorf("IsPathContained(root, %q) = %v, want %v", c.relPath, got, c.want)
		}
	}
}

// --- ManifestExists --------------------------------------------------------

func TestManifestExistsDistinguishesMissingFromEmpty(t *testing.T) {
	manifestPath := newManifestPath(t)

	if ManifestExists(manifestPath) {
		t.Fatal("ManifestExists = true for a missing manifest")
	}

	writeManifest(t, manifestPath, "")

	if !ManifestExists(manifestPath) {
		t.Fatal("ManifestExists = false for a present-but-empty manifest")
	}
	// ReadManifest deliberately collapses both cases to zero entries.
	assertEntries(t, ReadManifest(manifestPath), []string{})
}

// A dangling symlink at the manifest path must report "missing", matching
// TS's fs.existsSync (follows symlinks) — not os.Lstat, which would report
// "exists" and misclassify it as present-but-empty (see the fix comment on
// ManifestExists for why that matters for a Phase 2 caller).
func TestManifestExistsReportsMissingForDanglingSymlink(t *testing.T) {
	manifestPath := newManifestPath(t)
	if err := os.MkdirAll(filepath.Dir(manifestPath), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.Symlink(filepath.Join(filepath.Dir(manifestPath), "does-not-exist"), manifestPath); err != nil {
		t.Fatalf("Symlink: %v", err)
	}

	if ManifestExists(manifestPath) {
		t.Fatal("ManifestExists = true for a dangling symlink at the manifest path, want false (matching fs.existsSync)")
	}
}

// --- ReadManifest ----------------------------------------------------------

func TestReadNonexistentManifestReturnsEmpty(t *testing.T) {
	assertEntries(t, ReadManifest(newManifestPath(t)), []string{})
}

func TestReadEmptyManifestReturnsEmpty(t *testing.T) {
	manifestPath := newManifestPath(t)
	writeManifest(t, manifestPath, "")

	assertEntries(t, ReadManifest(manifestPath), []string{})
}

func TestReadPopulatedManifestIgnoresBlankLinesAndComments(t *testing.T) {
	manifestPath := newManifestPath(t)
	writeManifest(t, manifestPath, strings.Join([]string{
		"# this is a comment",
		"notes.md",
		"",
		"  ",
		"plans/foo.md",
		"# another comment",
	}, "\n"))

	assertEntries(t, ReadManifest(manifestPath), []string{"notes.md", "plans/foo.md"})
}

// Required byte-parity/hardening test 5: an out-of-bounds hand-edited entry
// is dropped with a warning, but the rest of the file still parses.
func TestReadManifestSkipsOutOfBoundsEntriesWithWarning(t *testing.T) {
	manifestPath := newManifestPath(t)
	writeManifest(t, manifestPath, strings.Join([]string{
		"notes.md",
		"../../etc/passwd",
		"/etc/shadow",
		"plans/foo.md",
	}, "\n"))

	var entries []string
	warnings := captureStderr(t, func() {
		entries = ReadManifest(manifestPath)
	})

	assertEntries(t, entries, []string{"notes.md", "plans/foo.md"})

	for _, want := range []string{
		"plan-sync: ignoring out-of-bounds manifest entry '../../etc/passwd'\n",
		"plan-sync: ignoring out-of-bounds manifest entry '/etc/shadow'\n",
	} {
		if !strings.Contains(warnings, want) {
			t.Errorf("stderr = %q, missing %q", warnings, want)
		}
	}
}

// --- AddToManifest ---------------------------------------------------------

func TestAddCreatesFileAndParentDirectory(t *testing.T) {
	manifestPath := newManifestPath(t)

	if ManifestExists(manifestPath) {
		t.Fatal("manifest unexpectedly exists before add")
	}
	if err := AddToManifest(manifestPath, "notes.md"); err != nil {
		t.Fatalf("AddToManifest: %v", err)
	}
	if !ManifestExists(manifestPath) {
		t.Fatal("manifest was not created")
	}
	assertEntries(t, ReadManifest(manifestPath), []string{"notes.md"})
	if raw := readRaw(t, manifestPath); raw != "notes.md\n" {
		t.Fatalf("raw = %q, want %q", raw, "notes.md\n")
	}
}

func TestAddDuplicateIsIdempotent(t *testing.T) {
	manifestPath := newManifestPath(t)

	for i := 0; i < 2; i++ {
		if err := AddToManifest(manifestPath, "notes.md"); err != nil {
			t.Fatalf("AddToManifest #%d: %v", i, err)
		}
	}

	assertEntries(t, ReadManifest(manifestPath), []string{"notes.md"})

	var rawLines []string
	for _, line := range strings.Split(readRaw(t, manifestPath), "\n") {
		if strings.TrimSpace(line) != "" {
			rawLines = append(rawLines, line)
		}
	}
	assertEntries(t, rawLines, []string{"notes.md"})
}

func TestAddMultipleDistinctPathsAcrossSeparateCalls(t *testing.T) {
	manifestPath := newManifestPath(t)

	if err := AddToManifest(manifestPath, "notes.md"); err != nil {
		t.Fatalf("AddToManifest: %v", err)
	}
	if err := AddToManifest(manifestPath, "plans/foo.md"); err != nil {
		t.Fatalf("AddToManifest: %v", err)
	}

	assertEntries(t, ReadManifest(manifestPath), []string{"notes.md", "plans/foo.md"})
	if raw := readRaw(t, manifestPath); raw != "notes.md\nplans/foo.md\n" {
		t.Fatalf("raw = %q, want %q", raw, "notes.md\nplans/foo.md\n")
	}
}

func TestAddRejectsTraversalPathWithoutWritingAnything(t *testing.T) {
	manifestPath := newManifestPath(t)

	err := AddToManifest(manifestPath, "../../etc/passwd")
	if err == nil {
		t.Fatal("AddToManifest accepted a '../' traversal path")
	}
	if !strings.Contains(err.Error(), "resolves outside .omc/") {
		t.Fatalf("err = %q, want it to mention 'resolves outside .omc/'", err)
	}
	if ManifestExists(manifestPath) {
		t.Fatal("manifest was written despite a rejected entry")
	}
}

func TestAddRejectsAbsolutePathWithoutWritingAnything(t *testing.T) {
	manifestPath := newManifestPath(t)

	err := AddToManifest(manifestPath, "/etc/passwd")
	if err == nil {
		t.Fatal("AddToManifest accepted an absolute path")
	}
	if !strings.Contains(err.Error(), "absolute paths are not allowed") {
		t.Fatalf("err = %q, want it to mention 'absolute paths are not allowed'", err)
	}
	if ManifestExists(manifestPath) {
		t.Fatal("manifest was written despite a rejected entry")
	}
}

// REQUIRED byte-parity test 1: appending onto a file that does NOT end in a
// newline inserts a leading "\n" so the new entry lands on its own line.
func TestAddInsertsLeadingNewlineWhenFileDoesNotEndInNewline(t *testing.T) {
	manifestPath := newManifestPath(t)
	writeManifest(t, manifestPath, "notes.md")

	if err := AddToManifest(manifestPath, "plans/foo.md"); err != nil {
		t.Fatalf("AddToManifest: %v", err)
	}

	const want = "notes.md\nplans/foo.md\n"
	if raw := readRaw(t, manifestPath); raw != want {
		t.Fatalf("raw = %q, want %q", raw, want)
	}
}

// REQUIRED byte-parity test 2: appending onto a file that DOES end in a
// newline adds no extra leading newline (no blank line between entries).
func TestAddInsertsNoLeadingNewlineWhenFileEndsInNewline(t *testing.T) {
	manifestPath := newManifestPath(t)
	writeManifest(t, manifestPath, "notes.md\n")

	if err := AddToManifest(manifestPath, "plans/foo.md"); err != nil {
		t.Fatalf("AddToManifest: %v", err)
	}

	const want = "notes.md\nplans/foo.md\n"
	if raw := readRaw(t, manifestPath); raw != want {
		t.Fatalf("raw = %q, want %q", raw, want)
	}
}

// An existing but EMPTY file gets no leading newline either (the TS guard is
// `length > 0 && !endsWith("\n")`, so zero-length short-circuits to false).
func TestAddInsertsNoLeadingNewlineWhenFileIsEmpty(t *testing.T) {
	manifestPath := newManifestPath(t)
	writeManifest(t, manifestPath, "")

	if err := AddToManifest(manifestPath, "notes.md"); err != nil {
		t.Fatalf("AddToManifest: %v", err)
	}

	const want = "notes.md\n"
	if raw := readRaw(t, manifestPath); raw != want {
		t.Fatalf("raw = %q, want %q", raw, want)
	}
}

// --- RemoveFromManifest ----------------------------------------------------

func TestRemoveFromMissingManifestIsNoOp(t *testing.T) {
	manifestPath := newManifestPath(t)

	removed, err := RemoveFromManifest(manifestPath, "notes.md")
	if err != nil {
		t.Fatalf("RemoveFromManifest: %v", err)
	}
	if removed {
		t.Fatal("removed = true for a missing manifest")
	}
	if ManifestExists(manifestPath) {
		t.Fatal("RemoveFromManifest created the manifest file")
	}
}

func TestRemoveAbsentEntryIsNoOpAndLeavesFileByteIdentical(t *testing.T) {
	manifestPath := newManifestPath(t)
	const contents = "notes.md\nplans/foo.md\n"
	writeManifest(t, manifestPath, contents)

	removed, err := RemoveFromManifest(manifestPath, "missing.md")
	if err != nil {
		t.Fatalf("RemoveFromManifest: %v", err)
	}
	if removed {
		t.Fatal("removed = true for an absent entry")
	}
	if raw := readRaw(t, manifestPath); raw != contents {
		t.Fatalf("raw = %q, want it unchanged (%q)", raw, contents)
	}
}

// REQUIRED byte-parity test 3: removing ONE entry out of three PRESERVES the
// trailing newline. TS splits on "\n", which yields a trailing empty-string
// element that survives the filter and is re-joined back into a final "\n".
func TestRemoveOneOfThreePreservesTrailingNewline(t *testing.T) {
	manifestPath := newManifestPath(t)
	writeManifest(t, manifestPath, "a.md\nb.md\nc.md\n")

	removed, err := RemoveFromManifest(manifestPath, "b.md")
	if err != nil {
		t.Fatalf("RemoveFromManifest: %v", err)
	}
	if !removed {
		t.Fatal("removed = false, want true")
	}

	const want = "a.md\nc.md\n"
	raw := readRaw(t, manifestPath)
	if raw != want {
		t.Fatalf("raw = %q, want %q (trailing newline must be PRESERVED)", raw, want)
	}
	if !strings.HasSuffix(raw, "\n") {
		t.Fatalf("raw = %q lost its trailing newline", raw)
	}
	assertEntries(t, ReadManifest(manifestPath), []string{"a.md", "c.md"})
}

// REQUIRED byte-parity test 4: removing the SOLE remaining entry leaves the
// file exactly empty (zero bytes) — the degenerate case where split/join
// collapses to the single trailing empty string.
func TestRemoveSoleEntryLeavesFileExactlyEmpty(t *testing.T) {
	manifestPath := newManifestPath(t)
	writeManifest(t, manifestPath, "a.md\n")

	removed, err := RemoveFromManifest(manifestPath, "a.md")
	if err != nil {
		t.Fatalf("RemoveFromManifest: %v", err)
	}
	if !removed {
		t.Fatal("removed = false, want true")
	}

	raw := readRaw(t, manifestPath)
	if raw != "" {
		t.Fatalf("raw = %q, want the file to be exactly empty (0 bytes)", raw)
	}

	info, err := os.Stat(manifestPath)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Size() != 0 {
		t.Fatalf("size = %d, want 0", info.Size())
	}
	// Present-but-empty stays distinguishable from missing.
	if !ManifestExists(manifestPath) {
		t.Fatal("ManifestExists = false after emptying the manifest")
	}
}

func TestRemovePreservesSurroundingCommentsAndBlankLines(t *testing.T) {
	manifestPath := newManifestPath(t)
	writeManifest(t, manifestPath, "# header\n\nnotes.md\nplans/foo.md\n")

	removed, err := RemoveFromManifest(manifestPath, "notes.md")
	if err != nil {
		t.Fatalf("RemoveFromManifest: %v", err)
	}
	if !removed {
		t.Fatal("removed = false, want true")
	}

	const want = "# header\n\nplans/foo.md\n"
	if raw := readRaw(t, manifestPath); raw != want {
		t.Fatalf("raw = %q, want %q", raw, want)
	}
}

// The match is against the TRIMMED line, mirroring TS's `line.trim() === entryPath`.
func TestRemoveMatchesTrimmedLines(t *testing.T) {
	manifestPath := newManifestPath(t)
	writeManifest(t, manifestPath, "  notes.md  \nplans/foo.md\n")

	removed, err := RemoveFromManifest(manifestPath, "notes.md")
	if err != nil {
		t.Fatalf("RemoveFromManifest: %v", err)
	}
	if !removed {
		t.Fatal("removed = false, want true")
	}
	if raw := readRaw(t, manifestPath); raw != "plans/foo.md\n" {
		t.Fatalf("raw = %q, want %q", raw, "plans/foo.md\n")
	}
}

// --- HasGlobMeta -----------------------------------------------------------

func TestHasGlobMeta(t *testing.T) {
	cases := map[string]bool{
		"notes.md":       false,
		"plans/foo.md":   false,
		"plans/*.md":     true,
		"**/foo.md":      true,
		"note?.md":       true,
		"plans/[ab].md":  true,
		"plans/a-b_c.md": false,
	}

	for pattern, want := range cases {
		if got := HasGlobMeta(pattern); got != want {
			t.Errorf("HasGlobMeta(%q) = %v, want %v", pattern, got, want)
		}
	}
}

// --- ResolveManifestPaths --------------------------------------------------

func writeUnderOmcRoot(t *testing.T, manifestPath, relPath string) {
	t.Helper()
	filePath := filepath.Join(filepath.Dir(manifestPath), relPath)
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filePath, []byte("content\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestResolveLiteralEntryResolvesToItselfWhenFileExists(t *testing.T) {
	manifestPath := newManifestPath(t)
	writeUnderOmcRoot(t, manifestPath, "notes.md")
	if err := AddToManifest(manifestPath, "notes.md"); err != nil {
		t.Fatalf("AddToManifest: %v", err)
	}

	assertEntries(t, ResolveManifestPaths(manifestPath), []string{"notes.md"})
}

func TestResolveLiteralEntryResolvesToNothingWhenFileMissing(t *testing.T) {
	manifestPath := newManifestPath(t)
	if err := AddToManifest(manifestPath, "notes.md"); err != nil {
		t.Fatalf("AddToManifest: %v", err)
	}

	assertEntries(t, ResolveManifestPaths(manifestPath), []string{})
}

func TestResolvePatternEntryExpandsToEveryCurrentMatch(t *testing.T) {
	manifestPath := newManifestPath(t)
	writeUnderOmcRoot(t, manifestPath, "plans/a.md")
	writeUnderOmcRoot(t, manifestPath, "plans/b.md")
	writeUnderOmcRoot(t, manifestPath, "plans/skip.txt")
	if err := AddToManifest(manifestPath, "plans/*.md"); err != nil {
		t.Fatalf("AddToManifest: %v", err)
	}

	assertEntriesSorted(t, ResolveManifestPaths(manifestPath), []string{"plans/a.md", "plans/b.md"})
}

func TestResolvePatternPicksUpFilesCreatedAfterAllow(t *testing.T) {
	manifestPath := newManifestPath(t)
	if err := AddToManifest(manifestPath, "plans/*.md"); err != nil {
		t.Fatalf("AddToManifest: %v", err)
	}
	assertEntries(t, ResolveManifestPaths(manifestPath), []string{})

	writeUnderOmcRoot(t, manifestPath, "plans/late.md")

	assertEntries(t, ResolveManifestPaths(manifestPath), []string{"plans/late.md"})
}

func TestResolveCombinesLiteralAndPatternEntriesDeduplicated(t *testing.T) {
	manifestPath := newManifestPath(t)
	writeUnderOmcRoot(t, manifestPath, "notes.md")
	writeUnderOmcRoot(t, manifestPath, "plans/a.md")
	for _, entry := range []string{"notes.md", "plans/*.md", "plans/a.md"} {
		if err := AddToManifest(manifestPath, entry); err != nil {
			t.Fatalf("AddToManifest(%q): %v", entry, err)
		}
	}

	assertEntriesSorted(t, ResolveManifestPaths(manifestPath), []string{"notes.md", "plans/a.md"})
}

// --- ResolveManifestSyncCandidates -----------------------------------------

func TestSyncCandidatesIncludeLiteralEntriesThatDoNotExistOnDisk(t *testing.T) {
	manifestPath := newManifestPath(t)
	writeUnderOmcRoot(t, manifestPath, "plans/a.md")
	for _, entry := range []string{"deleted.md", "plans/*.md"} {
		if err := AddToManifest(manifestPath, entry); err != nil {
			t.Fatalf("AddToManifest(%q): %v", entry, err)
		}
	}

	// resolveManifestPaths alone drops the missing literal...
	assertEntriesSorted(t, ResolveManifestPaths(manifestPath), []string{"plans/a.md"})
	// ...but the sync-candidate list keeps it, for deletion propagation and
	// "missing locally" reporting.
	assertEntriesSorted(t, ResolveManifestSyncCandidates(manifestPath),
		[]string{"deleted.md", "plans/a.md"})
}

func TestSyncCandidatesDoNotInventPathsForNonMatchingPatterns(t *testing.T) {
	manifestPath := newManifestPath(t)
	if err := AddToManifest(manifestPath, "plans/*.md"); err != nil {
		t.Fatalf("AddToManifest: %v", err)
	}

	assertEntries(t, ResolveManifestSyncCandidates(manifestPath), []string{})
}

func TestSyncCandidatesDeduplicateLiteralAlreadyMatchedByPattern(t *testing.T) {
	manifestPath := newManifestPath(t)
	writeUnderOmcRoot(t, manifestPath, "plans/a.md")
	for _, entry := range []string{"plans/*.md", "plans/a.md"} {
		if err := AddToManifest(manifestPath, entry); err != nil {
			t.Fatalf("AddToManifest(%q): %v", entry, err)
		}
	}

	assertEntries(t, ResolveManifestSyncCandidates(manifestPath), []string{"plans/a.md"})
}
