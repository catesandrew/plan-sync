// Package syncconfig is the Go port of src/sync-config.ts: the shared local
// (untracked) tool-config file at `<root>/.sync-config.json`. Both tracks
// read/write this same file — sibling-track settings live under the
// "sibling" key, the persisted default track lives under "defaultTrack" —
// so callers merge into it rather than overwrite it wholesale, and one
// track's settings never clobber the other's.
//
// # Byte-for-byte parity (Tier 1)
//
// src/sync-config.ts:79 writes via
// `fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)`.
// Two things fall out of that which this port must reproduce exactly:
//
//  1. A trailing "\n" is always appended after the JSON body.
//  2. Key order in the written JSON is INSERTION order, not alphabetical or
//     struct-declaration order: `config` is a plain JS object built by
//     `Object.assign(config, updates)` (src/sync-config.ts:76) on top of
//     whatever was already parsed from the existing file. Object.assign
//     never reorders a key that's already present — it only appends brand
//     new keys at the end — so the on-disk key order depends on the ORDER
//     callers have historically written keys in, not on any fixed schema.
//
// Go's encoding/json has no equivalent: a map's key order is randomized on
// marshal, and a struct's field order is fixed at compile time regardless of
// call history. Modeling SyncConfig as a Go struct would therefore be unable
// to reproduce (2) for any call sequence other than the one baked into the
// struct's field declaration order. Instead, SyncConfig stores its entries
// in an explicit, mutable insertion-order slice (see entry/set/get below),
// and WriteSyncConfig assembles the final JSON from that slice's order —
// exactly mirroring Object.assign's append-only-for-new-keys behavior for
// ANY call sequence, not just the one exercised by today's callers.
package syncconfig

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"plan-sync/go/internal/args"
)

const configFile = ".sync-config.json"

// SiblingSyncConfig mirrors src/sync-config.ts's SiblingSyncConfig
// interface: the sibling-track settings persisted under the "sibling" key.
type SiblingSyncConfig struct {
	ClonePath string `json:"clonePath"`
	Remote    string `json:"remote"`
}

// entry is one key/value pair of a SyncConfig, in the order it was first
// inserted.
type entry struct {
	key   string
	value json.RawMessage
}

// SyncConfig mirrors src/sync-config.ts's SyncConfig interface: a
// JSON-object-shaped bag of settings with two well-known keys
// ("defaultTrack", "sibling") plus, in the TS original, an open index
// signature for forward-compatible/unknown keys. Every key this port's own
// callers ever write is one of the two well-known ones (see
// SyncConfigUpdate), but SyncConfig still preserves any OTHER top-level key
// already present in an on-disk file — exact key, exact raw value bytes,
// exact position — so a read-merge-write round trip never drops or reorders
// data this code didn't itself write. The zero value is a valid, empty
// config (mirrors TS's `{}`).
type SyncConfig struct {
	entries []entry
}

// get returns the raw JSON value stored under key, if present.
func (c SyncConfig) get(key string) (json.RawMessage, bool) {
	for _, e := range c.entries {
		if e.key == key {
			return e.value, true
		}
	}
	return nil, false
}

// set stores raw under key, mirroring Object.assign(config, {key: ...}):
// an existing key's value is replaced IN PLACE (position preserved); a new
// key is appended at the end.
func (c *SyncConfig) set(key string, raw json.RawMessage) {
	for i := range c.entries {
		if c.entries[i].key == key {
			c.entries[i].value = raw
			return
		}
	}
	c.entries = append(c.entries, entry{key: key, value: raw})
}

// DefaultTrack returns the persisted "defaultTrack" value and whether it was
// present, mirroring getDefaultTrack()'s `readSyncConfig().defaultTrack`
// (undefined -> ok=false).
func (c SyncConfig) DefaultTrack() (args.Track, bool) {
	raw, ok := c.get("defaultTrack")
	if !ok {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return args.Track(s), true
}

// Sibling returns the persisted "sibling" entry and whether it was present.
func (c SyncConfig) Sibling() (SiblingSyncConfig, bool) {
	raw, ok := c.get("sibling")
	if !ok {
		return SiblingSyncConfig{}, false
	}
	var s SiblingSyncConfig
	if err := json.Unmarshal(raw, &s); err != nil {
		return SiblingSyncConfig{}, false
	}
	return s, true
}

// SyncConfigUpdate mirrors the shape of `updates` as accepted by
// writeSyncConfig (TS's `Partial<SyncConfig>`): the top-level keys to merge
// into the persisted config. A nil/zero field is left untouched — not
// merged — matching how Object.assign only touches keys actually present on
// the `updates` object passed to it.
type SyncConfigUpdate struct {
	// DefaultTrack, if non-empty, is merged in under the "defaultTrack" key.
	DefaultTrack args.Track
	// Sibling, if non-nil, is merged in under the "sibling" key.
	Sibling *SiblingSyncConfig
}

// SyncConfigPath returns the path to the local (untracked) tool-config file
// under repoRoot/rootDir. This file is intentionally never added to the
// sync manifest — it's tool config, not synced content.
func SyncConfigPath(repoRoot, rootDir string) string {
	return filepath.Join(repoRoot, rootDir, configFile)
}

// ReadSyncConfig reads the full sync-config object, returning an empty
// SyncConfig if the file doesn't exist yet (rather than an error) — every
// caller here treats a missing config file as "nothing configured yet", not
// an error. A file that exists but contains invalid JSON returns an error.
func ReadSyncConfig(repoRoot, rootDir string) (SyncConfig, error) {
	data, err := os.ReadFile(SyncConfigPath(repoRoot, rootDir))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return SyncConfig{}, nil
		}
		return SyncConfig{}, err
	}
	return decodeSyncConfig(data)
}

