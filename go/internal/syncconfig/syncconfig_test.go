package syncconfig

import (
	"os"
	"path/filepath"
	"testing"

	"plan-sync/go/internal/args"
)

const testRoot = ".omc"

// TestSyncConfigPath ports test/sync-config.test.ts's "syncConfigPath
// resolves to .omc/.sync-config.json under the given repo root".
func TestSyncConfigPath(t *testing.T) {
	tmp := t.TempDir()

	got := SyncConfigPath(tmp, testRoot)
	want := filepath.Join(tmp, testRoot, ".sync-config.json")
	if got != want {
		t.Fatalf("SyncConfigPath() = %q, want %q", got, want)
	}
}

// TestReadSyncConfigMissingFile ports "readSyncConfig returns {} when the
// file doesn't exist yet".
func TestReadSyncConfigMissingFile(t *testing.T) {
	tmp := t.TempDir()

	cfg, err := ReadSyncConfig(tmp, testRoot)
	if err != nil {
		t.Fatalf("ReadSyncConfig() error = %v", err)
	}
	if _, ok := cfg.DefaultTrack(); ok {
		t.Fatalf("expected no defaultTrack on an empty config")
	}
	if _, ok := cfg.Sibling(); ok {
		t.Fatalf("expected no sibling entry on an empty config")
	}
}

// TestGetDefaultTrackUnset ports "getDefaultTrack returns undefined when
// nothing has been persisted".
func TestGetDefaultTrackUnset(t *testing.T) {
	tmp := t.TempDir()

	track, ok, err := GetDefaultTrack(tmp, testRoot)
	if err != nil {
		t.Fatalf("GetDefaultTrack() error = %v", err)
	}
	if ok {
		t.Fatalf("GetDefaultTrack() = (%q, true), want ok=false", track)
	}
}

// TestWriteDefaultTrackRoundTrip ports "writeDefaultTrack persists a
// default track that getDefaultTrack then reads back".
func TestWriteDefaultTrackRoundTrip(t *testing.T) {
	tmp := t.TempDir()

	if err := WriteDefaultTrack(tmp, args.TrackShadow, testRoot); err != nil {
		t.Fatalf("WriteDefaultTrack(shadow) error = %v", err)
	}
	if track, ok, err := GetDefaultTrack(tmp, testRoot); err != nil || !ok || track != args.TrackShadow {
		t.Fatalf("GetDefaultTrack() = (%q, %v, %v), want (shadow, true, nil)", track, ok, err)
	}

	if err := WriteDefaultTrack(tmp, args.TrackSibling, testRoot); err != nil {
		t.Fatalf("WriteDefaultTrack(sibling) error = %v", err)
	}
	if track, ok, err := GetDefaultTrack(tmp, testRoot); err != nil || !ok || track != args.TrackSibling {
		t.Fatalf("GetDefaultTrack() = (%q, %v, %v), want (sibling, true, nil)", track, ok, err)
	}
}

// TestWriteSyncConfigMergesPreservingOtherKeys ports "writeSyncConfig
// merges into the existing file, preserving other top-level keys".
func TestWriteSyncConfigMergesPreservingOtherKeys(t *testing.T) {
	tmp := t.TempDir()

	sibling := SiblingSyncConfig{ClonePath: "/x", Remote: "git@x"}
	if err := WriteSyncConfig(tmp, SyncConfigUpdate{Sibling: &sibling}, testRoot); err != nil {
		t.Fatalf("WriteSyncConfig(sibling) error = %v", err)
	}
	if err := WriteDefaultTrack(tmp, args.TrackSibling, testRoot); err != nil {
		t.Fatalf("WriteDefaultTrack(sibling) error = %v", err)
	}

	cfg, err := ReadSyncConfig(tmp, testRoot)
	if err != nil {
		t.Fatalf("ReadSyncConfig() error = %v", err)
	}
	if got, ok := cfg.Sibling(); !ok || got != sibling {
		t.Fatalf("Sibling() = (%+v, %v), want (%+v, true)", got, ok, sibling)
	}
	if got, ok := cfg.DefaultTrack(); !ok || got != args.TrackSibling {
		t.Fatalf("DefaultTrack() = (%q, %v), want (sibling, true)", got, ok)
	}

	// Writing the default track again must not clobber the sibling entry.
	if err := WriteDefaultTrack(tmp, args.TrackShadow, testRoot); err != nil {
		t.Fatalf("WriteDefaultTrack(shadow) error = %v", err)
	}
	cfgAfter, err := ReadSyncConfig(tmp, testRoot)
	if err != nil {
		t.Fatalf("ReadSyncConfig() error = %v", err)
	}
	if got, ok := cfgAfter.Sibling(); !ok || got != sibling {
		t.Fatalf("Sibling() after 2nd write = (%+v, %v), want (%+v, true)", got, ok, sibling)
	}
	if got, ok := cfgAfter.DefaultTrack(); !ok || got != args.TrackShadow {
		t.Fatalf("DefaultTrack() after 2nd write = (%q, %v), want (shadow, true)", got, ok)
	}
}

