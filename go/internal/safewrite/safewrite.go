// Package safewrite is the Go port of src/safe-write.ts: the shared
// destination-safety operations used by every track (shadow and sibling)
// whenever it mutates a destination path derived from the sync manifest —
// writing, copying-in, or deleting. These are the ONLY way any track is
// meant to touch such a path: rather than exposing a predicate that call
// sites must remember to invoke before their own raw os.WriteFile /
// io.Copy / os.Remove call (which is exactly how three unguarded call
// sites were missed across two prior hardening rounds in the TypeScript
// original — see docs/HARDENING-HISTORY.md finding 11), each exported
// function here performs the safety check itself and then performs the
// operation, atomically from the call site's point of view.
//
// The guard refuses (and logs a warning instead of aborting) whenever:
//
//	(a) destPath itself already exists as a symlink — checked via
//	    os.Lstat, NOT os.Stat. os.Stat follows symlinks, so it misses a
//	    DANGLING symlink (one whose target doesn't resolve to anything);
//	    os.Lstat reports the link itself, revealing that it's a symlink
//	    even though it doesn't resolve anywhere. This case is unsafe
//	    regardless of whether the link target exists.
//	    (docs/HARDENING-HISTORY.md findings 6 and 7.)
//	(b) destPath's nearest ancestor directory that actually exists on
//	    disk — walking UP from filepath.Dir(destPath), not just the
//	    immediate parent, since os.MkdirAll will happily create
//	    intermediate directories through an existing symlinked ancestor
//	    several levels up — resolves (via filepath.EvalSymlinks) outside
//	    root. (docs/HARDENING-HISTORY.md finding 8.)
//
// If destPath doesn't exist as any kind of entry yet (the ordinary
// first-write case) and its resolved ancestor chain stays within root,
// there's nothing on disk to escape through, so normal creation is safe.
//
// The check itself never aborts: any unexpected filesystem error
// encountered while resolving EvalSymlinks/Lstat during the check (e.g.
// ENOENT on a dangling-symlink ancestor, ENOTDIR when an ancestor is a
// regular file rather than a directory, EACCES on an unreadable ancestor)
// is treated as "unsafe, refuse" rather than propagating as a failure that
// would abort an entire push/pull/restore mid-run.
// (docs/HARDENING-HISTORY.md finding 12.)
//
// # Go-vs-Node runtime primitive parity
//
// The TypeScript original's fail-closed behavior depends on
// fs.lstatSync(path, {throwIfNoEntry: false}) suppressing ONLY ENOENT and
// still throwing (propagating into the outer fail-closed catch) on
// ENOTDIR/EACCES/ELOOP. Go's os.Lstat returns an ordinary error for all of
// these with no built-in distinction, so a naive
// `if err != nil { treat as absent, keep walking }` would silently convert
// the fail-CLOSED ENOTDIR/EACCES/ELOOP case into fail-OPEN — exactly the
// class of gap that hardening round 3 exists to prevent. This port
// therefore branches explicitly on errors.Is(err, fs.ErrNotExist), which
// (verified against the installed Go stdlib: syscall.Errno.Is maps only
// ENOENT to oserror.ErrNotExist) means "absent — keep walking up"; EVERY
// other error class means "unsafe — refuse".
//
// # Known, accepted gaps carried forward from the TypeScript original
//
// These are documented in docs/HARDENING-HISTORY.md's round-5 follow-ups
// as explicitly accepted and still open. They are recorded here so this
// port does not re-ship them as if it were fresh, gap-free code, and are
// deliberately NOT fixed here (fixing them is out of scope for the port
// and, in F1's case, was explicitly warned against):
//
//	F1 — SafeRemove is not directory-safe. There is no isDirectory
//	     rejection, and removal is deliberately non-recursive: granting
//	     recursive directory-tree delete authority to a manifest-derived
//	     destination would be a strictly broader authority than this guard
//	     is meant to grant, so os.Remove is used and never os.RemoveAll.
//	     The correct fix (not done here) is rejecting directory entries in
//	     the manifest plus an explicit isDirectory refusal. NOTE the Go
//	     divergence the hardening record calls out: Node's
//	     fs.rmSync(dest, {force:true}) throws ERR_FS_EISDIR on any
//	     directory, whereas os.Remove errors on a non-empty directory but
//	     SUCCEEDS on an empty one — so an empty directory at a
//	     manifest-derived destination is removed here rather than
//	     refused/crashed. This is the decided behavior, not an inherited
//	     one.
//	F2 — the structural "no unguarded writes" regression test's scope is
//	     narrower than "every destination mutation" (it does not cover
//	     append/rename-shaped writes, nor tool-owned config writers). That
//	     test is not part of this package; the gap is noted so its
//	     coverage is not assumed broader than it is.
//	F3 — hardlink write-through. A hardlink at a destination path to a
//	     file outside root is written through, since EvalSymlinks-based
//	     containment has no notion of a hardlink's "other name" and
//	     os.Lstat reports it as an ordinary regular file. The same gap
//	     covers the check-then-act TOCTOU window between the containment
//	     check and the actual write; a temp-file-then-rename write pattern
//	     would close both. Not done here.
package safewrite

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// isSafeDestination reports whether destPath may be mutated, given root as
// the containment root. It is the Go port of src/safe-write.ts's
// isSafeDestination and never fails other than by returning false.
func isSafeDestination(root, destPath string) bool {
	// Windows- and UNC-shaped inputs are rejected explicitly, before any
	// filesystem access: filepath.IsAbs does not treat `C:\...` or
	// `\\server\share\...` as absolute on a non-POSIX-path build, so such
	// an input would otherwise be treated as an innocuous relative path
	// segment and could pass a containment check that only understands
	// POSIX absolute paths. Windows support itself is out of scope; this
	// check exists so a Windows-shaped path fails closed rather than
	// silently sliding through.
	if hasWindowsShapedPath(root) || hasWindowsShapedPath(destPath) {
		return false
	}

	destStat, err := os.Lstat(destPath)
	if err == nil {
		if destStat.Mode()&os.ModeSymlink != 0 {
			return false
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		// ENOTDIR / EACCES / ELOOP / anything else: unsafe, refuse. Only
		// ENOENT ("genuinely nothing here") is benign.
		return false
	}

	realDir, err := resolveRealPath(filepath.Dir(destPath))
	if err != nil {
		return false
	}
	realRoot, err := resolveRealPath(root)
	if err != nil {
		return false
	}

	// Case-SENSITIVE comparison, matching the TypeScript original's
	// `===`/`startsWith` and the real on-disk casing filepath.EvalSymlinks
	// returns. No case-insensitive normalization is applied.
	//
	// Logged (Fix 6, completion review round 1): Go's filepath.EvalSymlinks
	// does lexical resolution + readlink and does NOT canonicalize
	// path-segment casing on a case-insensitive filesystem (macOS APFS
	// default), whereas Node's fs.realpathSync does (via realpath(3)). With
	// a mis-cased ROOT, Go refuses where TS allows. Not exploitable: root
	// is always tool-derived (git rev-parse --show-toplevel + a
	// ValidateRoot-checked name), never manifest-derived, so an attacker
	// cannot supply a mis-cased root; a mis-cased manifest ENTRY still
	// resolves inside root and passes containment correctly either way. The
	// divergence direction is fail-closed (Go refuses, never a security
	// regression) — no code change recommended.
	return realDir == realRoot ||
		strings.HasPrefix(realDir, realRoot+string(filepath.Separator))
}

// hasWindowsShapedPath reports whether p is shaped like a Windows drive path
// (`C:\...`, `C:/...`, `C:foo`) or a UNC path (`\\server\share\...`).
func hasWindowsShapedPath(p string) bool {
	if strings.HasPrefix(p, `\\`) {
		return true
	}
	if len(p) >= 2 && p[1] == ':' {
		c := p[0]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') {
			return true
		}
	}
	return false
}

