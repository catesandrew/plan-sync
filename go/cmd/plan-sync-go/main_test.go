package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// This is the only test that exercises the COMPILED binary as a real
// subprocess. internal/cli's tests cover Dispatch's return value in
// process; they cannot cover what main() actually does with it (os.Exit),
// nor that the command registrations in this package's init() are wired at
// all. Both are exactly the things the cross-implementation parity harness
// in test/e2e/parity.test.ts depends on, so they get their own Go-side
// sanity check here rather than being discovered only from the TS side.

// buildBinary compiles this package into a throwaway binary. It is the same
// `go build ./cmd/plan-sync-go` the parity harness runs, so a failure here
// is a build failure, not a test-harness quirk.
func buildBinary(t *testing.T) string {
	t.Helper()

	if _, err := exec.LookPath("go"); err != nil {
		t.Skipf("go toolchain not on $PATH: %v", err)
	}

	bin := filepath.Join(t.TempDir(), "plan-sync-go")
	cmd := exec.Command("go", "build", "-o", bin, ".")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("go build: %v\n%s", err, stderr.String())
	}
	return bin
}

type result struct {
	exitCode int
	stdout   string
	stderr   string
}

func execBinary(t *testing.T, bin, cwd string, argv ...string) result {
	t.Helper()
	cmd := exec.Command(bin, argv...)
	cmd.Dir = cwd
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	exitCode := 0
	if err != nil {
		exitErr, ok := err.(*exec.ExitError)
		if !ok {
			t.Fatalf("running %s %v: %v", bin, argv, err)
		}
		exitCode = exitErr.ExitCode()
	}
	return result{exitCode: exitCode, stdout: stdout.String(), stderr: stderr.String()}
}

// newAnchorRepo creates a throwaway git repo, so commands that resolve the
// repo root via `git rev-parse --show-toplevel` get a real answer instead
// of failing on "not a git repository" for an unrelated reason.
func newAnchorRepo(t *testing.T) string {
	t.Helper()

	tmpDir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolving temp dir: %v", err)
	}
	anchor := filepath.Join(tmpDir, "anchor")
	if err := os.MkdirAll(anchor, 0o755); err != nil {
		t.Fatalf("creating anchor dir: %v", err)
	}
	cmd := exec.Command("git", "init", "--quiet")
	cmd.Dir = anchor
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	return anchor
}

func TestBinaryExitCodes(t *testing.T) {
	bin := buildBinary(t)
	anchor := newAnchorRepo(t)

	t.Run("no args prints usage and exits non-zero", func(t *testing.T) {
		got := execBinary(t, bin, anchor)
		if got.exitCode == 0 {
			t.Fatal("exit code = 0, want non-zero")
		}
		if !strings.Contains(got.stdout, "Usage: plan-sync") {
			t.Fatalf("stdout = %q, want usage text", got.stdout)
		}
	})

	t.Run("--help prints usage and exits zero", func(t *testing.T) {
		got := execBinary(t, bin, anchor, "--help")
		if got.exitCode != 0 {
			t.Fatalf("exit code = %d, want 0\n%s", got.exitCode, got.stderr)
		}
		if !strings.Contains(got.stdout, "Usage: plan-sync") {
			t.Fatalf("stdout = %q, want usage text", got.stdout)
		}
	})

	t.Run("unknown command prints usage and exits non-zero", func(t *testing.T) {
		got := execBinary(t, bin, anchor, "not-a-real-command")
		if got.exitCode == 0 {
			t.Fatal("exit code = 0, want non-zero")
		}
		if !strings.Contains(got.stdout, "Usage: plan-sync") {
			t.Fatalf("stdout = %q, want usage text", got.stdout)
		}
	})

	// Every Phase 1 command must be REGISTERED: a routed command that fails
	// on its own terms must not print usage text (which would mean
	// "unrecognized command", i.e. a missing registration in init()).
	for _, name := range []string{"init", "allow", "unallow", "push", "pull", "status"} {
		t.Run(name+" is registered", func(t *testing.T) {
			got := execBinary(t, bin, anchor, name)
			if got.exitCode == 0 {
				t.Fatalf("exit code = 0, want non-zero for %s with no flags in a fresh repo", name)
			}
			if strings.Contains(got.stdout, "Usage: plan-sync") {
				t.Fatalf("%s was treated as an unrecognized command: stdout = %q", name, got.stdout)
			}
			if !strings.Contains(got.stderr, name) {
				t.Fatalf("stderr = %q, want it to name the %s command", got.stderr, name)
			}
		})
	}

	// --help must never trigger a side effect, so it must succeed for every
	// command even in a repo with nothing initialized.
	for _, name := range []string{"init", "allow", "unallow", "push", "pull", "status"} {
		t.Run(name+" --help exits zero", func(t *testing.T) {
			got := execBinary(t, bin, anchor, name, "--help")
			if got.exitCode != 0 {
				t.Fatalf("exit code = %d, want 0\n%s", got.exitCode, got.stderr)
			}
			if !strings.Contains(got.stdout, "Usage: plan-sync "+name) {
				t.Fatalf("stdout = %q, want %s's help text", got.stdout, name)
			}
		})
	}
}

// TestBinaryWritesIdentityMarker is the compiled-binary half of the
// $PATH-collision identity-marker requirement: internal/cli's test proves
// Dispatch writes it, this one proves it survives to the real binary's
// stderr, which is what a user (and the parity harness) actually sees.
func TestBinaryWritesIdentityMarker(t *testing.T) {
	bin := buildBinary(t)
	anchor := newAnchorRepo(t)

	for _, name := range []string{"init", "allow", "unallow", "push", "pull"} {
		got := execBinary(t, bin, anchor, name)
		want := "plan-sync: go/0.1.0 (" + name + ")"
		if first := strings.SplitN(got.stderr, "\n", 2)[0]; first != want {
			t.Errorf("%s: first stderr line = %q, want %q", name, first, want)
		}
		if strings.Contains(got.stderr, "ts/0.1.0") {
			t.Errorf("%s: the Go binary must never identify itself as the TS one: %q", name, got.stderr)
		}
	}

	// status is read-only: no marker.
	got := execBinary(t, bin, anchor, "status")
	if strings.Contains(got.stderr, "go/0.1.0") {
		t.Errorf("status printed an identity marker: %q", got.stderr)
	}
}
