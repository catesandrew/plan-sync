// Package shadow is the Go port of the shadow-ref sync track
// (src/tracks/shadow/*). Phase 1 covers exactly two entry points:
//
//   - Init  — the port of src/tracks/shadow/init.ts (`plan-sync init
//     --track shadow`): bootstraps the local bare shadow repo, its config,
//     the anchor repo's `info/exclude` entry, and the `origin` remote.
//   - Restore — the port of src/tracks/shadow/restore.ts, which the
//     TypeScript CLI now reaches exclusively through `plan-sync pull
//     --track shadow` (src/commands/pull.ts dispatches
//     `shadowRestore.run(rest)` for the shadow track). The exported name
//     tracks the source module (restore.ts), not the command name.
//
// push/status/uninstall/scan are Phase 2 and deliberately absent.
//
// Every destination mutation derived from the sync manifest — and, for
// belt-and-braces, every file this package writes at all — routes through
// internal/safewrite. There are no raw os.WriteFile / os.Remove /
// os.Rename / os.Create / os.OpenFile calls anywhere in this package.
package shadow

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
)

// maxBlobBytes mirrors src/tracks/shadow/restore.ts:204's
// `maxBuffer: 100 * 1024 * 1024` — a hard, explicit bound on how large a
// single blob read is allowed to be. TS's execFileSync throws (a clean,
// pre-any-write failure) once this is exceeded; Go's exec.Cmd has no
// built-in equivalent (Cmd.Output() buffers unbounded by default), so
// runGitBytesBounded enforces it explicitly rather than allowing an
// oversized blob to be buffered in memory mid-restore, which could OOM the
// process after some — but not all — target paths have already been
// written (a partial-write state Restore's own contract forbids).
//
// A package-level `var`, not `const`, so tests can shrink it temporarily
// (save/restore) to exercise the boundary without allocating a real 100MB
// fixture blob.
var maxBlobBytes int64 = 100 * 1024 * 1024

// gitDirFlag builds the `--git-dir=<path>` argument used to address the
// bare shadow repo, matching the TypeScript implementation's execFileSync
// invocations exactly (git plumbing against a bare repo, never a working
// tree).
func gitDirFlag(shadowRepoPath string) string {
	return "--git-dir=" + shadowRepoPath
}

// runGit runs `git <argv...>` and returns its stdout as a string. On
// failure the returned error carries git's own stderr text when there is
// any, so callers can surface a real diagnostic rather than a bare "exit
// status 128".
func runGit(argv ...string) (string, error) {
	out, err := runGitBytes(argv...)
	return string(out), err
}

// runGitBytes is runGit for binary-safe output: it returns git's stdout as
// raw bytes rather than round-tripping through a string, so blob content
// (CRLF, NUL, arbitrary encodings) survives byte-for-byte. This mirrors the
// TypeScript original's deliberate use of a Buffer (not `encoding: "utf8"`)
// in readBlob.
func runGitBytes(argv ...string) ([]byte, error) {
	cmd := exec.Command("git", argv...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return nil, errors.New(detail)
	}
	return stdout.Bytes(), nil
}

// runGitBytesBounded is runGitBytes with an explicit cap on stdout size,
// enforced without buffering past the limit: stdout is read through a
// LimitReader capped at limit+1 so an oversized blob is detected (and the
// process killed) after reading only one byte past the boundary, not after
// buffering the whole thing. See maxBlobBytes's doc comment for why this
// exists — restore.go's readBlob is the only caller today.
func runGitBytesBounded(limit int64, argv ...string) ([]byte, error) {
	cmd := exec.Command("git", argv...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	out, readErr := io.ReadAll(io.LimitReader(stdout, limit+1))

	if int64(len(out)) > limit {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, fmt.Errorf("blob exceeds the %d-byte limit", limit)
	}

	waitErr := cmd.Wait()
	if waitErr != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = waitErr.Error()
		}
		return nil, errors.New(detail)
	}
	if readErr != nil {
		return nil, readErr
	}
	return out, nil
}

// tryGit runs git and reports its trimmed stdout, or "" when the command
// failed or produced nothing. It is the Go shape of the TypeScript
// original's several `try { execFileSync(...) } catch { return undefined }`
// helpers, where a non-zero exit is an expected, informative answer ("no
// such remote", "no such config key") rather than a failure to report.
func tryGit(argv ...string) string {
	out, err := runGit(argv...)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}
