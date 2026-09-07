package glob

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// writeFiles creates each slash-separated relative path (and its parent
// directories) under root as a regular file.
func writeFiles(t *testing.T, root string, rels ...string) {
	t.Helper()
	for _, rel := range rels {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("MkdirAll(%q): %v", filepath.Dir(full), err)
		}
		if err := os.WriteFile(full, []byte("content\n"), 0o644); err != nil {
			t.Fatalf("WriteFile(%q): %v", full, err)
		}
	}
}

func expand(t *testing.T, root, pattern string) []string {
	t.Helper()
	got, err := ExpandUnderRoot(root, pattern)
	if err != nil {
		t.Fatalf("ExpandUnderRoot(%q, %q): %v", root, pattern, err)
	}
	return got
}

func TestHasGlobMeta(t *testing.T) {
	cases := map[string]bool{
		"notes.md":       false,
		"plans/a.md":     false,
		"*.md":           true,
		"plans/**/*.md":  true,
		"reports/?.md":   true,
		"logs/[abc].txt": true,
		"emoji-🎉.md":     false,
	}

	for pattern, want := range cases {
		if got := HasGlobMeta(pattern); got != want {
			t.Errorf("HasGlobMeta(%q) = %v, want %v", pattern, got, want)
		}
	}
}

func TestLiteralPatternResolvesToItselfOrNothing(t *testing.T) {
	root := t.TempDir()

	if got := expand(t, root, "notes.md"); len(got) != 0 {
		t.Errorf("literal pattern with no file on disk = %v, want []", got)
	}

	writeFiles(t, root, "notes.md", "other.md")

	want := []string{"notes.md"}
	if got := expand(t, root, "notes.md"); !reflect.DeepEqual(got, want) {
		t.Errorf("literal pattern = %v, want %v", got, want)
	}
}

func TestStarStaysWithinOneSegment(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, "a.md", "b.md", "skip.txt", "plans/nested.md")

	want := []string{"a.md", "b.md"}
	if got := expand(t, root, "*.md"); !reflect.DeepEqual(got, want) {
		t.Errorf("*.md = %v, want %v", got, want)
	}
}

func TestGlobStarMatchesAcrossMultipleDirectoryLevels(t *testing.T) {
	root := t.TempDir()
	writeFiles(t,
		root,
		"plans/a.md",
		"plans/sub/b.md",
		"plans/sub/deeper/c.md",
		"plans/skip.txt",
		"outside.md",
	)

	want := []string{"plans/a.md", "plans/sub/b.md", "plans/sub/deeper/c.md"}
	if got := expand(t, root, "plans/**/*.md"); !reflect.DeepEqual(got, want) {
		t.Errorf("plans/**/*.md = %v, want %v", got, want)
	}

	wantAll := []string{"outside.md", "plans/a.md", "plans/sub/b.md", "plans/sub/deeper/c.md"}
	if got := expand(t, root, "**/*.md"); !reflect.DeepEqual(got, wantAll) {
		t.Errorf("**/*.md = %v, want %v", got, wantAll)
	}
}

func TestCharacterClassMatchesAsciiRange(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, "a.md", "b.md", "c.md", "d.md")

	want := []string{"a.md", "b.md", "c.md"}
	if got := expand(t, root, "[a-c].md"); !reflect.DeepEqual(got, want) {
		t.Errorf("[a-c].md = %v, want %v", got, want)
	}

	wantSet := []string{"a.md", "d.md"}
	if got := expand(t, root, "[ad].md"); !reflect.DeepEqual(got, wantSet) {
		t.Errorf("[ad].md = %v, want %v", got, wantSet)
	}

	wantNegated := []string{"d.md"}
	if got := expand(t, root, "[!a-c].md"); !reflect.DeepEqual(got, wantNegated) {
		t.Errorf("[!a-c].md = %v, want %v", got, wantNegated)
	}
}

