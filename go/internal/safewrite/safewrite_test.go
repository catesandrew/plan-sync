package safewrite

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// newFixture mirrors test/safe-write.test.ts's beforeEach: a fresh temp
// directory with a `root` containment root inside it, so `tmpDir` itself is
// "outside root" for escape tests. t.TempDir() is the Go equivalent of the
// TS suite's fs.mkdtempSync + afterEach rmSync teardown.
func newFixture(t *testing.T) (tmpDir, root string) {
	t.Helper()
	tmpDir = t.TempDir()
	root = filepath.Join(tmpDir, "root")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir root: %v", err)
	}
	return tmpDir, root
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir for %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
}

func symlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink %s -> %s: %v", link, target, err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// lexists reports whether path exists as any kind of entry, without
// following symlinks — the os.Lstat-based equivalent of the TS suite's
// fs.existsSync assertions, chosen deliberately so a dangling symlink
// counts as "exists".
func lexists(t *testing.T, path string) bool {
	t.Helper()
	if _, err := os.Lstat(path); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false
		}
		t.Fatalf("lstat %s: %v", path, err)
	}
	return true
}

// --- SafeWriteFile -------------------------------------------------------

func TestSafeWriteFileWritesCreatingMissingIntermediateDirectories(t *testing.T) {
	_, root := newFixture(t)
	dest := filepath.Join(root, "a", "b", "file.md")

	if !SafeWriteFile(root, dest, []byte("hello\n")) {
		t.Fatal("SafeWriteFile = false, want true")
	}
	if got := readFile(t, dest); got != "hello\n" {
		t.Fatalf("content = %q, want %q", got, "hello\n")
	}
}

func TestSafeWriteFileRefusesExistingSymlinkAtDestination(t *testing.T) {
	tmpDir, root := newFixture(t)
	outside := filepath.Join(tmpDir, "outside.txt")
	writeFile(t, outside, "original\n")
	dest := filepath.Join(root, "linked.md")
	symlink(t, outside, dest)

	if SafeWriteFile(root, dest, []byte("attack\n")) {
		t.Fatal("SafeWriteFile = true, want false")
	}
	if got := readFile(t, outside); got != "original\n" {
		t.Fatalf("outside file was written through: %q", got)
	}
}

func TestSafeWriteFileRefusesSymlinkedAncestorDirectory(t *testing.T) {
	tmpDir, root := newFixture(t)
	outsideDir := filepath.Join(tmpDir, "outside-dir-write")
	mkdir(t, outsideDir)
	symlink(t, outsideDir, filepath.Join(root, "plans"))
	dest := filepath.Join(root, "plans", "foo.md")

	if SafeWriteFile(root, dest, []byte("attack\n")) {
		t.Fatal("SafeWriteFile = true, want false")
	}
	if lexists(t, filepath.Join(outsideDir, "foo.md")) {
		t.Fatal("wrote through symlinked ancestor into outside dir")
	}
}

func TestSafeWriteFileFailsClosedOnDanglingSymlinkMidPathAncestor(t *testing.T) {
	tmpDir, root := newFixture(t)
	symlink(t, filepath.Join(tmpDir, "does-not-exist"), filepath.Join(root, "ghost"))
	dest := filepath.Join(root, "ghost", "deep", "file.md")

	if SafeWriteFile(root, dest, []byte("x\n")) {
		t.Fatal("SafeWriteFile = true, want false")
	}
	if lexists(t, filepath.Join(tmpDir, "does-not-exist")) {
		t.Fatal("created through dangling symlink ancestor")
	}
}

func TestSafeWriteFileFailsClosedOnRegularFileMidPathAncestor(t *testing.T) {
	_, root := newFixture(t)
	notADir := filepath.Join(root, "notadir")
	writeFile(t, notADir, "i am a file, not a directory\n")
	dest := filepath.Join(root, "notadir", "deep", "file.md")

	if SafeWriteFile(root, dest, []byte("x\n")) {
		t.Fatal("SafeWriteFile = true, want false")
	}
	if got := readFile(t, notADir); got != "i am a file, not a directory\n" {
		t.Fatalf("regular-file ancestor was clobbered: %q", got)
	}
}