// WriteSyncConfig merges updates into the existing sync-config file
// (read-merge-write), preserving any other top-level keys already present
// (e.g. a "sibling" entry written by a prior `init --track sibling`).
// Creates the file and its parent directory if they don't exist yet.
func WriteSyncConfig(repoRoot string, updates SyncConfigUpdate, rootDir string) error {
	configPath := SyncConfigPath(repoRoot, rootDir)

	cfg, err := ReadSyncConfig(repoRoot, rootDir)
	if err != nil {
		return err
	}

	if updates.DefaultTrack != "" {
		raw, err := marshalNoHTMLEscape(string(updates.DefaultTrack))
		if err != nil {
			return err
		}
		cfg.set("defaultTrack", raw)
	}
	if updates.Sibling != nil {
		raw, err := marshalNoHTMLEscape(*updates.Sibling)
		if err != nil {
			return err
		}
		cfg.set("sibling", raw)
	}

	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return err
	}

	body, err := cfg.assemble()
	if err != nil {
		return err
	}

	// json.Indent is a pure whitespace-reformatting pass over already-valid
	// JSON bytes (it does not re-run HTML-escaping the way json.Marshal /
	// json.MarshalIndent would on a type's MarshalJSON output) -- see
	// marshalNoHTMLEscape's doc comment for why that distinction matters
	// here. This mirrors `JSON.stringify(config, null, 2)`'s formatting
	// (2-space indent), and the trailing "\n" below mirrors the literal
	// `+ "\n"` at src/sync-config.ts:79.
	var out bytes.Buffer
	if err := json.Indent(&out, body, "", "  "); err != nil {
		return err
	}
	out.WriteByte('\n')

	return os.WriteFile(configPath, out.Bytes(), 0o644)
}

// WriteDefaultTrack persists track as the default track for subsequent
// multi-track commands (push/pull/restore/status/uninstall) that omit an
// explicit --track flag. Always overwrites any previously persisted
// default -- "most recently initialized track wins" is the intended
// semantics.
func WriteDefaultTrack(repoRoot string, track args.Track, rootDir string) error {
	return WriteSyncConfig(repoRoot, SyncConfigUpdate{DefaultTrack: track}, rootDir)
}

// GetDefaultTrack returns the persisted default track, and whether one has
// been persisted yet (false covers both "init was never run" and "the
// config file predates this feature"). A file that exists but contains
// invalid JSON returns an error.
func GetDefaultTrack(repoRoot, rootDir string) (args.Track, bool, error) {
	cfg, err := ReadSyncConfig(repoRoot, rootDir)
	if err != nil {
		return "", false, err
	}
	track, ok := cfg.DefaultTrack()
	return track, ok, nil
}

// assemble renders c as a single JSON object literal, in insertion order.
// The returned bytes are valid but not necessarily whitespace-normalized;
// callers that want the on-disk 2-space-indented form should pass this
// through json.Indent (see WriteSyncConfig).
func (c SyncConfig) assemble() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, e := range c.entries {
		if i > 0 {
			buf.WriteByte(',')
		}
		keyBytes, err := marshalNoHTMLEscape(e.key)
		if err != nil {
			return nil, err
		}
		buf.Write(keyBytes)
		buf.WriteByte(':')
		buf.Write(e.value)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// decodeSyncConfig parses data as a JSON object, preserving the exact key
// insertion order and raw value bytes of every entry -- required so that
// WriteSyncConfig's read-merge-write round trip keeps every untouched key
// exactly where it already was, and keeps its value bytes exactly as
// written, rather than losing that ordering the moment the file is read
// back in.
func decodeSyncConfig(data []byte) (SyncConfig, error) {
	dec := json.NewDecoder(bytes.NewReader(data))

	tok, err := dec.Token()
	if err != nil {
		return SyncConfig{}, err
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return SyncConfig{}, fmt.Errorf("syncconfig: expected a JSON object, got %v", tok)
	}

	var cfg SyncConfig
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return SyncConfig{}, err
		}
		key, ok := keyTok.(string)
		if !ok {
			return SyncConfig{}, fmt.Errorf("syncconfig: expected a string object key, got %v", keyTok)
		}

		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return SyncConfig{}, err
		}
		cfg.set(key, raw)
	}

	if _, err := dec.Token(); err != nil { // consume closing '}'
		return SyncConfig{}, err
	}

	return cfg, nil
}

// marshalNoHTMLEscape JSON-encodes v without HTML-escaping '<', '>', and
// '&' -- unlike json.Marshal/json.MarshalIndent (which always escape those,
// with no public option to disable it), matching JSON.stringify's actual
// behavior, which never escapes them. Values here are consumed by
// SyncConfig.assemble as raw fragments embedded into a larger hand-built
// object literal, so any divergence here would leak into the on-disk bytes
// this package is required to byte-match against the TS original.
func marshalNoHTMLEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	// json.Encoder.Encode always appends a trailing newline; strip it so
	// the result can be embedded inline as a single JSON value.
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
