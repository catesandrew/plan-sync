package commands

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"plan-sync/go/internal/manifest"
)

// The command-layer tests drive the real commands against real git
// repositories under t.TempDir(), the same way the sibling-track tests do —
// the point of this layer is flag/track routing, and routing is only
// meaningfully tested against the implementation it routes into.

// commandFixture is one anchor repo plus a bare "remote" and the path the
// sibling clone will be created at.
type commandFixture struct {
	tmpRoot string
	anchor  string
	remote  string
	clone   string
}

func newCommandFixture(t *testing.T) *commandFixture {
	t.Helper()

	tmpRoot, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolving temp dir: %v", err)
	}

	f := &commandFixture{
		tmpRoot: tmpRoot,
		anchor:  filepath.Join(tmpRoot, "anchor"),
		remote:  filepath.Join(tmpRoot, "remote.git"),
		clone:   filepath.Join(tmpRoot, "sibling-clone"),
	}

	if err := os.MkdirAll(f.anchor, 0o755); err != nil {
		t.Fatalf("creating anchor repo dir: %v", err)
	}
	runGit(t, f.anchor, "init", "--quiet")
	runGit(t, tmpRoot, "init", "--quiet", "--bare", f.remote)
	t.Chdir(f.anchor)

	return f
}

func (f *commandFixture) initSibling(t *testing.T) {
	t.Helper()
	if err := Init([]string{"--track", "sibling", "--remote", f.remote, "--clone-path", f.clone}); err != nil {
		t.Fatalf("Init --track sibling: %v", err)
	}
}

func (f *commandFixture) omc(parts ...string) string {
	return filepath.Join(append([]string{f.anchor, ".omc"}, parts...)...)
}

func (f *commandFixture) manifestPath() string {
	return f.omc(manifest.ManifestFilename)
}

func runGit(t *testing.T, cwd string, argv ...string) string {
	t.Helper()
	cmd := exec.Command("git", argv...)
	cmd.Dir = cwd
	var out, errOut bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	if err := cmd.Run(); err != nil {
		t.Fatalf("git %s in %s: %v\n%s", strings.Join(argv, " "), cwd, err, errOut.String())
	}
	return out.String()
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("creating parent of %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(data)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// capture runs fn with os.Stdout/os.Stderr redirected to temp files and
// returns what each received — including output written by the track
// implementation this layer dispatches into, and by internal/safewrite.
func capture(t *testing.T, fn func()) (capturedStdout, capturedStderr string) {
	t.Helper()

	dir := t.TempDir()
	outFile, err := os.Create(filepath.Join(dir, "stdout"))
	if err != nil {
		t.Fatalf("creating stdout capture: %v", err)
	}
	errFile, err := os.Create(filepath.Join(dir, "stderr"))
	if err != nil {
		t.Fatalf("creating stderr capture: %v", err)
	}

	origOut, origErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = outFile, errFile

	func() {
		defer func() { os.Stdout, os.Stderr = origOut, origErr }()
		fn()
	}()

	outFile.Close()
	errFile.Close()

	return readFile(t, filepath.Join(dir, "stdout")), readFile(t, filepath.Join(dir, "stderr"))
}

// manifestEntries reads the fixture's manifest, sorted.
func manifestEntries(t *testing.T, f *commandFixture) []string {
	t.Helper()
	entries := manifest.ReadManifest(f.manifestPath())
	for i := 1; i < len(entries); i++ {
		for j := i; j > 0 && entries[j] < entries[j-1]; j-- {
			entries[j], entries[j-1] = entries[j-1], entries[j]
		}
	}
	return entries
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// stubShadow replaces every shadow-track seam for the duration of one test,
// recording which one was reached and with what arguments.
func stubShadow(t *testing.T) *shadowCalls {
	t.Helper()

	calls := &shadowCalls{}
	origInit, origPush, origPull, origStatus := ShadowInit, ShadowPush, ShadowPull, ShadowStatus
	t.Cleanup(func() {
		ShadowInit, ShadowPush, ShadowPull, ShadowStatus = origInit, origPush, origPull, origStatus
	})

	ShadowInit = func(argv []string) error { calls.init = append(calls.init, argv); return nil }
	ShadowPush = func(argv []string) error { calls.push = append(calls.push, argv); return nil }
	ShadowPull = func(argv []string) error { calls.pull = append(calls.pull, argv); return nil }
	ShadowStatus = func(argv []string) error { calls.status = append(calls.status, argv); return nil }

	return calls
}

type shadowCalls struct {
	init   [][]string
	push   [][]string
	pull   [][]string
	status [][]string
}
