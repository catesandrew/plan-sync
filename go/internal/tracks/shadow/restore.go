package shadow

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"plan-sync/go/internal/args"
	"plan-sync/go/internal/manifest"
	"plan-sync/go/internal/reporoot"
	"plan-sync/go/internal/root"
	"plan-sync/go/internal/safewrite"
	"plan-sync/go/internal/shadowpaths"
)

// Restore is the Go port of src/tracks/shadow/restore.ts's `run`, reached
// from the CLI as `plan-sync pull --track shadow [--ref <sha-or-ref>]
// [--root <dir>]` (src/commands/pull.ts dispatches the shadow track
// straight into this module; the standalone `restore` command was unified
// into `pull`).
//
// It materializes the tree at `refs/plan-sync/<project-id>/<root>/data`
// (or a `--ref` override) back onto disk at `<rootDir>/<path>` in the
// anchor repo.
//
// This is a true tree-sync, not an additive overlay:
//   - every path present in the target tree is (re)written from the blob's
//     exact bytes — unless the on-disk copy differs from the local ref's
//     pre-fetch tip (the merge base), i.e. it was edited locally and not
//     yet pushed: then local wins, and if the remote also changed, the two
//     are 3-way merged in place (`git merge-file`, see mergeFile; conflict
//     markers on overlap), falling back to `<path>.remote` for binary
//     content;
//   - every path currently listed in the manifest that is *not* present in
//     the target tree, but *was* present at some earlier commit reachable
//     from the target ref (i.e. it was genuinely synced once and is now
//     genuinely gone), is deleted, if present on disk and unchanged from
//     the merge base.
//
// Deletion is deliberately scoped to (ref history \ target tree), NEVER to
// (current manifest \ target tree): a path can be manifest-listed and
// absent from the target tree merely because it was never successfully
// synced yet (e.g. it has always matched `push`'s advisory secret-shape
// scan, so no commit in this ref's history ever contained it). Deleting the
// local file in that case would destroy content that was never backed up.
// Checking the ref's own history (via `git log -- <path>`, see
// everSyncedInHistory) is what distinguishes a genuine
// previously-synced-then-removed path from one that simply never made it
// into the shadow ref in the first place. Do not "simplify" this into a
// manifest-minus-tree set difference — that is the exact regression this
// scoping exists to prevent (docs/HARDENING-HISTORY.md, round 1 finding 1
// chained with round 3 findings 9 and 10).
//
// Scope is otherwise limited to the manifest ∪ the target tree — this never
// touches files under `<rootDir>/` that this tool has no knowledge of.
//
// Every write goes through safewrite.SafeWriteFile and every delete through
// safewrite.SafeRemove; there is no other way this function touches a
// destination path (mergeFile's raw writes are OS-tmpdir scratch only).
//
// Failure behavior (Phase-1 observability requirement): an unresolvable
// ref — a corrupt/missing local ref with an unreachable or absent origin —
// returns a non-nil error with a non-empty message BEFORE any destination
// is written or removed, so the process exits non-zero with a real
// diagnostic on stderr and every already-on-disk local file is left exactly
// as it was. The ref is fully enumerated (listTree) up front, ahead of the
// first mutation, precisely so a bad ref can never produce a partial write.
func Restore(argv []string) error {
	refFlag, rest1 := args.ParseFlag(argv, "ref")
	rootFlag, _ := args.ParseFlag(rest1, "root")

	repoRoot, err := reporoot.ResolveRepoRoot()
	if err != nil {
		return err
	}
	rootDir, err := root.ResolveRootDir(repoRoot, rootFlag)
	if err != nil {
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

	// os.Lstat, not os.Stat: a symlink planted at the shadow repo path
	// should be reported as present-but-whatever-it-is rather than silently
	// resolving through to somewhere else, and a dangling one must not read
	// as "not initialized" and trigger a confusing suggestion to re-init.
	if _, err := os.Lstat(shadowRepoPath); err != nil {
		return fmt.Errorf(
			"restore --track shadow: no shadow repo found at %s — run `plan-sync init --track shadow` first",
			shadowRepoPath)
	}

	gitDir := gitDirFlag(shadowRepoPath)
	derivedRefName, err := shadowpaths.ResolveShadowRefName(projectID, rootDir)
	if err != nil {
		return err
	}
	// The local ref tip BEFORE fetching is the last state this machine
	// synced (pushed or pulled) — the merge base for deciding whether an
	// on-disk file was edited locally since then. Always the derived ref,
	// even under --ref, so an explicit restore still can't clobber unpushed
	// local edits. "" on a fresh machine: then every differing local file
	// counts as locally modified.
	baseSha := tryGit(gitDir, "rev-parse", "--verify", "-q", derivedRefName)

	refName := refFlag
	if refName == "" {
		refName = derivedRefName
		// On a fresh machine (a shadow repo that was just init-ed but never
		// pushed from), the local ref doesn't exist yet — only `origin`
		// knows about it. Best-effort fetch it into the matching local ref
		// name before reading the tree; if this fails (offline, ref never
		// pushed, no origin), fall through to listTree, which surfaces a
		// clear error if the ref truly can't be resolved locally either.
		//
		// Only for the derived ref: an explicit --ref may well be a raw sha
		// or some other name that isn't a remote-tracking ref, matching the
		// TypeScript original's `if (!refFlag)` guard.
		tryFetchRef(gitDir, refName)
	}

	targetPaths, err := listTree(gitDir, refName)
	if err != nil {
		return err
	}
	targetSet := make(map[string]bool, len(targetPaths))
	for _, p := range targetPaths {
		targetSet[p] = true
	}

	omcRoot := filepath.Join(repoRoot, rootDir)

	for _, relPath := range targetPaths {
		if relPath == manifest.ManifestFilename {
			// The manifest itself is handled specially below via a
			// union-merge into the LOCAL manifest, never wholesale-
			// overwritten from the incoming tree like an ordinary file —
			// see mergeIncomingManifest.
			continue
		}
		content, err := readBlob(gitDir, refName, relPath)
		if err != nil {
			return fmt.Errorf("restore --track shadow: failed to read '%s' at ref '%s': %w",
				relPath, refName, err)
		}
		destPath := filepath.Join(omcRoot, relPath)
		local, isLocal := readLocalFile(destPath)
		if isLocal && bytes.Equal(local, content) {
			continue
		}
		if isLocal {
			base, hasBase := tryReadBlob(gitDir, baseSha, relPath)
			if !hasBase || !bytes.Equal(base, local) {
				// Edited locally since the last sync: keep it (the next push
				// uploads it). If the remote ALSO changed, 3-way merge (an
				// empty base when there's none, so differing sides become an
				// add/add conflict); if merge-file refuses (binary) or
				// errors, park the incoming copy beside the local one rather
				// than drop it.
				if !hasBase || !bytes.Equal(base, content) {
					merged, conflicts, ok := mergeFile(local, base, content)
					switch {
					case !ok:
						safewrite.SafeWriteFile(omcRoot, destPath+".remote", content)
						fmt.Fprintf(os.Stderr,
							"plan-sync: conflict on %s: kept local, remote copy at %s.remote\n", relPath, relPath)
					case conflicts == 0:
						safewrite.SafeWriteFile(omcRoot, destPath, merged)
						fmt.Fprintf(os.Stderr, "plan-sync: merged %s\n", relPath)
					default:
						safewrite.SafeWriteFile(omcRoot, destPath, merged)
						fmt.Fprintf(os.Stderr,
							"plan-sync: conflict in %s (%d hunk(s)); resolve markers, then push\n", relPath, conflicts)
					}
				}
				continue
			}
		}
		safewrite.SafeWriteFile(omcRoot, destPath, content)
	}

	localManifestPath := filepath.Join(omcRoot, manifest.ManifestFilename)
	for _, relPath := range manifest.ReadManifest(localManifestPath) {
		if targetSet[relPath] {
			continue
		}
		if !everSyncedInHistory(gitDir, refName, relPath) {
			// This path is absent from the target tree, but the shadow
			// ref's own history shows it was never actually synced (e.g. it
			// has always matched the advisory scan). Its absence carries no
			// deletion intent, so any local copy is left untouched.
			continue
		}
		destPath := filepath.Join(omcRoot, relPath)
		if local, isLocal := readLocalFile(destPath); isLocal {
			if base, hasBase := tryReadBlob(gitDir, baseSha, relPath); !hasBase || !bytes.Equal(base, local) {
				// Edited locally since the last sync (or never synced
				// here): the remote deletion must not destroy those edits.
				continue
			}
		}
		safewrite.SafeRemove(omcRoot, destPath)
	}

	if targetSet[manifest.ManifestFilename] {
		if err := mergeIncomingManifest(gitDir, refName, localManifestPath); err != nil {
			return err
		}
	}
	return nil
}

// mergeIncomingManifest parses the incoming manifest blob's raw lines (same
// skip-blank/skip-comment rules as manifest.ReadManifest) and UNION-merges
// each valid line into the local manifest via manifest.AddToManifest —
// additive only, so a pre-existing local-only entry the incoming manifest
// doesn't mention is never removed or overwritten. Reads via readBlob
// (git's own object store), so there is no filesystem symlink-escape
// surface to guard against here.
func mergeIncomingManifest(gitDir, refName, localManifestPath string) error {
	raw, err := readBlob(gitDir, refName, manifest.ManifestFilename)
	if err != nil {
		return fmt.Errorf("restore --track shadow: failed to read the incoming manifest at ref '%s': %w",
			refName, err)
	}

	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if err := manifest.AddToManifest(localManifestPath, line); err != nil {
			// A hand-edited or otherwise malformed incoming manifest could
			// contain an out-of-bounds entry (absolute path / `../`
			// traversal); AddToManifest fails closed on those. Skip just
			// that one line with a warning rather than aborting the whole
			// restore.
			fmt.Fprintf(os.Stderr,
				"plan-sync: skipping invalid incoming manifest entry '%s': %v\n", line, err)
		}
	}
	return nil
}

