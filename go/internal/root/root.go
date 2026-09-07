// Package root resolves which sync root directory (e.g. `.omc`, `.omx`,
// `.adlc`) a single invocation operates against, ported from src/root.ts.
//
// A repo can host multiple roots, each with its own independent manifest,
// sync-config, and (for the shadow track) ref namespace / local shadow-repo
// path, but any single command invocation always operates against exactly
// one of them.
package root

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// CandidateRoots lists the known root directory names auto-detection
// considers, in priority order.
var CandidateRoots = []string{".omc", ".omx", ".adlc"}

// DefaultRoot is used when nothing else can be resolved.
const DefaultRoot = ".omc"

const syncConfigFile = ".sync-config.json"

// ResolveRootDir resolves which root directory this invocation should
// operate against.
//
// Precedence:
//  1. explicitRoot (from `--root <dir>`), if non-empty — validated to be a
//     single directory name, never a path that could escape repoRoot.
//  2. Auto-detection: if exactly one of CandidateRoots exists as a directory
//     under repoRoot AND contains a `.sync-config.json` at its top level,
//     that one is used.
//  3. DefaultRoot otherwise — covering both a fresh repo and an ambiguous
//     state (zero or more than one candidate matches).
func ResolveRootDir(repoRoot, explicitRoot string) (string, error) {
	if explicitRoot != "" {
		return ValidateRoot(explicitRoot)
	}

	var detected []string
	for _, candidate := range CandidateRoots {
		if isInitializedRoot(repoRoot, candidate) {
			detected = append(detected, candidate)
		}
	}

	if len(detected) == 1 {
		return detected[0], nil
	}

	return DefaultRoot, nil
}

func isInitializedRoot(repoRoot, candidate string) bool {
	dir := filepath.Join(repoRoot, candidate)
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return false
	}
	_, err = os.Stat(filepath.Join(dir, syncConfigFile))
	return err == nil
}

// ValidateRoot rejects a `--root` value that isn't a single, bare directory
// name — no path separators, no `.`/`..`, no absolute paths — since the
// resolved root is joined directly onto the repo root everywhere downstream
// (manifest path, sync-config path, shadow ref/repo-path segments); an
// unvalidated value here would reopen exactly the kind of path-escape this
// codebase otherwise guards against.
//
// It additionally rejects any value whose leading-dot-stripped form (see
// RootSegment) would itself be unsafe — notably "...", which passes every
// check above yet strips to ".." and escapes one directory level wherever
// the segment is later joined onto a path.
func ValidateRoot(root string) (string, error) {
	trimmed := strings.TrimSpace(root)
	if isUnsafeSegment(trimmed) || filepath.IsAbs(trimmed) {
		return "", fmt.Errorf(
			"--root must be a single directory name with no path separators, got %q",
			root,
		)
	}
	if isUnsafeSegment(stripLeadingDot(trimmed)) {
		return "", fmt.Errorf(
			"--root %q strips to the unsafe namespace segment %q",
			root, stripLeadingDot(trimmed),
		)
	}
	return trimmed, nil
}

// RootSegment strips a single leading `.` from rootDir (e.g. `.omc` -> `omc`,
// `.omx` -> `omx`), for use in contexts that bake the root into a namespace
// segment (the shadow-track ref name and local shadow-repo path) where a
// literal leading dot is either invalid or merely noisy.
//
// The stripped result is re-validated: stripping a dot can turn an
// otherwise-valid-looking root such as "..." into "..", which escapes a
// directory level when joined onto a path and is an invalid git refname.
// Such inputs return an error rather than a usable segment.
func RootSegment(rootDir string) (string, error) {
	segment := stripLeadingDot(rootDir)
	if isUnsafeSegment(segment) {
		return "", fmt.Errorf(
			"root %q strips to the unsafe namespace segment %q",
			rootDir, segment,
		)
	}
	return segment, nil
}

func stripLeadingDot(rootDir string) string {
	return strings.TrimPrefix(rootDir, ".")
}

func isUnsafeSegment(value string) bool {
	return value == "" ||
		value == "." ||
		value == ".." ||
		strings.Contains(value, "/") ||
		strings.Contains(value, `\`)
}
