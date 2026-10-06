package shadow

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

// mergeFile 3-way merges via `git merge-file -p` over throwaway temp copies
// in the OS tmpdir (never under the root dir; the caller writes the result
// through safewrite.SafeWriteFile), mirroring src/tracks/shadow/restore.ts's
// mergeFile. It returns the merged bytes plus the conflict-hunk count
// (merge-file's exit status, 0 = clean), and ok=false when merge-file
// refuses (binary content) or otherwise errors.
//
// Kept in its own file so internal/structuralcheck's per-file allowlist
// exempts only these tmpdir writes, not restore.go's destination writes.
func mergeFile(local, base, incoming []byte) (merged []byte, conflicts int, ok bool) {
	tmpDir, err := os.MkdirTemp("", "plan-sync-merge-")
	if err != nil {
		return nil, 0, false
	}
	defer os.RemoveAll(tmpDir)

	argv := []string{"merge-file", "-p", "-L", "local", "-L", "base", "-L", "remote"}
	for _, side := range []struct {
		name    string
		content []byte
	}{{"local", local}, {"base", base}, {"remote", incoming}} {
		p := filepath.Join(tmpDir, side.name)
		if err := os.WriteFile(p, side.content, 0o600); err != nil {
			return nil, 0, false
		}
		argv = append(argv, p)
	}

	cmd := exec.Command("git", argv...)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	err = cmd.Run()
	if err == nil {
		return stdout.Bytes(), 0, true
	}
	// Exit 1..127 = that many conflict hunks, stdout holds the marked-up
	// merge; anything else (255 = binary/error) is a refusal.
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if code := exitErr.ExitCode(); code > 0 && code < 128 {
			return stdout.Bytes(), code, true
		}
	}
	return nil, 0, false
}
