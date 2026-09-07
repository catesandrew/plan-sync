package commands

import (
	"fmt"

	"plan-sync/go/internal/tracks/shadow"
)

// Shadow-track seams.
//
// Each shadow entry point is reached through a package-level function
// VARIABLE rather than being called directly, so a test can swap one out
// and the dispatch logic below never changes shape as entry points land.
//
// Phase 1 wires the two shadow entry points that exist:
// internal/tracks/shadow's Init and Restore. push/status are Phase 2, and
// their defaults say so explicitly rather than pretending to be a generic
// "not implemented" stub.
var (
	// ShadowInit implements `init --track shadow`
	// (src/tracks/shadow/init.ts).
	ShadowInit = shadow.Init

	// ShadowPush implements `push --track shadow`.
	ShadowPush = func(argv []string) error {
		return fmt.Errorf(
			"push --track shadow is not available until Phase 2 — " +
				"note: `init --track shadow` can already create real local " +
				"(and, once pushed by the TS binary, remote) shadow state " +
				"that this Phase 1 binary cannot yet push, check status on, " +
				"or uninstall",
		)
	}

	// ShadowPull implements `pull --track shadow` — the shadow track's
	// restore, which `pull` absorbed (src/commands/pull.ts dispatches the
	// shadow track straight into src/tracks/shadow/restore.ts, which is why
	// this points at shadow.Restore rather than at a "shadow pull" of its
	// own).
	ShadowPull = shadow.Restore

	// ShadowStatus implements `status --track shadow`.
	ShadowStatus = func(argv []string) error {
		return fmt.Errorf(
			"status --track shadow is not available until Phase 2 — " +
				"note: `init --track shadow` can already create real local " +
				"(and, once pushed by the TS binary, remote) shadow state " +
				"that this Phase 1 binary cannot yet push, check status on, " +
				"or uninstall",
		)
	}
)
