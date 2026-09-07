// Package manifest is the Go port of src/manifest.ts.
//
// Manifest file format: one path per line. Blank lines and lines starting
// with `#` (comments) are ignored. Every other line is returned verbatim —
// no directory-walking, glob expansion, or extension-based matching is ever
// performed by ReadManifest; the manifest is the single source of truth for
// exactly which paths are opted in to sync.
//
// Byte-for-byte parity with the TypeScript implementation is a hard
// requirement for the file-mutating helpers (AddToManifest,
// RemoveFromManifest): both tracks diff manifest contents, so an extra or
// missing trailing newline is a real behavioral difference, not cosmetics.
package manifest

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"plan-sync/go/internal/glob"
)

const manifestFile = ".sync-manifest"

// ManifestFilename is the manifest's own filename (relative to `.omc/`),
// exported so tracks can recognize and specially handle the manifest file
// itself when it travels as part of the sync payload (see push/restore/pull
// in both tracks) — it must never be treated as an ordinary manifest-listed
// content file (no secret scan, no wholesale overwrite on restore/pull,
// union-merged instead).
const ManifestFilename = manifestFile

// stderr is the sink for skip-and-warn diagnostics. It is a package
// variable purely so tests can capture the warnings ReadManifest emits;
// production code never reassigns it.
var stderr io.Writer = os.Stderr

// ManifestExists reports whether a manifest file physically exists at
// manifestPath, distinguishing a MISSING manifest file from a genuinely
// EMPTY (zero-entry) one — ReadManifest deliberately returns an empty slice
// for both, since that collapse is safe for the sibling track (an
// empty/missing manifest there just means "nothing to push"), but the shadow
// track needs to tell them apart: a missing manifest file combined with a
// real previous tip on the ref is a likely-accidental scenario (e.g. the
// manifest file itself got deleted, or state resolved somewhere unexpected),
// not a legitimate whole-manifest deletion.
func ManifestExists(manifestPath string) bool {
	// os.Stat (follows symlinks), matching TS's fs.existsSync — not
	// os.Lstat. A dangling symlink at the manifest path must report
	// "missing" in both languages: with Lstat it would report "exists",
	// ReadManifest would then return [] (empty, not missing), and a Phase 2
	// caller gating on this distinction (finding 10: missing-vs-empty) could
	// commit an empty tree over a real previous tip instead of refusing.
	_, err := os.Stat(manifestPath)
	return err == nil
}

// IsPathContained reports whether relPath, resolved relative to omcRoot,
// stays contained within omcRoot — i.e. it is not an absolute path and does
// not escape via `../` traversal. Bare absolute paths are always rejected
// outright, since joining them onto omcRoot would otherwise ignore omcRoot
// entirely and silently "resolve" to the absolute path itself.
func IsPathContained(omcRoot, relPath string) bool {
	if filepath.IsAbs(relPath) {
		return false
	}

	normalizedRoot, err := filepath.Abs(omcRoot)
	if err != nil {
		return false
	}
	resolved, err := filepath.Abs(filepath.Join(omcRoot, relPath))
	if err != nil {
		return false
	}

	return resolved == normalizedRoot ||
		strings.HasPrefix(resolved, normalizedRoot+string(filepath.Separator))
}

// ReadManifest reads the manifest at manifestPath and returns the exact list
// of paths listed in it, one per line, ignoring blank lines and `#`-prefixed
// comment lines. Returns an empty slice if the file doesn't exist.
//
// Any line that would resolve outside the manifest's `.omc/` directory (a
// `../` traversal or an absolute path — e.g. from a hand-edited manifest
// file) is skipped with a warning logged to stderr, rather than trusted and
// returned as-is. This is a skip-and-warn check, not a fail-closed one: one
// bad line in a hand-edited file shouldn't invalidate every other valid
// entry.
func ReadManifest(manifestPath string) []string {
	contents, err := os.ReadFile(manifestPath)
	if err != nil {
		return []string{}
	}

	omcRoot := filepath.Dir(manifestPath)
	entries := []string{}

	for _, raw := range strings.Split(string(contents), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !IsPathContained(omcRoot, line) {
			fmt.Fprintf(stderr, "plan-sync: ignoring out-of-bounds manifest entry '%s'\n", line)
			continue
		}
		entries = append(entries, line)
	}

	return entries
}