// NEW (no TS equivalent): a DANGLING symlink at the destination path
// itself, not as a mid-path ancestor. This is the case os.Stat (like
// Node's fs.existsSync) reports as "doesn't exist" because it follows the
// link — docs/HARDENING-HISTORY.md findings 6 and 7. os.Lstat must report
// the link itself and the write must be refused.
func TestSafeWriteFileRefusesDanglingSymlinkAtDestinationItself(t *testing.T) {
	tmpDir, root := newFixture(t)
	outsideTarget := filepath.Join(tmpDir, "outside-not-yet-created.txt")
	dest := filepath.Join(root, "dangling.md")
	symlink(t, outsideTarget, dest)

	// Precondition: os.Stat follows the link and reports it as absent,
	// while os.Lstat sees the symlink. If this ever stops holding, the
	// guard's choice of Lstat is no longer load-bearing.
	if _, err := os.Stat(dest); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("os.Stat on dangling symlink: err = %v, want ErrNotExist", err)
	}
	st, err := os.Lstat(dest)
	if err != nil {
		t.Fatalf("os.Lstat on dangling symlink: %v", err)
	}
	if st.Mode()&os.ModeSymlink == 0 {
		t.Fatal("os.Lstat did not report the dangling entry as a symlink")
	}

	if SafeWriteFile(root, dest, []byte("attack\n")) {
		t.Fatal("SafeWriteFile = true, want false")
	}
	if lexists(t, outsideTarget) {
		t.Fatal("created the outside link target through a dangling symlink")
	}
}

// NEW (no TS equivalent): a LIVE symlinked ancestor at depth >= 2 where the
// immediate parent directory does not exist on disk yet. An implementation
// that checked only the immediate parent (or only the immediate parent's
// existence) would miss this entirely and let os.MkdirAll walk straight
// through the symlink — docs/HARDENING-HISTORY.md finding 8.
func TestSafeWriteFileRefusesLiveSymlinkedAncestorTwoLevelsUp(t *testing.T) {
	tmpDir, root := newFixture(t)
	outsideDir := filepath.Join(tmpDir, "outside-deep")
	mkdir(t, outsideDir)
	symlink(t, outsideDir, filepath.Join(root, "plans"))

	// root/plans/sub does NOT exist (neither does outsideDir/sub), so the
	// destination's immediate parent (root/plans/sub/deep) is two levels
	// below the symlink and three levels below the nearest existing entry.
	dest := filepath.Join(root, "plans", "sub", "deep", "file.md")
	if lexists(t, filepath.Join(outsideDir, "sub")) {
		t.Fatal("precondition: immediate parent chain must not exist yet")
	}

	if SafeWriteFile(root, dest, []byte("attack\n")) {
		t.Fatal("SafeWriteFile = true, want false")
	}
	if lexists(t, filepath.Join(outsideDir, "sub")) {
		t.Fatal("MkdirAll walked through the symlinked ancestor into outside dir")
	}
}

// --- SafeCopyFile --------------------------------------------------------

func TestSafeCopyFileCopiesToSafeDestination(t *testing.T) {
	tmpDir, root := newFixture(t)
	src := filepath.Join(tmpDir, "src.md")
	writeFile(t, src, "copied content\n")
	dest := filepath.Join(root, "dest.md")

	if !SafeCopyFile(root, src, dest) {
		t.Fatal("SafeCopyFile = false, want true")
	}
	if got := readFile(t, dest); got != "copied content\n" {
		t.Fatalf("content = %q, want %q", got, "copied content\n")
	}
}

func TestSafeCopyFileRefusesSymlinkedAncestorDirectory(t *testing.T) {
	tmpDir, root := newFixture(t)
	outsideDir := filepath.Join(tmpDir, "outside-dir-copy")
	mkdir(t, outsideDir)
	symlink(t, outsideDir, filepath.Join(root, "plans"))
	src := filepath.Join(tmpDir, "src.md")
	writeFile(t, src, "attack\n")
	dest := filepath.Join(root, "plans", "foo.md")

	if SafeCopyFile(root, src, dest) {
		t.Fatal("SafeCopyFile = true, want false")
	}
	if lexists(t, filepath.Join(outsideDir, "foo.md")) {
		t.Fatal("copied through symlinked ancestor into outside dir")
	}
}

func TestSafeCopyFileFailsClosedOnRegularFileMidPathAncestor(t *testing.T) {
	tmpDir, root := newFixture(t)
	notADir := filepath.Join(root, "notadir")
	writeFile(t, notADir, "i am a file\n")
	src := filepath.Join(tmpDir, "src.md")
	writeFile(t, src, "content\n")
	dest := filepath.Join(root, "notadir", "deep", "file.md")

	if SafeCopyFile(root, src, dest) {
		t.Fatal("SafeCopyFile = true, want false")
	}
	if got := readFile(t, notADir); got != "i am a file\n" {
		t.Fatalf("regular-file ancestor was clobbered: %q", got)
	}
}