// resolveRealPath resolves target to its real, symlink-free absolute path,
// even when target (or some of its ancestors) doesn't exist on disk yet:
// walks up to the nearest ancestor that does exist, resolves that ancestor
// via filepath.EvalSymlinks, then lexically re-appends the not-yet-created
// remainder — safe, since a path component that doesn't exist yet cannot be
// a symlink.
//
// Any error other than "this component is absent" (ENOENT) is returned to
// the caller rather than being absorbed as "absent, keep walking":
// isSafeDestination is the single place that turns any such error into
// "unsafe, refuse". Absorbing them here would be the fail-open bug
// described in this package's doc comment.
func resolveRealPath(target string) (string, error) {
	existing, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}

	var suffix []string
	for {
		if _, err := os.Lstat(existing); err == nil {
			break
		} else if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}

		parent := filepath.Dir(existing)
		if parent == existing {
			// Reached the filesystem root without finding anything that
			// exists.
			break
		}
		suffix = append([]string{filepath.Base(existing)}, suffix...)
		existing = parent
	}

	// EvalSymlinks fails on a dangling-symlink ancestor (ENOENT resolving
	// the target) and on a regular-file ancestor (ENOTDIR); both propagate
	// to the caller's fail-closed handling, matching fs.realpathSync.
	realExisting, err := filepath.EvalSymlinks(existing)
	if err != nil {
		return "", err
	}
	if len(suffix) == 0 {
		return realExisting, nil
	}
	return filepath.Join(append([]string{realExisting}, suffix...)...), nil
}

