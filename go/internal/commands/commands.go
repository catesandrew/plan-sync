// Package commands is the Go port of src/commands/*.ts: the thin,
// track-agnostic command layer the CLI dispatches into. Each command here
// handles `--help` first (so it never triggers a side effect), resolves the
// repo root and sync root, parses `--track` (falling back to the persisted
// default track), and hands off to a track implementation.
//
// Phase 1 scope, per .omc/plans/go-port.md: init, allow, unallow, push,
// pull, status. There is deliberately NO uninstall command — sibling-track
// cleanup is an ordinary `rm -rf <clone-path>`, and the shadow track's
// teardown is out of Phase 1 scope.
package commands

import (
	"fmt"

	"plan-sync/go/internal/args"
	"plan-sync/go/internal/reporoot"
	"plan-sync/go/internal/root"
	"plan-sync/go/internal/syncconfig"
)

// resolveContext resolves the anchor repo root and the root directory this
// invocation operates against, from the shared `--root <dir>` flag.
func resolveContext(argv []string) (repoRoot, rootDir string, err error) {
	rootFlag, _ := args.ParseFlag(argv, "root")

	repoRoot, err = reporoot.ResolveRepoRoot()
	if err != nil {
		return "", "", err
	}
	rootDir, err = root.ResolveRootDir(repoRoot, rootFlag)
	if err != nil {
		return "", "", err
	}
	return repoRoot, rootDir, nil
}

// resolveTrack parses `--track` out of argv, falling back to the track
// persisted by a prior `init`. A parse failure is prefixed with the command
// name, mirroring the TypeScript wrappers' `throw new Error(\`push:
// ${err.message}\`)` pattern.
func resolveTrack(command string, argv []string, repoRoot, rootDir string) (args.Track, []string, error) {
	defaultTrack, ok, err := syncconfig.GetDefaultTrack(repoRoot, rootDir)
	if err != nil {
		return "", nil, err
	}
	if !ok {
		defaultTrack = ""
	}

	track, rest, err := args.ParseTrack(argv, defaultTrack)
	if err != nil {
		return "", nil, fmt.Errorf("%s: %w", command, err)
	}
	return track, rest, nil
}
