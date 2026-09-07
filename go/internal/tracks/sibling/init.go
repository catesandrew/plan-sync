package sibling

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"plan-sync/go/internal/args"
	"plan-sync/go/internal/safewrite"
	"plan-sync/go/internal/syncconfig"
)

// Init is the Go port of src/tracks/sibling/init.ts's run():
// `plan-sync init --track sibling --remote <url> --clone-path <path>
// [--root <dir>]`.
//
// Three effects, in order: the sync root is excluded from the anchor repo
// via `.git/info/exclude` (NOT `.gitignore` — the anchor repo's tracked
// files are the user's, and this tool never edits them), the sibling clone
// is created (or an existing one reused, idempotently), and the resolved
// settings plus the default track are persisted so later push/pull/status
// need no flags.
func Init(argv []string) error {
	remote, rest1 := args.ParseFlag(argv, "remote")
	clonePath, _ := args.ParseFlag(rest1, "clone-path")

	if remote == "" {
		return fmt.Errorf("init --track sibling: --remote <url> is required")
	}
	if clonePath == "" {
		return fmt.Errorf("init --track sibling: --clone-path <path> is required")
	}

	// resolveContext re-parses `--root` out of the original argv itself,
	// which is why the already-stripped `rest` is not threaded through here.
	repoRoot, rootDir, err := resolveContext(argv)
	if err != nil {
		return err
	}

	if err := ensureRootExcluded(repoRoot, rootDir); err != nil {
		return err
	}
	if err := ensureClone(remote, clonePath); err != nil {
		return err
	}

	absClonePath, err := filepath.Abs(clonePath)
	if err != nil {
		return err
	}
	if err := syncconfig.WriteSyncConfig(repoRoot, syncconfig.SyncConfigUpdate{
		Sibling: &syncconfig.SiblingSyncConfig{
			ClonePath: absClonePath,
			Remote:    remote,
		},
	}, rootDir); err != nil {
		return err
	}

	return syncconfig.WriteDefaultTrack(repoRoot, args.TrackSibling, rootDir)
}

// resolveGitExcludePath resolves the anchor repo's `info/exclude` path via
// `git rev-parse --git-path info/exclude` rather than hardcoding
// filepath.Join(repoRoot, ".git", "info", "exclude"), so this works when
// `.git` is a FILE rather than a directory — e.g. inside a linked git
// worktree, where the shared main repo's info/exclude is the correct
// target and the hardcoded path does not exist at all. The result may come
// back relative to repoRoot or already absolute depending on git
// version/context, so it is resolved against repoRoot when not absolute.
func resolveGitExcludePath(repoRoot string) (string, error) {
	out, err := gitOutput(repoRoot, "-C", repoRoot, "rev-parse", "--git-path", "info/exclude")
	if err != nil {
		return "", err
	}
	if filepath.IsAbs(out) {
		return out, nil
	}
	return filepath.Join(repoRoot, out), nil
}

// ensureRootExcluded appends "<rootDir>/" to the anchor repo's
// info/exclude, unless an identical line is already present (idempotent).
//
// Divergence from the TypeScript original, deliberate: the TS version uses
// a raw fs.appendFileSync here. This port instead read-modify-WRITEs the
// whole file through safewrite.SafeWriteFile, containment-rooted at
// info/exclude's own directory. Two reasons: (1) it keeps this package's
// "no raw filesystem mutation outside internal/safewrite" invariant total
// rather than "total except one append" — precisely the shape of gap
// docs/HARDENING-HISTORY.md finding 11 (and follow-up F2, which explicitly
// notes appendFileSync escaping the structural test's pattern list)
// describes; (2) it means a symlink sitting at info/exclude fails CLOSED
// (init errors, having written nothing) rather than being appended
// through. The resulting bytes are identical to the append in every
// non-symlink case.
func ensureRootExcluded(repoRoot, rootDir string) error {
	excludeEntry := rootDir + "/"

	excludePath, err := resolveGitExcludePath(repoRoot)
	if err != nil {
		return err
	}

	existing := ""
	if data, err := os.ReadFile(excludePath); err == nil {
		existing = string(data)
	}

	for _, line := range strings.Split(existing, "\n") {
		if strings.TrimSpace(line) == excludeEntry {
			return nil
		}
	}

	// Byte-parity with src/tracks/sibling/init.ts:58-62: a leading newline
	// is prepended only when the existing content is non-empty AND does not
	// already end in "\n" (i.e. we would otherwise append onto a dangling
	// last line).
	prefix := ""
	if len(existing) > 0 && !strings.HasSuffix(existing, "\n") {
		prefix = "\n"
	}

	updated := existing + prefix + excludeEntry + "\n"
	if !safewrite.SafeWriteFile(filepath.Dir(excludePath), excludePath, []byte(updated)) {
		return fmt.Errorf(
			"init --track sibling: refused to update %s (unsafe destination) — %s/ was not excluded",
			excludePath, rootDir)
	}
	return nil
}

// ensureClone clones remote into clonePath, or leaves an existing clone
// exactly as-is (idempotent re-init). An existing path that is not a git
// repository is an error rather than something to clone over.
func ensureClone(remote, clonePath string) error {
	if _, err := os.Lstat(clonePath); err == nil {
		if _, err := os.Stat(filepath.Join(clonePath, ".git")); err != nil {
			return fmt.Errorf(
				"init --track sibling: clone-path already exists but is not a git repository: %s",
				clonePath)
		}
		// Already a clone — idempotent init, leave it as-is.
		return nil
	}

	absClonePath, err := filepath.Abs(clonePath)
	if err != nil {
		return err
	}
	// Directory creation only — never a file write; see this package's
	// doc comment on the destination-mutation policy.
	if err := os.MkdirAll(filepath.Dir(absClonePath), 0o755); err != nil {
		return err
	}

	_, err = git("", "clone", remote, clonePath)
	return err
}
