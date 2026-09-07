// Package structuralcheck contains a single regression test: it scans every
// Go source file in this module (excluding internal/safewrite itself, and
// excluding _test.go files, which legitimately create fixtures with raw fs
// calls) for raw file-mutating stdlib calls. internal/safewrite is meant to
// be the SOLE sanctioned way any package in this module mutates a
// destination path — this test makes a future missed call site fail CI
// rather than requiring another review round to find it, mirroring
// test/no-unguarded-writes.test.ts's structural intent on the TS side (see
// docs/HARDENING-HISTORY.md, finding 11 and follow-up F2).
//
// This is deliberately STRICTER than the TS original: TS's structural test
// only scans src/tracks/, and its forbidden-pattern list omits
// appendFileSync/renameSync (F2). This Go version scans every package under
// go/ and additionally forbids os.Create/os.OpenFile with any write-capable
// flag, since new code has no legacy-scope excuse.
package structuralcheck

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// forbiddenPatterns are raw stdlib calls that mutate (or can mutate) a
// destination path. Each entry is a regexp matched against a file's full
// text (comments included, so a documented-but-real call can't hide inside
// a code block that isn't actually a Go comment — this trades a few
// false-positive comment matches, which the allowlist below can absorb, for
// zero false negatives).
var forbiddenPatterns = []*regexp.Regexp{
	regexp.MustCompile(`\bos\.WriteFile\s*\(`),
	regexp.MustCompile(`\bos\.Remove\s*\(`),
	regexp.MustCompile(`\bos\.RemoveAll\s*\(`),
	regexp.MustCompile(`\bos\.Rename\s*\(`),
	regexp.MustCompile(`\bos\.Create\s*\(`),
	regexp.MustCompile(`\bos\.OpenFile\s*\(`),
	regexp.MustCompile(`\bio\.Copy\s*\(`),
}

// allowlist maps a module-relative file path to an explanation of why it is
// permitted to contain a forbidden pattern. Every entry requires a
// documented reason, mirroring test/no-unguarded-writes.test.ts:32-48's
// exemption format and docs/HARDENING-HISTORY.md's F2 finding exactly: the
// TS structural test scans only src/tracks/ because src/manifest.ts's and
// src/sync-config.ts's raw writes are to TOOL-OWNED, caller-resolved config
// paths (`<repoRoot>/<rootDir>/.sync-manifest`,
// `<repoRoot>/<rootDir>/.sync-config.json`) — never a manifest-entry-
// derived destination path that untrusted content could redirect. That
// distinction, not "everything must route through safewrite unconditionally",
// is what internal/safewrite's contract actually protects: destination
// paths built from manifest/glob-expanded entries, which are the ones a
// hand-edited or malicious manifest line could influence.
//
// internal/tracks/sibling/ and internal/tracks/shadow/ contain ZERO such
// exceptions (confirmed by this test passing with no allowlist entries for
// either package) — every real destination mutation there, including
// shadow/init.go's info/exclude and info/attributes writes, routes through
// internal/safewrite.
var allowlist = map[string]string{
	"internal/manifest/manifest.go":     "writes only to manifestPath, a tool-owned config path resolved by the caller (repoRoot+rootDir+.sync-manifest), never to a manifest-ENTRY-derived path — mirrors TS's F2 exception for src/manifest.ts",
	"internal/syncconfig/syncconfig.go": "writes only to the tool-owned .sync-config.json path resolved by the caller, never to user-controlled content — mirrors TS's F2 exception for src/sync-config.ts",
}

// excludedDirs are packages allowed to contain the real, sanctioned calls
// (internal/safewrite itself) or that are out of scope for this invariant
// (cmd/, which only wires commands and never touches a destination path
// directly today, but is not part of the mutation-surface contract this
// test polices).
var excludedDirs = []string{
	filepath.FromSlash("internal/safewrite"),
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed to locate this test file")
	}
	// This file lives at <root>/internal/structuralcheck/nounguardedwrites_test.go.
	return filepath.Dir(filepath.Dir(filepath.Dir(thisFile)))
}

func TestNoUnguardedWritesOutsideSafewrite(t *testing.T) {
	root := moduleRoot(t)

	var violations []string

	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}

		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}

		for _, excluded := range excludedDirs {
			if strings.HasPrefix(rel, excluded+string(filepath.Separator)) || rel == excluded {
				return nil
			}
		}

		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		text := string(content)

		for _, pattern := range forbiddenPatterns {
			if pattern.MatchString(text) {
				if reason, ok := allowlist[filepath.ToSlash(rel)]; ok {
					t.Logf("allowlisted match in %s (pattern %s): %s", rel, pattern.String(), reason)
					continue
				}
				violations = append(violations, rel+": matched "+pattern.String())
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking module root: %v", err)
	}

	if len(violations) > 0 {
		t.Errorf(
			"found %d raw file-mutating call site(s) outside internal/safewrite and the allowlist:\n%s\n\n"+
				"internal/safewrite must be the sole sanctioned way to mutate a destination path. "+
				"Either route the call through safewrite.SafeWriteFile/SafeCopyFile/SafeRemove, or add "+
				"a documented allowlist entry in internal/structuralcheck/nounguardedwrites_test.go if this "+
				"is a genuine, reviewed exception (e.g. a temp-directory-scoped write).",
			len(violations), strings.Join(violations, "\n"),
		)
	}
}

// TestAllowlistEntriesStillExist guards against the allowlist itself going
// stale: an entry whose file no longer exists (or that no longer contains
// any forbidden pattern) should be removed, mirroring
// test/no-unguarded-writes.test.ts's own self-check.
func TestAllowlistEntriesStillExist(t *testing.T) {
	root := moduleRoot(t)

	for relSlash := range allowlist {
		rel := filepath.FromSlash(relSlash)
		full := filepath.Join(root, rel)
		content, err := os.ReadFile(full)
		if err != nil {
			t.Errorf("allowlist entry %q: file does not exist (%v) — remove this stale entry", relSlash, err)
			continue
		}
		text := string(content)
		matched := false
		for _, pattern := range forbiddenPatterns {
			if pattern.MatchString(text) {
				matched = true
				break
			}
		}
		if !matched {
			t.Errorf("allowlist entry %q: no longer contains any forbidden pattern — remove this stale entry", relSlash)
		}
	}
}
