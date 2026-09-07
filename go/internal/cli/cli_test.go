package cli

import (
	"errors"
	"os"
	"strings"
	"testing"
)

// captureOutput swaps os.Stdout/os.Stderr for temp files for the duration
// of fn and returns what was written to each. Both writeIdentityMarker and
// Dispatch reference os.Stdout/os.Stderr at CALL time, so replacing the
// package-level variables is enough — no plumbing of io.Writers into the
// production code is required (and adding such a seam purely for a test
// would be a worse trade).
func captureOutput(t *testing.T, fn func() int) (exitCode int, stdout, stderr string) {
	t.Helper()

	dir := t.TempDir()
	outFile, err := os.Create(dir + "/stdout")
	if err != nil {
		t.Fatalf("creating stdout capture file: %v", err)
	}
	errFile, err := os.Create(dir + "/stderr")
	if err != nil {
		t.Fatalf("creating stderr capture file: %v", err)
	}

	origOut, origErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = outFile, errFile
	exitCode = fn()
	os.Stdout, os.Stderr = origOut, origErr

	if err := outFile.Close(); err != nil {
		t.Fatalf("closing stdout capture file: %v", err)
	}
	if err := errFile.Close(); err != nil {
		t.Fatalf("closing stderr capture file: %v", err)
	}

	outBytes, err := os.ReadFile(dir + "/stdout")
	if err != nil {
		t.Fatalf("reading stdout capture file: %v", err)
	}
	errBytes, err := os.ReadFile(dir + "/stderr")
	if err != nil {
		t.Fatalf("reading stderr capture file: %v", err)
	}
	return exitCode, string(outBytes), string(errBytes)
}

// registerStub installs a command that records that it ran and then fails,
// so the marker's position relative to the command's OWN stderr output is
// observable. Commands is a package-level map, so registration is undone on
// cleanup to keep tests independent.
func registerStub(t *testing.T, name string) *bool {
	t.Helper()
	ran := false
	Commands[name] = CommandFunc(func([]string) error {
		ran = true
		return errors.New("stub failure from " + name)
	})
	t.Cleanup(func() { delete(Commands, name) })
	return &ran
}

// TestDispatchWritesIdentityMarkerForMutatingCommands is the Go half of the
// $PATH-collision identity-marker requirement in .omc/plans/go-port.md: with
// two same-purpose binaries potentially on one $PATH, every mutating command
// must announce which implementation ran it, on stderr, ahead of anything
// else it writes there. Its TS counterpart lives in test/cli.test.ts.
func TestDispatchWritesIdentityMarkerForMutatingCommands(t *testing.T) {
	for _, name := range []string{"init", "allow", "unallow", "push", "pull"} {
		t.Run(name, func(t *testing.T) {
			if !mutatingCommands[name] {
				t.Fatalf("%q is not registered as a mutating command", name)
			}
			ran := registerStub(t, name)

			exitCode, _, stderr := captureOutput(t, func() int {
				return Dispatch([]string{name})
			})

			if !*ran {
				t.Fatalf("the %s command was never reached", name)
			}
			want := "plan-sync: " + ImplementationID + " (" + name + ")"
			if !strings.Contains(stderr, want+"\n") {
				t.Fatalf("stderr = %q, want it to contain %q", stderr, want)
			}
			// FIRST line, ahead of the command's own error output — so a
			// user whose $PATH has both binaries can attribute the failure.
			if first := strings.SplitN(stderr, "\n", 2)[0]; first != want {
				t.Fatalf("first stderr line = %q, want %q", first, want)
			}
			if !strings.Contains(stderr, "stub failure from "+name) {
				t.Fatalf("stderr = %q, want the command's own error too", stderr)
			}
			if exitCode == 0 {
				t.Fatal("exit code = 0, want non-zero for a failing command")
			}
		})
	}
}

// TestDispatchOmitsIdentityMarkerForStatus pins `status` as read-only: it
// mutates nothing, so it must not announce itself.
func TestDispatchOmitsIdentityMarkerForStatus(t *testing.T) {
	if mutatingCommands["status"] {
		t.Fatal("status must not be registered as a mutating command")
	}
	ran := registerStub(t, "status")

	_, _, stderr := captureOutput(t, func() int {
		return Dispatch([]string{"status"})
	})

	if !*ran {
		t.Fatal("the status command was never reached")
	}
	if strings.Contains(stderr, ImplementationID) {
		t.Fatalf("stderr = %q, want no identity marker", stderr)
	}
}

// TestDispatchOmitsIdentityMarkerForUnknownCommand covers the paths that
// never reach a command at all: nothing was mutated, so nothing announces
// itself.
func TestDispatchOmitsIdentityMarkerForUnknownCommand(t *testing.T) {
	for _, argv := range [][]string{nil, {"not-a-real-command"}, {"--help"}} {
		_, _, stderr := captureOutput(t, func() int { return Dispatch(argv) })
		if strings.Contains(stderr, ImplementationID) {
			t.Fatalf("Dispatch(%v): stderr = %q, want no identity marker", argv, stderr)
		}
	}
}

// TestImplementationIDIsDistinguishableFromTS guards the one property the
// marker exists for: `grep` must be able to tell the two implementations
// apart, and the format must not collide with the "plan-sync: <message>"
// error prefix used everywhere else.
func TestImplementationIDIsDistinguishableFromTS(t *testing.T) {
	if ImplementationID != "go/0.1.0" {
		t.Fatalf("ImplementationID = %q, want %q", ImplementationID, "go/0.1.0")
	}
	if strings.Contains(ImplementationID, "ts/") {
		t.Fatalf("ImplementationID = %q must not look like the TS binary's", ImplementationID)
	}
}