// --- SafeRemove ----------------------------------------------------------

func TestSafeRemoveIsNoOpWhenPathDoesNotExist(t *testing.T) {
	_, root := newFixture(t)
	dest := filepath.Join(root, "never-existed.md")

	if !SafeRemove(root, dest) {
		t.Fatal("SafeRemove = false, want true (no-op)")
	}
}

func TestSafeRemoveRemovesExistingFileWithinRoot(t *testing.T) {
	_, root := newFixture(t)
	dest := filepath.Join(root, "gone.md")
	writeFile(t, dest, "bye\n")

	if !SafeRemove(root, dest) {
		t.Fatal("SafeRemove = false, want true")
	}
	if lexists(t, dest) {
		t.Fatal("file still exists after SafeRemove")
	}
}

func TestSafeRemoveRefusesSymlinkedAncestorEscapingRoot(t *testing.T) {
	tmpDir, root := newFixture(t)
	outsideDir := filepath.Join(tmpDir, "outside-dir-rm")
	mkdir(t, outsideDir)
	outsideFile := filepath.Join(outsideDir, "foo.md")
	writeFile(t, outsideFile, "outside content\n")
	symlink(t, outsideDir, filepath.Join(root, "plans"))
	dest := filepath.Join(root, "plans", "foo.md")

	if SafeRemove(root, dest) {
		t.Fatal("SafeRemove = true, want false")
	}
	if !lexists(t, outsideFile) {
		t.Fatal("removed a file outside root through a symlinked ancestor")
	}
}

func TestSafeRemoveFailsClosedOnDanglingSymlinkMidPathAncestor(t *testing.T) {
	tmpDir, root := newFixture(t)
	symlink(t, filepath.Join(tmpDir, "does-not-exist"), filepath.Join(root, "ghost"))
	dest := filepath.Join(root, "ghost", "deep", "file.md")

	if SafeRemove(root, dest) {
		t.Fatal("SafeRemove = true, want false")
	}
}

func TestSafeRemoveFailsClosedOnRegularFileMidPathAncestor(t *testing.T) {
	_, root := newFixture(t)
	notADir := filepath.Join(root, "notadir")
	writeFile(t, notADir, "i am a file\n")
	dest := filepath.Join(root, "notadir", "deep", "file.md")

	if SafeRemove(root, dest) {
		t.Fatal("SafeRemove = true, want false")
	}
	if !lexists(t, notADir) {
		t.Fatal("regular-file ancestor was removed")
	}
}

// --- Pre-mortem 1: non-ENOENT error classification -----------------------

// TestContainmentCheckFailsClosedOnENOTDIR is the dedicated Pre-mortem 1
// regression test. A regular file as a mid-path ancestor makes os.Lstat on
// anything below it fail with ENOTDIR. Go's os.Lstat gives no built-in
// distinction between that and "absent", so a naive
// `if err != nil { treat as absent, keep walking up }` would climb to the
// regular file itself, resolve it successfully INSIDE root, and report the
// destination as SAFE — converting round 3's fail-closed behavior into
// fail-open. This test asserts the error classification directly AND that
// all three operations refuse, not merely that nothing panicked.
func TestContainmentCheckFailsClosedOnENOTDIR(t *testing.T) {
	tmpDir, root := newFixture(t)
	notADir := filepath.Join(root, "notadir")
	writeFile(t, notADir, "i am a file, not a directory\n")
	dest := filepath.Join(root, "notadir", "deep", "file.md")

	// The exact hazard: this error is NOT fs.ErrNotExist, so it must not
	// be absorbed as "absent, keep walking".
	_, err := os.Lstat(filepath.Join(root, "notadir", "deep"))
	if err == nil {
		t.Fatal("precondition: os.Lstat below a regular file should fail")
	}
	if errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("precondition: ENOTDIR must not classify as fs.ErrNotExist, got %v", err)
	}

	// And the fail-open shape this test exists to catch: the nearest
	// existing ancestor resolves cleanly INSIDE root, so an implementation
	// that walked past the ENOTDIR would conclude "safe".
	realAncestor, resolveErr := resolveRealPath(notADir)
	if resolveErr != nil {
		t.Fatalf("precondition: the regular-file ancestor should itself resolve: %v", resolveErr)
	}
	realRoot, resolveErr := resolveRealPath(root)
	if resolveErr != nil {
		t.Fatalf("precondition: root should resolve: %v", resolveErr)
	}
	if len(realAncestor) <= len(realRoot) || realAncestor[:len(realRoot)] != realRoot {
		t.Fatalf("precondition: %q should be inside %q", realAncestor, realRoot)
	}

	if isSafeDestination(root, dest) {
		t.Fatal("isSafeDestination = true on an ENOTDIR ancestor, want false (fail closed)")
	}

	src := filepath.Join(tmpDir, "src.md")
	writeFile(t, src, "content\n")

	if SafeWriteFile(root, dest, []byte("x\n")) {
		t.Fatal("SafeWriteFile = true on an ENOTDIR ancestor, want false")
	}
	if SafeCopyFile(root, src, dest) {
		t.Fatal("SafeCopyFile = true on an ENOTDIR ancestor, want false")
	}
	if SafeRemove(root, dest) {
		t.Fatal("SafeRemove = true on an ENOTDIR ancestor, want false")
	}
	if got := readFile(t, notADir); got != "i am a file, not a directory\n" {
		t.Fatalf("regular-file ancestor was mutated: %q", got)
	}
}

