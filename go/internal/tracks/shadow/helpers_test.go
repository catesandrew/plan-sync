package shadow

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"plan-sync/go/internal/shadowpaths"
)

// fixture is a hermetic anchor-repo + origin-remote + state-dir sandbox,
// mirroring the beforeEach in test/tracks/shadow/init.test.ts and
// restore.test.ts: a real (non-bare) anchor git repo with one commit and an
// `origin` pointing at a real bare remote, PLAN_SYNC_STATE_DIR pointed at a
// scratch dir, and the process cwd inside the anchor repo (which is how
// reporoot.ResolveRepoRoot finds it).
type fixture struct {
	t            *testing.T
	tmpDir       string
	anchorRepo   string
	originRemote string
	stateDir     string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()

	// EvalSymlinks matters on macOS, where t.TempDir() hands back a
	// /var/folders/... path whose real location is /private/var/folders/...
	// `git rev-parse --show-toplevel` (and therefore repoRoot) always
	// reports the resolved form, so without this every path comparison in
	// these tests would compare two spellings of the same directory.
	tmpDir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolving temp dir: %v", err)
	}

	f := &fixture{
		t:            t,
		tmpDir:       tmpDir,
		anchorRepo:   filepath.Join(tmpDir, "anchor-repo"),
		originRemote: filepath.Join(tmpDir, "origin-remote.git"),
		stateDir:     filepath.Join(tmpDir, "state-dir"),
	}

	// Hermetic git: no user/system config bleeding into the fixture, and no
	// credential prompt can ever hang a test against an unreachable remote.
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(tmpDir, "no-such-gitconfig"))
	t.Setenv("GIT_CONFIG_SYSTEM", filepath.Join(tmpDir, "no-such-gitconfig"))
	t.Setenv("GIT_TERMINAL_PROMPT", "0")
	t.Setenv("PLAN_SYNC_STATE_DIR", f.stateDir)

	if err := os.MkdirAll(f.anchorRepo, 0o755); err != nil {
		t.Fatalf("creating anchor repo dir: %v", err)
	}
	f.git(tmpDir, "init", "--bare", f.originRemote)
	f.git(f.anchorRepo, "init")
	f.git(f.anchorRepo, "config", "user.name", "Test User")
	f.git(f.anchorRepo, "config", "user.email", "test@example.com")
	f.git(f.anchorRepo, "remote", "add", "origin", f.originRemote)
	f.writeFile(filepath.Join(f.anchorRepo, "README.md"), []byte("hello\n"))
	f.git(f.anchorRepo, "add", "README.md")
	f.git(f.anchorRepo, "commit", "-m", "initial commit")

	t.Chdir(f.anchorRepo)
	return f
}

// git runs a git command in cwd and fails the test if it errors.
func (f *fixture) git(cwd string, argv ...string) string {
	f.t.Helper()
	cmd := exec.Command("git", argv...)
	cmd.Dir = cwd
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		f.t.Fatalf("git %s: %v\n%s", strings.Join(argv, " "), err, stderr.String())
	}
	return strings.TrimSpace(stdout.String())
}

// shadowRepoPath resolves where the current PLAN_SYNC_STATE_DIR puts the
// bare shadow repo for this fixture's anchor repo and root dir.
func (f *fixture) shadowRepoPath(rootDir string) string {
	f.t.Helper()
	projectID, err := shadowpaths.ResolveProjectId(f.anchorRepo)
	if err != nil {
		f.t.Fatalf("resolving project id: %v", err)
	}
	p, err := shadowpaths.ResolveShadowRepoPath(projectID, rootDir)
	if err != nil {
		f.t.Fatalf("resolving shadow repo path: %v", err)
	}
	return p
}

// refName resolves the shadow ref this fixture's anchor repo syncs to.
func (f *fixture) refName(rootDir string) string {
	f.t.Helper()
	projectID, err := shadowpaths.ResolveProjectId(f.anchorRepo)
	if err != nil {
		f.t.Fatalf("resolving project id: %v", err)
	}
	name, err := shadowpaths.ResolveShadowRefName(projectID, rootDir)
	if err != nil {
		f.t.Fatalf("resolving shadow ref name: %v", err)
	}
	return name
}

// omcPath is `<anchorRepo>/.omc/<relPath...>`.
func (f *fixture) omcPath(relPath ...string) string {
	return filepath.Join(append([]string{f.anchorRepo, ".omc"}, relPath...)...)
}

func (f *fixture) writeFile(path string, content []byte) {
	f.t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		f.t.Fatalf("mkdir for %s: %v", path, err)
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		f.t.Fatalf("writing %s: %v", path, err)
	}
}

// writeOmcFile writes a file under the anchor repo's `.omc/`.
func (f *fixture) writeOmcFile(relPath, content string) {
	f.t.Helper()
	f.writeFile(f.omcPath(relPath), []byte(content))
}

