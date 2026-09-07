
## Epic: Go Port Phase 1 Hardening Gaps (plan-sync-6lq) - 2026-09-07
- [ ] Case-sensitivity: document the TS/Go mis-cased-root divergence, or add a real TS guard for literal verdict agreement? — Go's own note says "no code change recommended"; go-port.md's AC says "both agree on the verdict". These conflict; plan defaults to document-only.
- [ ] Should `safeRemove`'s identical gaps (no dangling-at-destination, no depth>=2 ancestor test) be folded into this epic? — Same gap class as safeCopyFile, cheap alongside T1/T2, currently out of scope.
- [ ] Confirm artifact location `docs/GO-PORT-REVIEW.md` for the Architect+Critic outcome — no docs/decisions/ tree exists yet.
- [ ] The other ~25 go-port.md Phase 1 acceptance checkboxes were never audited — is a full sweep wanted?

## Epic: Go Port Phase 3 - Packaging and Release (plan-sync-bq6) - 2026-09-07
- [ ] Confirm `windows/arm64` is in scope alongside `windows/amd64` — assumed in for matrix symmetry (T4/A3); narrowing to amd64-only reduces the Windows test surface and CI cost.
- [ ] Confirm the final Go module path `github.com/catesandrew/plan-sync/go` vs. a separate repo — resolves go-port.md Follow-up 1, still formally open; blocks `go install` distribution either way (T5).
- [ ] Confirm release tag scheme `go-v*` — assumed to keep Go-binary releases distinguishable from future TS tags in the same repo (A4). Affects `release.yml`'s trigger.
- [ ] Is the `plan-sync-go` → `plan-sync` rename actually wanted, or is permanent coexistence under distinct names preferable? — go-port.md gates the rename on parity but never states the rename is desired; a documented "stay renamed apart" is a valid T5 outcome.
- [ ] `go/go.mod` declares `go 1.26.2` while the dev machine has go1.27.0 — is pinning CI to the go.mod version (T2 AC2) correct, or should the module's floor be bumped first?
- [ ] `ImplementationID` must become a `var` to be `-ldflags -X`-stampable (T1) — is version stamping wanted at all, or should the version stay a hand-edited constant bumped per release?
- [ ] Should Phase 3 add a `uninstall`-command packaging consideration? — Phase 1 ships no `uninstall`; Phase 2 adds it, so the first release's command surface depends on Phase 2's final scope.

## Go Port Phase 2 - Shadow Track (epic-phase2-shadow-track) - 2026-09-07
- [ ] Does Phase 2 also land the TS-side fix for the `--root "..."` rootSegment escape? — Go's `root.RootSegment` already re-validates its output, so the Go port is safe; the shipping TS binary may still be exposed. go-port.md says to file it independently, but nobody has.
- [ ] How do F1/F2/F3 in docs/HARDENING-HISTORY.md apply to the net-new `safewrite.SafeRemoveTree`? — F1 ("safeRemove not directory-safe") is arguably partially superseded by a deliberately directory-capable primitive; needs an explicit recorded decision, not an implicit one.
- [ ] Is the mixed-binary parity sequence (TS push -> Go pull, Go push -> TS pull) a Phase 2 or Phase 3 gate? — Phase 2 is the first point a full round trip is possible, but it reads as a release-gate concern.
- [ ] Confirm `uninstall` should use `os.Stat` (TS-matching, follows symlinks) for the remote-ref-delete gate while `SafeRemoveTree`'s `os.Lstat` governs removal. — A naive all-`os.Lstat` port diverges from TS on a dangling symlink planted at the shadow repo path (TS skips the remote delete and removes the link; Lstat would attempt a remote delete against a broken --git-dir and fail the command).

## Concurrency and Locking Design (plan-sync-bm3) - 2026-09-07

- [ ] Which locking mechanism? Lockfile+staleness (A), flock (B), git-native CAS (C), or atomicity-only (D) — ADR decision, maintainer call; A's staleness complexity vs B's new TS dependency + TS/Go asymmetry is the crux
- [ ] One global lock or per-resource locks (shadow repo path / sibling clonePath / manifest+.sync-config.json)? — determines Task 4/5 scope; Task 1 must classify before Task 2 can answer
- [ ] Is shadow push's local `git update-ref` mirror (src/tracks/shadow/push.ts:253) reachable by more than the push winner? — audit asserts no; unverified, changes whether the local mirror ref needs protection
- [ ] Is cross-machine sibling `clonePath` sharing in scope, or an accepted permanent limitation? — no local lock can cover it; affects what README can claim in Task 6
- [ ] Should Task 5 wait for Go Phase-2 shadow commands (push/status/uninstall are stubs at go/internal/commands/shadow.go:25-51)? — locking only init/restore now means retrofitting later
- [ ] Does adding a new TS runtime dependency (required by Option B) violate an unstated project constraint? — TS impl currently has no lock-related deps