// AddToManifest appends entryPath to the manifest at manifestPath if it
// isn't already present (exact string match against existing entries). No-op
// if already present. Creates the manifest file and its parent directory if
// they don't exist yet.
//
// Rejects (returns an error, before writing anything) an entryPath that
// would resolve outside the manifest's `.omc/` directory — this is an active
// mutation the user just requested via `allow`, so it fails closed rather
// than being merely blocked incidentally downstream by git.
func AddToManifest(manifestPath, entryPath string) (err error) {
	omcRoot := filepath.Dir(manifestPath)
	if !IsPathContained(omcRoot, entryPath) {
		if filepath.IsAbs(entryPath) {
			return fmt.Errorf("allow: absolute paths are not allowed, got '%s'", entryPath)
		}
		return fmt.Errorf("allow: '%s' resolves outside .omc/ — refusing to add", entryPath)
	}

	for _, existing := range ReadManifest(manifestPath) {
		if existing == entryPath {
			return nil
		}
	}

	if err := os.MkdirAll(filepath.Dir(manifestPath), 0o755); err != nil {
		return err
	}

	// Byte-parity with src/manifest.ts:138-141: a leading newline is
	// prepended ONLY when the existing file is non-empty AND does not
	// already end in "\n" — i.e. we are about to append onto a dangling
	// last line. A missing file, or an empty one, gets no leading newline.
	needsLeadingNewline := false
	if existing, err := os.ReadFile(manifestPath); err == nil {
		needsLeadingNewline = len(existing) > 0 && !bytes.HasSuffix(existing, []byte("\n"))
	}

	f, openErr := os.OpenFile(manifestPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if openErr != nil {
		return openErr
	}
	defer func() {
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
	}()

	prefix := ""
	if needsLeadingNewline {
		prefix = "\n"
	}
	_, err = f.WriteString(prefix + entryPath + "\n")
	return err
}

// RemoveFromManifest removes entryPath from the manifest at manifestPath if
// present (exact string match against trimmed lines — comments/blank lines
// are preserved as-is around it). Returns true if it was present and
// removed, false if it was already absent (a no-op, not an error — mirrors
// AddToManifest's idempotent-add semantics for the removal direction).
// No-op if the manifest file doesn't exist at all.
//
// Byte-parity note (src/manifest.ts:235-252): the TS implementation splits
// on "\n", filters, and rejoins with "\n". Splitting a string that ends in
// "\n" yields a trailing empty-string element which survives the filter, so
// removing any ONE entry from a multi-entry manifest PRESERVES the trailing
// newline. The file becomes exactly empty (zero bytes) only in the
// degenerate case where the removed entry was the sole remaining line. This
// port reproduces that algorithm verbatim — deliberately no trailing
// whitespace cleanup or newline normalization.
func RemoveFromManifest(manifestPath, entryPath string) (bool, error) {
	contents, err := os.ReadFile(manifestPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}

	lines := strings.Split(string(contents), "\n")
	kept := make([]string, 0, len(lines))
	removed := false

	for _, line := range lines {
		if strings.TrimSpace(line) == entryPath {
			removed = true
			continue
		}
		kept = append(kept, line)
	}

	if !removed {
		return false, nil
	}

	if err := os.WriteFile(manifestPath, []byte(strings.Join(kept, "\n")), 0o644); err != nil {
		return false, err
	}

	return true, nil
}

// ResolveManifestPaths reads the manifest at manifestPath (via ReadManifest)
// and resolves every entry to concrete, currently-on-disk paths: EVERY entry
// is always treated as a glob pattern and re-evaluated live against the
// current filesystem under `.omc/`, via glob.ExpandUnderRoot — there is no
// literal-vs-pattern branch here. A literal filename like `notes.md` is just
// a degenerate pattern with no metacharacters, so ExpandUnderRoot naturally
// resolves it to itself (if it currently exists on disk, as a regular file)
// or to nothing (if it doesn't exist, or is a symlink), via the exact same
// walk+match logic used for every other entry — no special-casing needed.
// Returns the deduplicated, combined list in first-seen order.
//
// This is deliberately a SEPARATE function from ReadManifest, not a
// replacement for it: ReadManifest's contract (raw entries verbatim, never
// glob-expanded) must not change, since several call sites legitimately need
// the raw list rather than "what should be synced right now" — e.g.
// `unallow`'s glob-matching against current manifest entries, AddToManifest's
// own duplicate-check, and the manifest-travel merge logic in
// shadow/restore.ts and sibling/pull.ts that unions incoming manifest lines
// into the local one.
//
// Note that push/status do NOT call this directly — see
// ResolveManifestSyncCandidates below for the list they actually consume.
func ResolveManifestPaths(manifestPath string) []string {
	entries := ReadManifest(manifestPath)
	omcRoot := filepath.Dir(manifestPath)

	resolved := []string{}
	seen := map[string]bool{}

	for _, entry := range entries {
		matches, err := glob.ExpandUnderRoot(omcRoot, entry)
		if err != nil {
			continue
		}
		for _, match := range matches {
			if seen[match] {
				continue
			}
			seen[match] = true
			resolved = append(resolved, match)
		}
	}

	return resolved
}

// ResolveManifestSyncCandidates is the candidate path list actually consumed
// by both tracks' `push` and `status`: the union of ResolveManifestPaths
// (every entry's CURRENT filesystem matches, live) with every literal
// (non-glob) manifest entry, included even when it doesn't currently resolve
// to anything on disk.
//
// That extra inclusion is what push/status need beyond ResolveManifestPaths
// alone: a literal entry like `notes.md` always refers to exactly one
// specific path, whether or not a file is currently there — and push's
// deletion-propagation, status's "missing locally" reporting, and both
// tracks' symlink-skip warnings all depend on that path surviving into the
// candidate list even when it's absent or a symlink (both of which
// glob.ExpandUnderRoot, underlying ResolveManifestPaths, otherwise silently
// omits, since it only ever collects currently-existing regular files). A
// glob PATTERN entry (e.g. `plans/*.md`) has no single path of its own to
// fall back to this way — if it currently matches nothing, it contributes
// nothing, which is correct: there's no specific file a pattern "used to
// mean" that a deletion or missing-locally check could act on.
func ResolveManifestSyncCandidates(manifestPath string) []string {
	entries := ReadManifest(manifestPath)

	candidates := ResolveManifestPaths(manifestPath)
	seen := map[string]bool{}
	for _, c := range candidates {
		seen[c] = true
	}

	for _, entry := range entries {
		if HasGlobMeta(entry) || seen[entry] {
			continue
		}
		seen[entry] = true
		candidates = append(candidates, entry)
	}

	return candidates
}

// HasGlobMeta reports whether pattern contains any glob metacharacter
// (`*`, `?`, `[`), mirroring hasGlobMeta in src/glob.ts. `**` is covered by
// the `*` case.
func HasGlobMeta(pattern string) bool {
	return strings.ContainsAny(pattern, "*?[")
}