// everSyncedInHistory reports whether relPath was ever added/modified/
// removed in some commit reachable from refName — i.e. it was genuinely
// synced into the shadow ref's history at some point, regardless of whether
// it is present in the current tip's tree. This is what distinguishes a
// genuine (previously-synced, now-deleted) path, whose local copy restore
// should remove, from one that simply never made it into any commit, whose
// local copy restore must leave alone.
//
// Any failure (unresolvable ref, git error) reports false — "no evidence
// this was ever synced" — which fails toward NOT deleting. That direction
// is the safe one: the cost of a false negative is a stale local file, the
// cost of a false positive is destroyed, never-backed-up user content.
func everSyncedInHistory(gitDir, refName, relPath string) bool {
	out, err := runGit(gitDir, "log", "--format=%H", "-1", refName, "--", relPath)
	if err != nil {
		return false
	}
	return strings.TrimSpace(out) != ""
}

// readLocalFile reads the on-disk file's bytes only if it is a regular file
// (Lstat, so a symlink at the destination reads as "not a local file" and
// falls through to SafeWriteFile/SafeRemove's refusal path, exactly as
// before).
func readLocalFile(destPath string) ([]byte, bool) {
	info, err := os.Lstat(destPath)
	if err != nil || !info.Mode().IsRegular() {
		return nil, false
	}
	content, err := os.ReadFile(destPath)
	return content, err == nil
}