// TestContainmentCheckFailsClosedOnEACCES is the permission-denied half of
// Pre-mortem 1: an unreadable (mode 0000) ancestor directory makes os.Lstat
// below it fail with EACCES, which — like ENOTDIR — must be classified as
// "unsafe, refuse" and never as "absent, keep walking".
func TestContainmentCheckFailsClosedOnEACCES(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: directory permissions are not enforced")
	}

	tmpDir, root := newFixture(t)
	noAccess := filepath.Join(root, "noaccess")
	mkdir(t, noAccess)
	// The destination lives under the unreadable directory, so resolving
	// its ancestor chain hits EACCES before reaching anything absent.
	mkdir(t, filepath.Join(noAccess, "sub"))
	dest := filepath.Join(noAccess, "sub", "file.md")

	if err := os.Chmod(noAccess, 0o000); err != nil {
		t.Fatalf("chmod 0000: %v", err)
	}
	// Restore permissions so t.TempDir()'s cleanup can remove the tree.
	t.Cleanup(func() { _ = os.Chmod(noAccess, 0o755) })

	_, err := os.Lstat(filepath.Join(noAccess, "sub"))
	if err == nil {
		t.Skip("filesystem does not enforce directory search permission")
	}
	if errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("precondition: EACCES must not classify as fs.ErrNotExist, got %v", err)
	}
	if !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("precondition: want a permission error, got %v", err)
	}

	if isSafeDestination(root, dest) {
		t.Fatal("isSafeDestination = true on an EACCES ancestor, want false (fail closed)")
	}

	src := filepath.Join(tmpDir, "src.md")
	writeFile(t, src, "content\n")

	if SafeWriteFile(root, dest, []byte("x\n")) {
		t.Fatal("SafeWriteFile = true on an EACCES ancestor, want false")
	}
	if SafeCopyFile(root, src, dest) {
		t.Fatal("SafeCopyFile = true on an EACCES ancestor, want false")
	}
	if SafeRemove(root, dest) {
		t.Fatal("SafeRemove = true on an EACCES ancestor, want false")
	}
}

// --- Windows- and UNC-shaped inputs --------------------------------------

// TestHasWindowsShapedPath covers the explicit rejection required because
// filepath.IsAbs does not treat `C:\...` or `\\server\share\...` as
// absolute on a non-Windows build, so such an input would otherwise be
// handled as an ordinary relative path segment.
func TestHasWindowsShapedPath(t *testing.T) {
	windowsShaped := []string{
		`C:\Windows\System32\evil.md`,
		`c:/Windows/evil.md`,
		`C:evil.md`,
		`Z:\evil.md`,
		`\\server\share\evil.md`,
		`\\?\C:\evil.md`,
	}
	for _, p := range windowsShaped {
		if !hasWindowsShapedPath(p) {
			t.Errorf("hasWindowsShapedPath(%q) = false, want true", p)
		}
	}

	posixShaped := []string{
		"/tmp/root/file.md",
		"relative/file.md",
		"./file.md",
		"../file.md",
		"",
		"/",
		`weird\backslash\name.md`,
		"C/not-a-drive.md",
	}
	for _, p := range posixShaped {
		if hasWindowsShapedPath(p) {
			t.Errorf("hasWindowsShapedPath(%q) = true, want false", p)
		}
	}
}

