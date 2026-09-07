// Package sibling is the Go port of src/tracks/sibling/{init,push,pull,
// status}.ts — the "sibling repo" sync track, in which the manifest-listed
// files under the anchor repo's root directory (`.omc/` by default) are
// mirrored into an ordinary git clone of a separate, user-owned repository
// and pushed/pulled with ordinary git semantics.
//
// The design point carried over verbatim from the TypeScript original is
// that there is no bespoke reconciliation engine here: "does the
// manifest-listed path exist on the other side or not" is the entire
// deletion-propagation mechanism, and a genuine concurrent edit surfaces as
// a real `git pull --rebase` conflict (markers and all) rather than being
// silently resolved by this tool.
//
// # Destination-mutation policy
//
// Every mutation of a destination path derived from the manifest — copy-in,
// copy-out, and both directions' deletion propagation — goes through
// internal/safewrite (SafeCopyFile / SafeRemove / SafeWriteFile). This
// package deliberately contains ZERO raw os.WriteFile / os.Remove /
// os.Rename / os.Create / os.OpenFile calls; see docs/HARDENING-HISTORY.md
// finding 11, where exactly this class of "guard exists but three call
// sites forgot to call it" gap was found twice in the TypeScript original.
// os.MkdirAll appears only for creating a *containing directory* (never a
// file), matching what safewrite itself does internally.
package sibling

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"plan-sync/go/internal/args"
	"plan-sync/go/internal/manifest"
	"plan-sync/go/internal/reporoot"
	"plan-sync/go/internal/root"
	"plan-sync/go/internal/syncconfig"
)

// manifestPathFor is the Go equivalent of src/manifest.ts's
// defaultManifestPath(repoRoot, rootDir). It lives here rather than in
// internal/manifest because that package (already landed and verified)
// exposes only manifest-file operations keyed by an explicit path.
func manifestPathFor(repoRoot, rootDir string) string {
	return filepath.Join(repoRoot, rootDir, manifest.ManifestFilename)
}

// resolveContext resolves the anchor repo root and the root directory this
// invocation operates against, from the shared `--root <dir>` flag. Mirrors
// the identical three lines at the top of every sibling-track entry point.
func resolveContext(argv []string) (repoRoot, rootDir string, err error) {
	rootFlag, _ := args.ParseFlag(argv, "root")

	repoRoot, err = reporoot.ResolveRepoRoot()
	if err != nil {
		return "", "", err
	}
	rootDir, err = root.ResolveRootDir(repoRoot, rootFlag)
	if err != nil {
		return "", "", err
	}
	return repoRoot, rootDir, nil
}

// readSiblingConfig loads the persisted sibling-track settings, erroring
// with the same two command-prefixed messages the TypeScript original
// raises ("no sibling config found at ..." / "... has no \"sibling\"
// entry"), so the user is always told which command failed and that `init
// --track sibling` is the fix.
func readSiblingConfig(command, repoRoot, rootDir string) (syncconfig.SiblingSyncConfig, error) {
	configPath := syncconfig.SyncConfigPath(repoRoot, rootDir)

	if _, err := os.Stat(configPath); err != nil {
		return syncconfig.SiblingSyncConfig{}, fmt.Errorf(
			"%s --track sibling: no sibling config found at %s — run `plan-sync init --track sibling` first",
			command, configPath)
	}

	cfg, err := syncconfig.ReadSyncConfig(repoRoot, rootDir)
	if err != nil {
		return syncconfig.SiblingSyncConfig{}, err
	}

	sibling, ok := cfg.Sibling()
	if !ok {
		return syncconfig.SiblingSyncConfig{}, fmt.Errorf(
			"%s --track sibling: %s has no \"sibling\" entry — run `plan-sync init --track sibling` first",
			command, configPath)
	}

	return sibling, nil
}

// git runs a git subcommand in cwd (or the process's own directory when cwd
// is empty) and returns its stdout. Unlike Node's execFileSync — which
// throws an Error whose message already embeds the failing command — Go
// gives back a bare *ExitError, so the command line and git's own stderr
// are folded into the returned error here; several callers surface that
// text to the user (pull's conflict message in particular).
func git(cwd string, argv ...string) (string, error) {
	return gitWithEnv(cwd, nil, argv...)
}

// gitWithEnv is git with an explicit environment (nil inherits the
// process's own), used by the commit step's identity fallback.
func gitWithEnv(cwd string, env []string, argv ...string) (string, error) {
	cmd := exec.Command("git", argv...)
	cmd.Dir = cwd
	cmd.Env = env

	var out, errOut bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errOut

	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(errOut.String())
		if detail == "" {
			detail = strings.TrimSpace(out.String())
		}
		return out.String(), fmt.Errorf("git %s: %w\n%s",
			strings.Join(argv, " "), err, detail)
	}
	return out.String(), nil
}

// gitOutput is git(...) reduced to its trimmed stdout.
func gitOutput(cwd string, argv ...string) (string, error) {
	out, err := git(cwd, argv...)
	return strings.TrimSpace(out), err
}

// fileExists mirrors Node's fs.existsSync: it FOLLOWS symlinks, so a
// dangling symlink reports false. Several call sites depend on exactly that
// (see push's deletion branch and stageableManifestPaths), so os.Stat is
// used deliberately rather than os.Lstat.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// isSymlink reports whether path is itself a symbolic link, via os.Lstat
// (never os.Stat, which would follow it). See docs/HARDENING-HISTORY.md
// finding 4: a symlink under the sync root must never have its target's
// content synced.
func isSymlink(path string) bool {
	info, err := os.Lstat(path)
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeSymlink != 0
}
