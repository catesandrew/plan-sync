package shadow

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"plan-sync/go/internal/args"
	"plan-sync/go/internal/reporoot"
	"plan-sync/go/internal/root"
	"plan-sync/go/internal/safewrite"
	"plan-sync/go/internal/shadowpaths"
	"plan-sync/go/internal/syncconfig"
)

// Init is the Go port of src/tracks/shadow/init.ts's `run`:
// `plan-sync init --track shadow [--remote <url>] [--root <dir>]`.
//
// Bootstraps the shadow-ref track:
//
//  0. ensure `<rootDir>/` is excluded via the anchor repo's
//     `.git/info/exclude` (untracked, idempotent, shared bootstrap with the
//     sibling track)
//  1. create the bare shadow git repo (if missing) and pin
//     `core.autocrlf=false`, explicit `user.name`/`user.email`, and a
//     `-text` attributes rule at `<shadowRepoPath>/info/attributes`
//  2. wire an `origin` remote on the shadow repo, from `--remote` or the
//     anchor repo's own `origin`
//  3. persist `shadow` as the default track for this root
//
// It is idempotent: running it again against an already-initialized root
// re-applies the same config, does not duplicate the exclude entry, and
// does not re-create (or disturb) an existing shadow repo.
//
// Step 0 deliberately runs BEFORE anything writes into `<rootDir>/`
// (step 3's sync-config write is the first such write), so `git status` in
// the anchor repo stays clean throughout — matching the TypeScript
// ordering, which the init integration tests assert on.
func Init(argv []string) error {
	remoteFlag, rest1 := args.ParseFlag(argv, "remote")
	rootFlag, _ := args.ParseFlag(rest1, "root")

	repoRoot, err := reporoot.ResolveRepoRoot()
	if err != nil {
		return err
	}
	rootDir, err := root.ResolveRootDir(repoRoot, rootFlag)
	if err != nil {
		return err
	}

	if err := ensureExcludeEntry(repoRoot, rootDir); err != nil {
		return err
	}

	projectID, err := shadowpaths.ResolveProjectId(repoRoot)
	if err != nil {
		return err
	}
	shadowRepoPath, err := shadowpaths.ResolveShadowRepoPath(projectID, rootDir)
	if err != nil {
		return err
	}

	if err := ensureBareRepo(shadowRepoPath); err != nil {
		return err
	}
	if err := configureShadowRepo(shadowRepoPath, repoRoot); err != nil {
		return err
	}
	if err := wireOrigin(shadowRepoPath, repoRoot, remoteFlag); err != nil {
		return err
	}

	return syncconfig.WriteDefaultTrack(repoRoot, args.TrackShadow, rootDir)
}

// resolveGitExcludePath resolves the anchor repo's `info/exclude` path via
// `git rev-parse --git-path info/exclude` rather than hardcoding
// filepath.Join(repoRoot, ".git", "info", "exclude"), so this works
// correctly when `.git` is a FILE rather than a directory (e.g. a linked
// git worktree, where `git rev-parse --git-path` correctly resolves to the
// shared main repo's `info/exclude`). The result may come back relative to
// repoRoot or already absolute depending on git version/context, so it is
// resolved against repoRoot when not already absolute.
func resolveGitExcludePath(repoRoot string) (string, error) {
	out, err := runGit("-C", repoRoot, "rev-parse", "--git-path", "info/exclude")
	if err != nil {
		return "", fmt.Errorf(
			"init --track shadow: failed to resolve the anchor repo's info/exclude path: %w", err)
	}
	result := strings.TrimSpace(out)
	if filepath.IsAbs(result) {
		return result, nil
	}
	return filepath.Join(repoRoot, result), nil
}

// ensureExcludeEntry appends `<rootDir>/` to the anchor repo's
// `info/exclude`, exactly once. Already-present entries (including one
// added by a prior sibling-track init) are left alone, and an existing file
// that doesn't end in a newline gets one inserted first so the new entry
// never gets glued onto a dangling last line.
//
// Port note: the TypeScript original uses a raw fs.appendFileSync here.
// This port instead reads the file and rewrites it in full through
// safewrite.SafeWriteFile (containment root: the `info/` directory holding
// it) — byte-identical output, but it keeps this package's "no raw
// filesystem writes anywhere" property intact, and it means a symlink
// planted at `info/exclude` is refused rather than written through.
func ensureExcludeEntry(repoRoot, rootDir string) error {
	excludeLine := rootDir + "/"
	excludePath, err := resolveGitExcludePath(repoRoot)
	if err != nil {
		return err
	}

	existing, err := os.ReadFile(excludePath)
	if err != nil {
		if !os.IsNotExist(err) {
			return fmt.Errorf("init --track shadow: failed to read %s: %w", excludePath, err)
		}
		existing = nil
	}

	for _, line := range strings.Split(string(existing), "\n") {
		if line == excludeLine {
			return nil
		}
	}

	var next bytes.Buffer
	next.Write(existing)
	if len(existing) > 0 && !bytes.HasSuffix(existing, []byte("\n")) {
		next.WriteString("\n")
	}
	next.WriteString(excludeLine + "\n")

	if !safewrite.SafeWriteFile(filepath.Dir(excludePath), excludePath, next.Bytes()) {
		return fmt.Errorf(
			"init --track shadow: refused to write the exclude entry %q to %s",
			excludeLine, excludePath)
	}
	return nil
}

