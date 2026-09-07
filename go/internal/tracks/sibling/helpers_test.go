package sibling

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"plan-sync/go/internal/manifest"
)

// These tests use REAL git repositories under t.TempDir() — a throwaway
// local bare repo standing in for the remote, plus one or two anchor repos
// and their clones — rather than mocking git or the filesystem. Every
// scenario here is a port of the corresponding TypeScript case in
// test/tracks-sibling*.test.ts.

// realTempDir returns a t.TempDir() with every symlink resolved. On macOS
// the per-test temp directory lives under /var/folders/... where /var is a
// symlink to /private/var, while `git rev-parse --show-toplevel` reports
// the physical path — resolving up front keeps fixture-built paths and
// tool-resolved paths string-comparable.
func realTempDir(t *testing.T) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolving temp dir: %v", err)
	}
	return resolved
}

// runGit runs git in cwd and fails the test if it errors.
func runGit(t *testing.T, cwd string, argv ...string) string {
	t.Helper()
	out, err := runGitEnv(t, cwd, nil, argv...)
	if err != nil {
		t.Fatalf("git %s in %s: %v", strings.Join(argv, " "), cwd, err)
	}
	return out
}

// runGitEnv runs git in cwd with extra environment entries.
func runGitEnv(t *testing.T, cwd string, extraEnv []string, argv ...string) (string, error) {
	t.Helper()
	cmd := exec.Command("git", argv...)
	cmd.Dir = cwd
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
	var out, errOut bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	if err := cmd.Run(); err != nil {
		return out.String(), &gitError{argv: argv, stderr: errOut.String(), err: err}
	}
	return out.String(), nil
}

type gitError struct {
	argv   []string
	stderr string
	err    error
}

func (e *gitError) Error() string {
	return "git " + strings.Join(e.argv, " ") + ": " + e.err.Error() + "\n" + e.stderr
}

// testCommitEnv is a deterministic identity for commits the FIXTURE makes
// directly (the tool's own commits get their identity from commitEnv).
var testCommitEnv = []string{
	"GIT_AUTHOR_NAME=plan-sync-test",
	"GIT_AUTHOR_EMAIL=plan-sync-test@localhost",
	"GIT_COMMITTER_NAME=plan-sync-test",
	"GIT_COMMITTER_EMAIL=plan-sync-test@localhost",
}

// newAnchorRepo creates an initialized, empty git repo at dir.
func newAnchorRepo(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("creating anchor repo dir: %v", err)
	}
	runGit(t, dir, "init", "--quiet")
}

// newBareRemote creates an empty bare repo at dir, standing in for a
// hosted remote.
func newBareRemote(t *testing.T, dir string) {
	t.Helper()
	runGit(t, filepath.Dir(dir), "init", "--quiet", "--bare", dir)
}

// writeFile writes content at path, creating parent directories.
func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("creating parent of %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

// readFile reads path, failing the test if it can't be read.
func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(data)
}

// exists reports whether path exists, following symlinks (mirroring the
// assertions the TypeScript tests make with fs.existsSync).
func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// allow adds entry to the anchor repo's manifest, the way `plan-sync
// allow` would.
func allow(t *testing.T, anchorDir, entry string) {
	t.Helper()
	path := filepath.Join(anchorDir, ".omc", manifest.ManifestFilename)
	if err := manifest.AddToManifest(path, entry); err != nil {
		t.Fatalf("allow %q: %v", entry, err)
	}
}

// symlink creates a symlink at linkPath pointing at target.
func symlink(t *testing.T, target, linkPath string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(linkPath), 0o755); err != nil {
		t.Fatalf("creating parent of %s: %v", linkPath, err)
	}
	if err := os.Symlink(target, linkPath); err != nil {
		t.Fatalf("symlinking %s -> %s: %v", linkPath, target, err)
	}
}

// isSymlinkPath reports whether path is itself a symlink.
func isSymlinkPath(t *testing.T, path string) bool {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("lstat %s: %v", path, err)
	}
	return info.Mode()&os.ModeSymlink != 0
}

// capture runs fn with os.Stdout/os.Stderr redirected to temp files and
// returns what each received. Redirecting the process-level streams (rather
// than a package-local sink) is what makes the adversarial assertions
// possible: the refusal warnings they check for are emitted by
// internal/safewrite, which writes to os.Stderr directly. Temp files rather
// than pipes, so a large capture cannot deadlock on a full buffer.
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

// trackedFiles lists the paths committed at HEAD in the given repo, sorted.
func trackedFiles(t *testing.T, repo string, gitDirArgs ...string) []string {
	t.Helper()
	argv := append(append([]string{}, gitDirArgs...), "ls-tree", "-r", "--name-only", "HEAD")
	out := strings.TrimSpace(runGit(t, repo, argv...))
	if out == "" {
		return nil
	}
	files := strings.Split(out, "\n")
	sortStrings(files)
	return files
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
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