// SafeWriteFile safely writes content to destPath, refusing (and logging a
// warning) rather than writing if destPath is unsafe per
// isSafeDestination. Creates any missing intermediate directories first.
// Reports whether the write actually happened.
func SafeWriteFile(root, destPath string, content []byte) bool {
	if !isSafeDestination(root, destPath) {
		fmt.Fprintf(os.Stderr,
			"plan-sync: refusing to write through symlink at %s\n", destPath)
		return false
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "plan-sync: failed to write %s: %v\n", destPath, err)
		return false
	}
	if err := os.WriteFile(destPath, content, 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "plan-sync: failed to write %s: %v\n", destPath, err)
		return false
	}
	return true
}

// SafeCopyFile safely copies srcPath to destPath, refusing (and logging a
// warning) rather than copying if destPath is unsafe per
// isSafeDestination. Creates any missing intermediate directories first.
// Reports whether the copy actually happened.
//
// Go has no exceptions, so unlike the TypeScript original — where a
// missing/unreadable source propagates as a thrown error — a genuine I/O
// failure is reported here the same way a refusal is: false, plus a
// message on stderr.
func SafeCopyFile(root, srcPath, destPath string) bool {
	if !isSafeDestination(root, destPath) {
		fmt.Fprintf(os.Stderr,
			"plan-sync: refusing to write through symlink at %s\n", destPath)
		return false
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "plan-sync: failed to copy to %s: %v\n", destPath, err)
		return false
	}
	if err := copyFile(srcPath, destPath); err != nil {
		fmt.Fprintf(os.Stderr, "plan-sync: failed to copy to %s: %v\n", destPath, err)
		return false
	}
	return true
}

// copyFile copies srcPath's contents to destPath, creating destPath with
// srcPath's permission bits (matching fs.copyFileSync) and truncating any
// existing regular file there.
func copyFile(srcPath, destPath string) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer src.Close()

	info, err := src.Stat()
	if err != nil {
		return err
	}

	dest, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(dest, src); err != nil {
		dest.Close()
		return err
	}
	return dest.Close()
}

// SafeRemove safely removes destPath, refusing (and logging a warning)
// rather than removing if destPath is unsafe per isSafeDestination —
// checked FIRST, unconditionally, before existence is even considered, so a
// symlinked ancestor resolving outside root is refused the same way the
// write path refuses it, even when nothing currently exists at destPath
// through it (e.g. the ancestor symlink points at a real but empty outside
// directory).
//
// Once deemed safe, existence is checked via os.Lstat, NOT os.Stat —
// os.Stat follows symlinks, so it reports a DANGLING symlink as "doesn't
// exist", which is exactly how a prior hardening round's restore bug
// allowed a stale existence check to skip a symlinked-ancestor escape
// undetected. A path that genuinely doesn't exist at all (ENOENT) is a
// no-op, reporting true (nothing to do). Any other filesystem error while
// resolving that existence check (e.g. ENOTDIR when a higher path
// component is a regular file rather than a directory) is also treated as
// "unsafe, refuse" rather than propagating.
//
// Reports whether the path ended up absent (either it never existed, or it
// was safely removed). See F1 in this package's doc comment for the known,
// accepted directory-safety gap.
func SafeRemove(root, destPath string) bool {
	// The safety check runs first (and unconditionally), not gated behind
	// an existence check — a symlinked ancestor that resolves outside root
	// must be refused with the same warning the write path gives, even
	// when nothing currently exists at destPath through it (e.g. the
	// ancestor symlink points at a real, but empty, outside directory).
	// Checking existence first and only conditionally checking safety
	// would silently no-op that case instead, asymmetric with
	// SafeWriteFile/SafeCopyFile.
	if !isSafeDestination(root, destPath) {
		fmt.Fprintf(os.Stderr,
			"plan-sync: refusing to remove through symlink at %s\n", destPath)
		return false
	}

	if _, err := os.Lstat(destPath); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return true
		}
		return false
	}

	// Never os.RemoveAll: see F1 in this package's doc comment.
	if err := os.Remove(destPath); err != nil {
		fmt.Fprintf(os.Stderr, "plan-sync: failed to remove %s: %v\n", destPath, err)
		return false
	}
	return true
}
