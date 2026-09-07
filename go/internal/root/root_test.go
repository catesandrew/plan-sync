package root

import (
	"os"
	"path/filepath"
	"testing"
)

// initRoot creates repoRoot/<name>/.sync-config.json, marking that candidate
// as an initialized root for auto-detection.
func initRoot(t *testing.T, repoRoot, name string) {
	t.Helper()
	dir := filepath.Join(repoRoot, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, syncConfigFile), []byte("{}"), 0o644); err != nil {
		t.Fatalf("write sync config in %s: %v", dir, err)
	}
}

func TestResolveRootDirDefaultsWhenNothingInitialized(t *testing.T) {
	got, err := ResolveRootDir(t.TempDir(), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != DefaultRoot {
		t.Fatalf("got %q, want %q", got, DefaultRoot)
	}
}

func TestResolveRootDirAutoDetectsSoleInitializedRoot(t *testing.T) {
	repoRoot := t.TempDir()
	initRoot(t, repoRoot, ".omx")

	got, err := ResolveRootDir(repoRoot, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != ".omx" {
		t.Fatalf("got %q, want %q", got, ".omx")
	}
}

func TestResolveRootDirIgnoresCandidateWithoutSyncConfig(t *testing.T) {
	repoRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(repoRoot, ".omx"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	got, err := ResolveRootDir(repoRoot, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != DefaultRoot {
		t.Fatalf("got %q, want %q", got, DefaultRoot)
	}
}

func TestResolveRootDirFallsBackWhenAmbiguous(t *testing.T) {
	repoRoot := t.TempDir()
	initRoot(t, repoRoot, ".omx")
	initRoot(t, repoRoot, ".adlc")

	got, err := ResolveRootDir(repoRoot, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != DefaultRoot {
		t.Fatalf("got %q, want %q", got, DefaultRoot)
	}
}

func TestResolveRootDirPrefersExplicitRootOverDetection(t *testing.T) {
	repoRoot := t.TempDir()
	initRoot(t, repoRoot, ".omx")

	got, err := ResolveRootDir(repoRoot, "  .adlc  ")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != ".adlc" {
		t.Fatalf("got %q, want %q", got, ".adlc")
	}
}

func TestValidateRootRejectsUnsafeValues(t *testing.T) {
	for _, value := range []string{
		"",
		"   ",
		".",
		"..",
		"/etc",
		"a/b",
		`a\b`,
		"../escape",
	} {
		if got, err := ValidateRoot(value); err == nil {
			t.Errorf("ValidateRoot(%q) = %q, want error", value, got)
		}
	}
}

// TestValidateRootRejectsDotStripEscape is the core regression: "..." passes
// every naive check (it is not "." or "..", has no separators, is not
// absolute) yet RootSegment strips one leading dot and yields "..", escaping
// a directory level wherever the segment is joined onto a path and producing
// an invalid git refname.
func TestValidateRootRejectsDotStripEscape(t *testing.T) {
	repoRoot := t.TempDir()

	for _, value := range []string{"...", "  ...  "} {
		got, err := ResolveRootDir(repoRoot, value)
		if err == nil {
			t.Errorf("ResolveRootDir(--root %q) = %q, want error", value, got)
		}
		if got, err := ValidateRoot(value); err == nil {
			t.Errorf("ValidateRoot(%q) = %q, want error", value, got)
		}
	}
}

func TestRootSegmentStripsOneLeadingDot(t *testing.T) {
	cases := map[string]string{
		".omc":  "omc",
		".omx":  "omx",
		".adlc": "adlc",
		"omc":   "omc",
	}
	for in, want := range cases {
		got, err := RootSegment(in)
		if err != nil {
			t.Fatalf("RootSegment(%q): unexpected error: %v", in, err)
		}
		if got != want {
			t.Errorf("RootSegment(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRootSegmentRejectsUnsafeStrippedResult(t *testing.T) {
	for _, value := range []string{"...", "..", ".", "", ".a/b"} {
		got, err := RootSegment(value)
		if err == nil {
			t.Errorf("RootSegment(%q) = %q, want error", value, got)
		}
		if got != "" {
			t.Errorf("RootSegment(%q) returned %q alongside its error", value, got)
		}
	}
}