// writeManifest writes the local `.omc/.sync-manifest` with one entry per
// line, matching the TS tests' writeManifest helper.
func (f *fixture) writeManifest(entries ...string) {
	f.t.Helper()
	f.writeFile(f.omcPath(".sync-manifest"), []byte(strings.Join(entries, "\n")+"\n"))
}

// commitFixtureTree builds a commit whose tree is EXACTLY `files` (a full
// snapshot, not a delta), parented on the current tip of refName when there
// is one, and moves refName to it. Returns the new commit sha.
//
// This exists because `push` — the command that would normally produce a
// real ref — is Phase 2 and unavailable here, so the shadow ref's tree AND
// its history (which restore's deletion scoping reads via `git log`) are
// constructed directly with git plumbing instead.
func (f *fixture) commitFixtureTree(shadowRepoPath, refName string, files map[string]string) string {
	f.t.Helper()
	gitDir := "--git-dir=" + shadowRepoPath
	// A fresh, throwaway index per commit, so the resulting tree is exactly
	// the requested file set rather than an accumulation of prior ones.
	indexFile := filepath.Join(f.t.TempDir(), "fixture-index")

	for relPath, content := range files {
		blob := f.gitStdin(shadowRepoPath, content, gitDir, "hash-object", "-w", "--stdin")
		f.gitEnv(shadowRepoPath, []string{"GIT_INDEX_FILE=" + indexFile},
			gitDir, "update-index", "--add", "--cacheinfo", "100644,"+blob+","+relPath)
	}
	tree := f.gitEnv(shadowRepoPath, []string{"GIT_INDEX_FILE=" + indexFile}, gitDir, "write-tree")

	commitArgs := []string{gitDir, "commit-tree", tree, "-m", "fixture commit"}
	if parent := f.tryGitOut(shadowRepoPath, gitDir, "rev-parse", "--verify", "--quiet", refName); parent != "" {
		commitArgs = []string{gitDir, "commit-tree", tree, "-p", parent, "-m", "fixture commit"}
	}
	commit := f.gitEnv(shadowRepoPath, []string{
		"GIT_AUTHOR_NAME=Test User",
		"GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test User",
		"GIT_COMMITTER_EMAIL=test@example.com",
	}, commitArgs...)

	f.git(shadowRepoPath, gitDir, "update-ref", refName, commit)
	return commit
}

// gitEnv runs git with extra environment entries appended to the inherited
// environment, failing the test on error.
func (f *fixture) gitEnv(cwd string, extraEnv []string, argv ...string) string {
	f.t.Helper()
	cmd := exec.Command("git", argv...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), extraEnv...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		f.t.Fatalf("git %s: %v\n%s", strings.Join(argv, " "), err, stderr.String())
	}
	return strings.TrimSpace(stdout.String())
}

// gitStdin runs git with `stdin` piped in, failing the test on error.
func (f *fixture) gitStdin(cwd, stdin string, argv ...string) string {
	f.t.Helper()
	cmd := exec.Command("git", argv...)
	cmd.Dir = cwd
	cmd.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		f.t.Fatalf("git %s: %v\n%s", strings.Join(argv, " "), err, stderr.String())
	}
	return strings.TrimSpace(stdout.String())
}

// tryGitOut runs git and returns "" instead of failing when it exits
// non-zero (used for "does this ref exist yet?" probes).
func (f *fixture) tryGitOut(cwd string, argv ...string) string {
	f.t.Helper()
	cmd := exec.Command("git", argv...)
	cmd.Dir = cwd
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if err := cmd.Run(); err != nil {
		return ""
	}
	return strings.TrimSpace(stdout.String())
}

// switchToFreshMachine simulates restoring on a machine that has never
// pushed: it repoints PLAN_SYNC_STATE_DIR at a brand-new state dir and
// re-runs Init against the SAME origin, so the local shadow repo is a
// clone-equivalent with no local ref — forcing Restore down its
// tryFetchRef path.
func (f *fixture) switchToFreshMachine(name string) {
	f.t.Helper()
	f.t.Setenv("PLAN_SYNC_STATE_DIR", filepath.Join(f.tmpDir, "state-dir-fresh-"+name))
	if err := Init(nil); err != nil {
		f.t.Fatalf("re-init on fresh machine: %v", err)
	}
}

// pushRefToOrigin publishes refName from the local shadow repo to the
// fixture's origin remote, so a fresh-machine Restore can fetch it back.
func (f *fixture) pushRefToOrigin(shadowRepoPath, refName string) {
	f.t.Helper()
	f.git(shadowRepoPath, "--git-dir="+shadowRepoPath, "push", "origin", "+"+refName+":"+refName)
}

// --- assertions ---

func assertFileContent(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	if string(got) != want {
		t.Fatalf("%s: got %q, want %q", path, got, want)
	}
}

func assertExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("expected %s to exist, got: %v", path, err)
	}
}

func assertNotExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); err == nil {
		t.Fatalf("expected %s not to exist, but it does", path)
	}
}

func assertIsSymlink(t *testing.T, path string) {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("lstat %s: %v", path, err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("expected %s to still be a symlink, got mode %v", path, info.Mode())
	}
}