// TestOperationsRefuseWindowsShapedPaths asserts the refusal is intentional
// (driven by the explicit shape check) rather than incidental — on a POSIX
// build such a path would also fail the containment comparison, so the
// check is defense-in-depth for the deferred Windows build.
func TestOperationsRefuseWindowsShapedPaths(t *testing.T) {
	tmpDir, root := newFixture(t)
	src := filepath.Join(tmpDir, "src.md")
	writeFile(t, src, "content\n")

	shaped := []string{
		`C:\Windows\evil.md`,
		`\\server\share\evil.md`,
	}
	for _, dest := range shaped {
		if isSafeDestination(root, dest) {
			t.Errorf("isSafeDestination(root, %q) = true, want false", dest)
		}
		if SafeWriteFile(root, dest, []byte("x\n")) {
			t.Errorf("SafeWriteFile(root, %q) = true, want false", dest)
		}
		if SafeCopyFile(root, src, dest) {
			t.Errorf("SafeCopyFile(root, %q) = true, want false", dest)
		}
		if SafeRemove(root, dest) {
			t.Errorf("SafeRemove(root, %q) = true, want false", dest)
		}
		if lexists(t, dest) {
			t.Errorf("a Windows-shaped path was created on disk: %q", dest)
		}
	}

	// A Windows-shaped containment ROOT is refused too, regardless of the
	// destination.
	if isSafeDestination(`C:\root`, filepath.Join(root, "file.md")) {
		t.Error(`isSafeDestination with root "C:\\root" = true, want false`)
	}
}

// --- Containment prefix comparison ---------------------------------------

// TestContainmentIsCaseSensitive pins the prefix comparison to the
// case-SENSITIVE semantics of the TypeScript original's `===`/`startsWith`
// and of the real on-disk casing filepath.EvalSymlinks returns. No
// case-insensitive normalization is applied.
func TestContainmentIsCaseSensitive(t *testing.T) {
	tmpDir, root := newFixture(t)
	dest := filepath.Join(root, "file.md")

	// Same real directory, differently cased root string. On a
	// case-sensitive filesystem the mis-cased root does not exist at all;
	// on a case-insensitive one it resolves to root's real (canonical)
	// casing. Either way the comparison must not be relaxed to match
	// case-insensitively against the mis-cased literal.
	miscasedRoot := filepath.Join(tmpDir, "ROOT")
	realMiscased, err := resolveRealPath(miscasedRoot)
	if err != nil {
		// Case-sensitive filesystem: tmpDir/ROOT does not exist, its
		// realpath resolution fails, and the operation fails closed.
		if isSafeDestination(miscasedRoot, dest) {
			t.Fatal("isSafeDestination = true for an unresolvable mis-cased root")
		}
		return
	}

	realRoot, err := resolveRealPath(root)
	if err != nil {
		t.Fatalf("resolveRealPath(root): %v", err)
	}
	// Case-insensitive filesystem: EvalSymlinks canonicalizes casing, so
	// the two resolve identically and the destination is legitimately
	// contained. The point of the assertion is that containment is decided
	// on resolved real paths, never by lowercasing the inputs.
	if realMiscased == realRoot {
		if !isSafeDestination(miscasedRoot, dest) {
			t.Fatal("isSafeDestination = false although the roots resolve identically")
		}
		return
	}
	if isSafeDestination(miscasedRoot, dest) {
		t.Fatalf("isSafeDestination = true although %q != %q", realMiscased, realRoot)
	}
}

// TestContainmentRejectsSiblingPrefixDirectory guards the classic
// prefix-matching bug: `<root>-evil` shares a string prefix with `<root>`
// but is not contained by it. The separator-terminated prefix check must
// reject it.
func TestContainmentRejectsSiblingPrefixDirectory(t *testing.T) {
	tmpDir, root := newFixture(t)
	sibling := filepath.Join(tmpDir, "root-evil")
	mkdir(t, sibling)
	dest := filepath.Join(sibling, "file.md")

	if isSafeDestination(root, dest) {
		t.Fatal("isSafeDestination = true for a sibling sharing root's string prefix")
	}
	if SafeWriteFile(root, dest, []byte("attack\n")) {
		t.Fatal("SafeWriteFile = true, want false")
	}
	if lexists(t, dest) {
		t.Fatal("wrote into a sibling directory outside root")
	}
}

// TestSafeWriteFileAllowsRootItselfAsParent covers the `realDir ==
// realRoot` half of the containment comparison (a destination directly in
// root, whose parent IS root).
func TestSafeWriteFileAllowsRootItselfAsParent(t *testing.T) {
	_, root := newFixture(t)
	dest := filepath.Join(root, "top-level.md")

	if !SafeWriteFile(root, dest, []byte("ok\n")) {
		t.Fatal("SafeWriteFile = false, want true")
	}
	if got := readFile(t, dest); got != "ok\n" {
		t.Fatalf("content = %q, want %q", got, "ok\n")
	}
}
