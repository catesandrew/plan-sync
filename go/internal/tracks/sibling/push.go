package sibling

import (
	"fmt"
	"os"
	"path/filepath"

	"plan-sync/go/internal/manifest"
	"plan-sync/go/internal/safewrite"
)

// Push is the Go port of src/tracks/sibling/push.ts's run():
// `plan-sync push --track sibling [--root <dir>]`.
//
// Copies every manifest-listed file (plus the manifest itself) into the
// sibling clone, stages ONLY those paths, commits when something actually
// changed, and pushes. A manifest-listed file that no longer exists locally
// has its clone-side copy removed instead, so the subsequent `git add`
// stages the deletion through ordinary git semantics — that is the whole of
// this track's deletion propagation.
func Push(argv []string) error {
	repoRoot, rootDir, err := resolveContext(argv)
	if err != nil {
		return err
	}

	cfg, err := readSiblingConfig("push", repoRoot, rootDir)
	if err != nil {
		return err
	}
	clonePath := cfg.ClonePath

	// Resolved (live pattern re-evaluation against the current filesystem,
	// plus every literal entry even when currently absent — see
	// ResolveManifestSyncCandidates's doc comment), not the raw manifest
	// lines: this is "what should be staged/considered-for-deletion right
	// now".
	manifestSrc := manifestPathFor(repoRoot, rootDir)
	manifestPaths := manifest.ResolveManifestSyncCandidates(manifestSrc)

	copyManifestFiles(repoRoot, rootDir, clonePath, manifestPaths)

	// Unconditionally copy the manifest's own current content into the
	// clone too, so it gets committed/pushed — a second machine's `pull`
	// then recovers the scope list, not just file content.
	if fileExists(manifestSrc) {
		if isSymlink(manifestSrc) {
			fmt.Fprintf(os.Stderr,
				"plan-sync: skipping symlink %s — symlinks are not synced\n",
				manifest.ManifestFilename)
		} else {
			safewrite.SafeCopyFile(clonePath, manifestSrc,
				filepath.Join(clonePath, manifest.ManifestFilename))
		}
	}

	stageable := stageableManifestPaths(clonePath,
		append(append([]string{}, manifestPaths...), manifest.ManifestFilename))
	if len(stageable) > 0 {
		if _, err := git(clonePath, append([]string{"add", "--"}, stageable...)...); err != nil {
			return err
		}
	}

	if hasStagedChanges(clonePath) {
		message := fmt.Sprintf("plan-sync: sync %d file(s)", len(manifestPaths))
		if _, err := gitWithEnv(clonePath, commitEnv(clonePath), "commit", "-m", message); err != nil {
			return err
		}
	}

	_, err = git(clonePath, "push", "-u", "origin", "HEAD")
	return err
}

// copyManifestFiles copies each manifest-listed path from the anchor repo's
// sync root into the clone. Both branches (copy-in and delete-propagation)
// go through internal/safewrite, so a symlinked destination — or a
// symlinked ANCESTOR of one, at any depth — is refused with a warning
// rather than written or deleted through
// (docs/HARDENING-HISTORY.md findings 6-8, 11).
func copyManifestFiles(repoRoot, rootDir, clonePath string, manifestPaths []string) {
	for _, relPath := range manifestPaths {
		src := filepath.Join(repoRoot, rootDir, relPath)
		dest := filepath.Join(clonePath, relPath)

		if !fileExists(src) {
			// Source was removed from the sync root (deletion propagation)
			// — remove the clone's copy too, if present, so the `git add`
			// below stages the deletion.
			safewrite.SafeRemove(clonePath, dest)
			continue
		}

		if isSymlink(src) {
			fmt.Fprintf(os.Stderr,
				"plan-sync: skipping symlink %s — symlinks are not synced\n", relPath)
			continue
		}

		safewrite.SafeCopyFile(clonePath, src, dest)
	}
}

// stageableManifestPaths filters manifest paths down to the ones actually
// worth passing to `git add`: paths that currently exist in the clone
// (new/modified content) or that are already tracked by git (so a
// since-removed file's deletion gets staged). Excludes paths that are
// neither present nor tracked — e.g. a manifest entry whose deletion was
// already synced and committed on a prior push — since `git add` errors on
// a pathspec that matches nothing.
func stageableManifestPaths(clonePath string, manifestPaths []string) []string {
	stageable := make([]string, 0, len(manifestPaths))
	for _, relPath := range manifestPaths {
		if fileExists(filepath.Join(clonePath, relPath)) {
			stageable = append(stageable, relPath)
			continue
		}
		if _, err := git(clonePath, "ls-files", "--error-unmatch", "--", relPath); err == nil {
			stageable = append(stageable, relPath)
		}
	}
	return stageable
}

// configuredGitValue reports whether git config resolves key to a non-empty
// value in cwd (covering the clone's local config and the machine's global
// one alike).
func configuredGitValue(cwd, key string) bool {
	out, err := gitOutput(cwd, "config", key)
	return err == nil && out != ""
}

// commitEnv falls back to a tool-authored git identity for the commit step
// when neither the clone's local nor the machine's global git config has
// one set (so `git commit` doesn't fail in bare environments such as CI).
// Any existing configured identity is respected untouched.
func commitEnv(cwd string) []string {
	env := os.Environ()
	if configuredGitValue(cwd, "user.name") && configuredGitValue(cwd, "user.email") {
		return env
	}

	fallbacks := map[string]string{
		"GIT_AUTHOR_NAME":     "plan-sync",
		"GIT_AUTHOR_EMAIL":    "plan-sync@localhost",
		"GIT_COMMITTER_NAME":  "plan-sync",
		"GIT_COMMITTER_EMAIL": "plan-sync@localhost",
	}
	for name, fallback := range fallbacks {
		if os.Getenv(name) == "" {
			env = append(env, name+"="+fallback)
		}
	}
	return env
}

// hasStagedChanges reports whether the clone's index differs from HEAD.
// `git diff --cached --quiet` exits non-zero exactly when it does.
func hasStagedChanges(cwd string) bool {
	_, err := git(cwd, "diff", "--cached", "--quiet")
	return err != nil
}