// tryReadBlob is readBlob at sha, reporting false when there is no base sha
// or the path doesn't exist at that commit.
func tryReadBlob(gitDir, sha, relPath string) ([]byte, bool) {
	if sha == "" {
		return nil, false
	}
	content, err := readBlob(gitDir, sha, relPath)
	return content, err == nil
}

// tryFetchRef best-effort fetches refName from origin into the identically
// named local ref. Failures (no origin, offline, nothing ever pushed) are
// deliberately swallowed: listTree runs next and surfaces a clear error if
// the ref truly cannot be resolved locally either, so failing here would
// only replace a precise diagnostic with a vaguer one — and would break the
// ordinary offline case where the local ref is already correct.
func tryFetchRef(gitDir, refName string) {
	_, _ = runGit(gitDir, "fetch", "origin", "+"+refName+":"+refName)
}

// listTree enumerates every path in the tree at refName. It is called
// before any destination is touched, so an unresolvable ref aborts the
// whole restore with a clear error and zero writes.
func listTree(gitDir, refName string) ([]string, error) {
	out, err := runGit(gitDir, "ls-tree", "-r", "--name-only", refName)
	if err != nil {
		return nil, fmt.Errorf("restore --track shadow: failed to read ref '%s': %w", refName, err)
	}

	paths := []string{}
	for _, line := range strings.Split(out, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			paths = append(paths, trimmed)
		}
	}
	return paths, nil
}

// readBlob extracts a blob's exact bytes (not a string round-trip), so CRLF
// — or any other byte sequence — round-trips byte-for-byte. Combined with
// the shadow repo's `core.autocrlf=false` and `* -text` attributes pinned
// by Init, this is what makes the push/restore round-trip byte-identical.
//
// Bounded at maxBlobBytes (mirroring src/tracks/shadow/restore.ts:204's
// maxBuffer), so an oversized blob fails cleanly here — before any of
// Restore's target paths are written — rather than buffering unboundedly
// and risking an OOM mid-loop after some paths are already written.
func readBlob(gitDir, refName, relPath string) ([]byte, error) {
	return runGitBytesBounded(maxBlobBytes, gitDir, "show", refName+":"+relPath)
}