// The dialect does NOT support POSIX named classes ([[:alpha:]]) or
// backslash-escaping inside a bracket expression — this test documents and
// pins that (matching the "or the documented subset" allowance in the
// plan's AC), and demonstrates cross-implementation agreement: src/glob.ts's
// compileClass is algorithmically line-for-line equivalent (same
// leading-!/^-negation rule, same i+1=='-' range rule, no escape handling
// anywhere), so both languages parse these the same way — as a literal
// character SET, not as a POSIX class or an escape sequence.
func TestBracketClassDialectDoesNotSupportPosixClassesOrEscapes(t *testing.T) {
	// `[[:alpha:]]` is parsed as a literal-member class over the runes
	// between the outer `[` and the FIRST `]` (i.e. '[', ':', 'a', 'l',
	// 'p', 'h' — 'a' and ':' repeat), followed by a literal trailing `]`.
	// It is NOT a POSIX "alphabetic character" class.
	cases := []struct {
		pattern string
		value   string
		want    bool
	}{
		{"[[:alpha:]]", "a]", true},   // 'a' is a literal member of the set; trailing literal ']' matches
		{"[[:alpha:]]", "x]", false},  // 'x' is not one of [,:,a,l,p,h
		{"[[:alpha:]]", ":]", true},   // ':' is a literal member of the set
		{"[[:alpha:]]", "1]", false},  // digits were never in the set either
		// `\` inside a bracket expression is a literal member of the set,
		// not an escape character — `\.` is two literal set members
		// (backslash, dot), not "an escaped dot".
		{`[\.]`, `\`, true},
		{`[\.]`, `.`, true},
		{`[\.]`, `x`, false},
	}

	for _, c := range cases {
		if got := Match(c.pattern, c.value); got != c.want {
			t.Errorf("Match(%q, %q) = %v, want %v", c.pattern, c.value, got, c.want)
		}
	}
}

// The two tests below are the reason this matcher is hand-written rather
// than a translation of src/glob.ts's RegExp construction: a non-BMP rune
// is a single character to a rune-based matcher, two UTF-16 code units to
// JS's non-`u`-flagged RegExp, and up to four bytes to a byte-based one.
func TestQuestionMarkMatchesSingleNonBMPRune(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, "🎉.md", "𠀋.md", "ab.md", "a.md")

	// "🎉" is U+1F389 (one rune, two UTF-16 code units, four UTF-8 bytes);
	// "𠀋" is U+2000B, a CJK Extension-B ideograph. Each must count as
	// exactly ONE character for `?`, and "ab.md" must NOT match.
	want := []string{"a.md", "🎉.md", "𠀋.md"}
	if got := expand(t, root, "?.md"); !reflect.DeepEqual(got, want) {
		t.Errorf("?.md = %v, want %v", got, want)
	}

	if !Match("?.md", "🎉.md") {
		t.Error(`Match("?.md", "🎉.md") = false, want true`)
	}
	if Match("?.md", "ab.md") {
		t.Error(`Match("?.md", "ab.md") = true, want false`)
	}
	if !Match("??.md", "🎉🎉.md") {
		t.Error(`Match("??.md", "🎉🎉.md") = false, want true`)
	}
	if Match("?.md", "🎉🎉.md") {
		t.Error(`Match("?.md", "🎉🎉.md") = true, want false`)
	}
}

func TestStarMatchesFilenameWithNonBMPCharacters(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, "release-🎉-notes.md", "plans/𠀋-draft.md", "plain.txt")

	want := []string{"release-🎉-notes.md"}
	if got := expand(t, root, "*.md"); !reflect.DeepEqual(got, want) {
		t.Errorf("*.md = %v, want %v", got, want)
	}

	wantPrefixed := []string{"release-🎉-notes.md"}
	if got := expand(t, root, "release-*-notes.md"); !reflect.DeepEqual(got, wantPrefixed) {
		t.Errorf("release-*-notes.md = %v, want %v", got, wantPrefixed)
	}

	wantDeep := []string{"plans/𠀋-draft.md", "release-🎉-notes.md"}
	if got := expand(t, root, "**/*.md"); !reflect.DeepEqual(got, wantDeep) {
		t.Errorf("**/*.md = %v, want %v", got, wantDeep)
	}

	if !Match("[🎉a].md", "🎉.md") {
		t.Error(`Match("[🎉a].md", "🎉.md") = false, want true`)
	}
}

func TestDirectoriesAndSymlinksNeverMatch(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, "clean.md", "plans/keep.md")

	// A directory whose own name matches the pattern must not be returned.
	if err := os.MkdirAll(filepath.Join(root, "dir.md"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	outside := t.TempDir()
	writeFiles(t, outside, "secret.md")
	if err := os.Symlink(outside, filepath.Join(root, "linked-dir")); err != nil {
		t.Fatalf("Symlink(dir): %v", err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.md"), filepath.Join(root, "linked.md")); err != nil {
		t.Fatalf("Symlink(file): %v", err)
	}

	want := []string{"clean.md", "plans/keep.md"}
	if got := expand(t, root, "**/*.md"); !reflect.DeepEqual(got, want) {
		t.Errorf("**/*.md = %v, want %v", got, want)
	}
}

func TestExpandUnderRootErrorsWhenRootIsUnreadable(t *testing.T) {
	if _, err := ExpandUnderRoot(filepath.Join(t.TempDir(), "missing"), "*.md"); err == nil {
		t.Error("ExpandUnderRoot on a missing root = nil error, want error")
	}
}

func TestMatchDialect(t *testing.T) {
	cases := []struct {
		pattern string
		value   string
		want    bool
	}{
		{"*.md", "a.md", true},
		{"*.md", "sub/a.md", false},
		{"?", "a", true},
		{"?", "ab", false},
		{"?", "a/b", false},
		{"**", "a/b/c.md", true},
		{"plans/**/*.md", "plans/a.md", true},
		{"plans/**/*.md", "plans/x/y/a.md", true},
		{"plans/**/*.md", "other/a.md", false},
		{"plans/**", "plans/x/y", true},
		{"a.md", "a.md", true},
		{"a.md", "b.md", false},
		// `.` and `+` are literal in a glob, not regex metacharacters.
		{"a.md", "axmd", false},
		{"a+b.md", "a+b.md", true},
		{"[a-c]*.md", "b1.md", true},
		{"[a-c]*.md", "d1.md", false},
	}

	for _, c := range cases {
		if got := Match(c.pattern, c.value); got != c.want {
			t.Errorf("Match(%q, %q) = %v, want %v", c.pattern, c.value, got, c.want)
		}
	}
}