// ensureBareRepo creates the bare shadow repo if it isn't there yet. An
// existing path is left completely untouched (idempotence: re-running init
// must never re-initialize a repo that already holds pushed history).
func ensureBareRepo(shadowRepoPath string) error {
	if _, err := os.Lstat(shadowRepoPath); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(shadowRepoPath), 0o755); err != nil {
		return fmt.Errorf("init --track shadow: failed to create %s: %w",
			filepath.Dir(shadowRepoPath), err)
	}
	if _, err := runGit("init", "--bare", shadowRepoPath); err != nil {
		return fmt.Errorf("init --track shadow: failed to create the bare shadow repo at %s: %w",
			shadowRepoPath, err)
	}
	return nil
}

// configureShadowRepo pins the settings the shadow track's byte-for-byte
// round-trip guarantee depends on: no CRLF translation on either side of a
// blob, and a committer identity (a fresh bare repo has none of its own, so
// the first commit against it would otherwise fail).
func configureShadowRepo(shadowRepoPath, repoRoot string) error {
	gitDir := gitDirFlag(shadowRepoPath)

	if _, err := runGit(gitDir, "config", "core.autocrlf", "false"); err != nil {
		return fmt.Errorf("init --track shadow: failed to set core.autocrlf: %w", err)
	}

	name, email := resolveGitIdentity(repoRoot)
	if _, err := runGit(gitDir, "config", "user.name", name); err != nil {
		return fmt.Errorf("init --track shadow: failed to set user.name: %w", err)
	}
	if _, err := runGit(gitDir, "config", "user.email", email); err != nil {
		return fmt.Errorf("init --track shadow: failed to set user.email: %w", err)
	}

	// A bare repo has no working tree, so a `.gitattributes` there would
	// never be read. Git's standard location for repo-local attributes that
	// work without a working tree is `$GIT_DIR/info/attributes`.
	attributesPath := filepath.Join(shadowRepoPath, "info", "attributes")
	if !safewrite.SafeWriteFile(shadowRepoPath, attributesPath, []byte("* -text\n")) {
		return fmt.Errorf("init --track shadow: refused to write %s", attributesPath)
	}
	if _, err := runGit(gitDir, "config", "core.attributesFile", attributesPath); err != nil {
		return fmt.Errorf("init --track shadow: failed to set core.attributesFile: %w", err)
	}
	return nil
}

// resolveGitIdentity reads user.name/user.email from the anchor repo's own
// git config (local or global, whichever `git config` resolves) so the
// shadow repo's commits are attributable to the same person. Falls back to
// a placeholder identity when the anchor repo has neither configured.
func resolveGitIdentity(repoRoot string) (name, email string) {
	name = tryGit("-C", repoRoot, "config", "user.name")
	if name == "" {
		name = "plan-sync"
	}
	email = tryGit("-C", repoRoot, "config", "user.email")
	if email == "" {
		email = "plan-sync@localhost"
	}
	return name, email
}

// wireOrigin points the shadow repo's `origin` at the explicit --remote
// URL, or (absent that) at whatever the anchor repo's own `origin` is.
// Re-running init against a repo that already has an origin re-points it
// (set-url) rather than failing on a duplicate remote.
func wireOrigin(shadowRepoPath, repoRoot, remoteFlag string) error {
	url := remoteFlag
	if url == "" {
		url = tryGit("-C", repoRoot, "remote", "get-url", "origin")
	}
	if url == "" {
		return fmt.Errorf(
			"init --track shadow: no --remote given and the anchor repo has no 'origin' remote to infer one from")
	}

	gitDir := gitDirFlag(shadowRepoPath)
	subcommand := "add"
	if tryGit(gitDir, "remote", "get-url", "origin") != "" {
		subcommand = "set-url"
	}
	if _, err := runGit(gitDir, "remote", subcommand, "origin", url); err != nil {
		return fmt.Errorf("init --track shadow: failed to wire the shadow repo's origin remote: %w", err)
	}
	return nil
}