// TestWriteSyncConfigExactBytes is the Tier-1 byte-parity gate: it asserts
// the EXACT bytes WriteSyncConfig produces for a known call sequence,
// including the trailing newline and JS-object insertion-order key
// ordering that plain encoding/json (struct field order, or a map's
// randomized iteration order) cannot reproduce on its own.
//
// Reference (hand-verified against src/sync-config.ts:71-79, and
// re-derived above in this file's own package doc comment):
//
//	writeSyncConfig(tmpDir, { sibling: { clonePath: "/x", remote: "git@x" } });
//	writeDefaultTrack(tmpDir, "sibling");
//
// Trace: call 1 starts from config={} (no file yet), Object.assign inserts
// "sibling" as the only key -> file becomes:
//
//	{
//	  "sibling": {
//	    "clonePath": "/x",
//	    "remote": "git@x"
//	  }
//	}
//
// (plus the trailing "\n" from `JSON.stringify(config, null, 2) + "\n"`).
// Call 2 reads that file back (config = {sibling: {...}}), then
// Object.assign inserts "defaultTrack" as a NEW key -- appended after the
// pre-existing "sibling" key, since Object.assign never reorders an
// existing key -- giving the final expected bytes below.
func TestWriteSyncConfigExactBytes(t *testing.T) {
	tmp := t.TempDir()

	sibling := SiblingSyncConfig{ClonePath: "/x", Remote: "git@x"}
	if err := WriteSyncConfig(tmp, SyncConfigUpdate{Sibling: &sibling}, testRoot); err != nil {
		t.Fatalf("WriteSyncConfig(sibling) error = %v", err)
	}
	if err := WriteDefaultTrack(tmp, args.TrackSibling, testRoot); err != nil {
		t.Fatalf("WriteDefaultTrack(sibling) error = %v", err)
	}

	got, err := os.ReadFile(SyncConfigPath(tmp, testRoot))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}

	want := "{\n" +
		"  \"sibling\": {\n" +
		"    \"clonePath\": \"/x\",\n" +
		"    \"remote\": \"git@x\"\n" +
		"  },\n" +
		"  \"defaultTrack\": \"sibling\"\n" +
		"}\n"

	if string(got) != want {
		t.Fatalf("byte mismatch:\ngot:  %q\nwant: %q", string(got), want)
	}
}

// TestWriteSyncConfigExactBytesReverseOrder proves the key ordering is
// genuinely insertion-order-driven (Object.assign semantics), not a
// hardcoded "sibling always first" assumption baked into this port: writing
// "defaultTrack" before "sibling" here must produce "defaultTrack" first in
// the output, the mirror image of TestWriteSyncConfigExactBytes.
func TestWriteSyncConfigExactBytesReverseOrder(t *testing.T) {
	tmp := t.TempDir()

	if err := WriteDefaultTrack(tmp, args.TrackShadow, testRoot); err != nil {
		t.Fatalf("WriteDefaultTrack(shadow) error = %v", err)
	}
	sibling := SiblingSyncConfig{ClonePath: "/y", Remote: "git@y"}
	if err := WriteSyncConfig(tmp, SyncConfigUpdate{Sibling: &sibling}, testRoot); err != nil {
		t.Fatalf("WriteSyncConfig(sibling) error = %v", err)
	}

	got, err := os.ReadFile(SyncConfigPath(tmp, testRoot))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}

	want := "{\n" +
		"  \"defaultTrack\": \"shadow\",\n" +
		"  \"sibling\": {\n" +
		"    \"clonePath\": \"/y\",\n" +
		"    \"remote\": \"git@y\"\n" +
		"  }\n" +
		"}\n"

	if string(got) != want {
		t.Fatalf("byte mismatch:\ngot:  %q\nwant: %q", string(got), want)
	}
}
