# Plan: Go Port Phase 3 — Packaging and Release

Status: **ready for execution** (blocked on Phase 2)
Epic: `plan-sync-bq6` — depends on `plan-sync-m02` (Phase 2, shadow track plumbing)
Source of truth: [`.omc/plans/go-port.md`](./go-port.md) v3 (Option B′, three phases)

---

## Context

Phase 1 has landed: `go/` contains a stdlib-only Go port with `init`/`allow`/`unallow`/
`push`/`pull`/`status`, the `internal/safewrite` containment choke point, the structural
`no-unguarded-writes` check (`go/internal/structuralcheck/`), and a working
cross-implementation parity harness (`test/e2e/parity.test.ts`, which builds both
`dist/cli.js` and a `plan-sync-go` binary into a temp dir and execs them as real
subprocesses). The stderr `$PATH`-collision identity marker exists on both sides
(`go/internal/cli/cli.go:29` `ImplementationID = "go/0.1.0"`, `src/cli.ts`
`IMPLEMENTATION_ID`).

What does **not** exist:

- **No CI of any kind.** `.github/` is absent entirely. Nothing runs `go test ./...`,
  `vitest run`, or the parity suite on push.
- **No multi-target build.** `go/build.sh` is four lines and single-target:
  `go build -o plan-sync-go ./cmd/plan-sync-go`. No `-ldflags="-s -w"`, no `GOOS`/`GOARCH`
  loop, no size check, no checksums.
- **No Windows validation at all.** go-port.md deliberately excluded `GOOS=windows` from
  Phase 1's cross-compile AC because Windows symlink/junction semantics, the developer-mode
  privilege requirement for creating symlinks, and case-insensitive-filesystem containment
  comparisons are all materially different from the POSIX assumptions every containment fix
  depends on.
- **No resolution of the naming/module question.** The binary is `plan-sync-go` and the Go
  module path is the non-go-gettable `plan-sync/go` (`go/go.mod`). go-port.md Follow-up 1
  (module import path / repo layout) is still open, and the rename to the shared `plan-sync`
  name is an explicit Phase 3 gate contingent on the full parity suite passing.

## Hard prerequisite (applies to the entire epic)

**Nothing in this epic ships until Phase 2 (`plan-sync-m02`) is feature-complete.** The
shadow track must work end-to-end — `push`/`status`/`uninstall --track shadow` implemented,
Phase 2's scoped containment gate closed for `shadow/uninstall.ts`'s recursive delete and
`shadow/push.ts`'s temp-dir cleanup, and the full Tier-1/Tier-2 parity suite (including a
real shadow-track round trip through the remote ref, not just fixture refs) green. Tasks
T1–T3 below can be *authored* against the Phase 1 binary in parallel with Phase 2, but no
task's acceptance criteria are considered met — and no release tag is cut — until Phase 2
lands.

## Guardrails

**Must have**
- Stdlib-only stays true: `go list -m all` shows no non-stdlib dependency after Phase 3.
- Every shipped artifact is reproducible from a committed script, not from a CI-only inline
  command. CI calls the script; the script also runs on a maintainer laptop.
- Windows is gated, not bundled. A green POSIX matrix never implies Windows readiness.
- The parity harness keeps working across the rename (T5) — it hardcodes `plan-sync-go`.

**Must NOT have**
- No new runtime dependencies, no goreleaser/cross-compile toolchain that requires cgo.
- No npm publishing work: `package.json` is `"private": true`. Phase 3 packages the **Go**
  binary only; TS distribution is out of scope.
- No silent inheritance of POSIX containment conclusions onto Windows.
- No release of `windows/*` artifacts before T3's gate passes.

---

## Task Flow

```
        Phase 2 (plan-sync-m02) ──────────── hard prerequisite for ALL ────────────┐
                                                                                    │
  T1 cross-compile matrix (non-Windows) ──┬──> T2 CI + release workflow ──┬─────────┤
                                          │                               │         │
                                          └──> T3 Windows gated sub-phase │         │
                                                        │                 │         │
                                                        └──> T4 add Windows to matrix
                                                                          │
                              (Phase 2 full parity suite green) ──> T5 rename decision+execution
                                                                          │
                                                                    T6 distribution docs
```

---

## T1 — Cross-compile build matrix for non-Windows targets

**Effort: M** · **Depends on:** Phase 2 (ship gate only; can be authored earlier)

### Files created/changed
- `go/build.sh` — keep the existing single-target fast path for local dev (default,
  no-args behavior unchanged), add a `--release` / `--all` mode.
- `go/release.sh` (new) — or the `--release` branch of `build.sh`; one of the two, not both.
  Emits per-target binaries into `go/dist/` plus a `SHA256SUMS` file.
- `go/.gitignore` — add `/dist/` alongside the existing `/plan-sync-go`.
- `go/internal/cli/cli.go` — change `ImplementationID` from `const` to `var` so the release
  build can stamp it via `-ldflags="-X plan-sync/go/internal/cli.ImplementationID=go/<ver>"`.
  A `const` cannot be `-X`-injected; this is a real blocker for version stamping.
  (`go/internal/cli/cli_test.go:143` asserts the value and continues to pass unchanged.)

### Acceptance criteria
1. `go/release.sh` (or `build.sh --release`) run from a clean checkout on macOS produces
   exactly four binaries in `go/dist/`, named `plan-sync-go_<goos>_<goarch>`:
   `darwin/amd64`, `darwin/arm64`, `linux/amd64`, `linux/arm64` — the exact target list from
   go-port.md's Phase 1 AC2. No target is added or removed without editing this plan.
2. Every binary is built with `CGO_ENABLED=0` and `-ldflags="-s -w -X <ImplementationID>"`,
   and every binary is **under 15MB** verified programmatically (the script itself fails
   non-zero if any artifact exceeds the threshold — not a manual `ls -lh` eyeball).
3. `file go/dist/plan-sync-go_<goos>_<goarch>` reports the matching OS/arch for all four
   (cross-built artifacts cannot be executed on the build host; identity is verified
   structurally here and behaviorally in T2's native runners).
4. The host-native artifact (`darwin/arm64` on the dev machine) runs `--help` with exit code
   0 and prints the same usage text as `go run ./cmd/plan-sync-go --help`.
5. `plan-sync-go_<...> push --help` emits the identity marker `plan-sync: go/<version> (push)`
   on stderr as its first line, with `<version>` equal to the stamped release version — i.e.
   the `-X` injection demonstrably took effect, not silently no-opped.
6. `go/dist/SHA256SUMS` contains one line per artifact and `shasum -a 256 -c SHA256SUMS`
   passes from within `go/dist/`.
7. `go list -m all` (run in `go/`) still shows no non-stdlib dependency.
8. Re-running the script twice in a row produces byte-identical binaries for the same target
   (build determinism: `-trimpath` is set; no timestamp/host-path leakage).

---

## T2 — CI and release workflow wiring

**Effort: M** · **Depends on:** T1 · **Ship gate:** Phase 2

### Files created/changed
- `.github/workflows/ci.yml` (new) — push + pull_request.
- `.github/workflows/release.yml` (new) — triggered on tag push matching `go-v*`.

### Acceptance criteria
1. `ci.yml` runs on `ubuntu-latest` and `macos-latest` and, for each, executes:
   `cd go && go vet ./... && go test ./...` **and** `npm ci && npm test` **and** the
   cross-implementation parity suite (`test/e2e/parity.test.ts`) — the parity job requires
   both a Go toolchain and Node on the same runner, since the harness builds and execs both
   binaries. A failure in any of the three fails the job.
2. The Go toolchain version is pinned via `go-version-file: go/go.mod` (currently declares
   `go 1.26.2`), not a hardcoded string that can drift from the module's own requirement.
3. `ci.yml` runs the structural regression check (`go/internal/structuralcheck/`) as part of
   `go test ./...` and the job fails if a new unguarded raw-mutation call site is introduced —
   verified once by temporarily adding an `os.WriteFile` call outside `internal/safewrite`
   in a scratch branch and confirming CI goes red.
4. `release.yml`, on a `go-v0.1.0`-shaped tag, invokes the **same** `go/release.sh` from T1
   (not a re-implementation of the build inline in YAML), then creates a GitHub Release with
   all four artifacts and `SHA256SUMS` attached.
5. `release.yml` includes a native smoke job per OS: the `linux/amd64` artifact runs
   `--help` (exit 0) on `ubuntu-latest` and the `darwin/arm64` artifact runs `--help`
   (exit 0) on `macos-latest`, downloaded from the built artifact set — closing T1 AC3's
   structural-only verification with real execution.
6. A tag push on a branch where `go test ./...` fails does **not** produce a release: the
   release job is gated on the test job succeeding (`needs:`), verified by an intentional
   red-test dry run.
7. `release.yml` contains no `windows` entry at this point (added only by T4).
8. The workflow does not publish to npm and does not touch `package.json`'s `private: true`.

---

## T3 — Windows gated sub-phase: containment analysis and Windows test suite

**Effort: L** · **Depends on:** T1, T2 · **Ship gate:** Phase 2 · **Gates:** T4

This is the sub-phase go-port.md deliberately carved out. It is *not* "add `GOOS=windows` to
the loop." Nothing here is satisfied by a green POSIX suite.

### Files created/changed
- `docs/WINDOWS-SUPPORT.md` (new) — the containment analysis writeup: for each POSIX
  assumption in `go/internal/safewrite`, `go/internal/root`, `go/internal/manifest`, and
  `go/internal/shadowpaths`, state whether it holds on Windows, and if not, what the Go code
  does instead. This is the Windows analogue of `docs/HARDENING-HISTORY.md` and is the
  artifact the adversarial review reviews.
- `go/internal/safewrite/safewrite_windows_test.go` (new, build-tagged) — Windows-only cases.
- `go/internal/safewrite/safewrite.go` — Windows-specific fixes surfaced by the analysis
  (expected: junction handling, case-insensitive containment comparison, error-class
  branching for Windows error codes that have no `fs.ErrNotExist` mapping).
- `go/internal/root/root.go`, `go/internal/shadowpaths/shadowpaths.go` — drive-letter/UNC
  path handling; `%LOCALAPPDATA%` vs. `${XDG_CACHE_HOME:-$HOME/.cache}` fallback decision for
  the shadow-repo path.
- `.github/workflows/ci.yml` — add a `windows-latest` job (initially `continue-on-error:
  true`, flipped to blocking as the final step of this task).

### Acceptance criteria
1. `docs/WINDOWS-SUPPORT.md` exists and enumerates, one row per item, every containment
   finding from `docs/HARDENING-HISTORY.md` that Phase 1's AC re-verified on POSIX
   (findings 3, 4, 6, 7, 8, 11, 12) with an explicit Windows verdict: *holds as-is* /
   *holds with the fix at `<file:symbol>`* / *does not hold, documented limitation*. No row
   is left blank or "TBD".
2. A Windows-only test asserts the containment check treats a **junction** (`mklink /J`) as
   a symlink-equivalent for containment purposes — i.e. a junction pointing outside the root
   is rejected, matching the POSIX symlink behavior in
   `go/internal/safewrite/safewrite_test.go`.
3. A Windows-only test asserts correct behavior when symlink creation is **unavailable**
   (no developer mode / no `SeCreateSymbolicLinkPrivilege`): the tool fails closed with a
   clear error, and the test itself skips-with-reason rather than silently passing when the
   privilege *is* present.
4. A Windows-only test asserts case-insensitive containment: a manifest entry whose casing
   differs from the on-disk casing produces the **same containment verdict** as the
   exact-case entry (this is the Windows counterpart of Phase 1's macOS APFS
   case-sensitivity probe).
5. `isPathContained`'s equivalent is tested on an actual `GOOS=windows` build with
   drive-letter (`C:\...`) and UNC (`\\server\share\...`) inputs, and the verdicts match the
   POSIX-build expectations Phase 1 already pinned for the same shaped inputs — proving
   `filepath.IsAbs`'s platform-dependent behavior does not open a gap in either direction.
6. The shadow-repo path branch on Windows is decided and tested: both the
   `PLAN_SYNC_STATE_DIR`-set branch and the fallback branch produce a documented, tested
   path shape, and the `$HOME`-unset/`XDG_CACHE_HOME`-unset third case from go-port.md's
   risk table has a Windows-equivalent decided outcome.
7. `go test ./...` passes on a `windows-latest` CI runner with the job **blocking** (not
   `continue-on-error`).
8. A dedicated Architect + Critic adversarial review pass runs against
   `docs/WINDOWS-SUPPORT.md` plus the Windows-specific code changes, sequential and separate
   from whoever wrote them, with the same pass bar as Phase 1: **zero CRITICAL findings**,
   every MAJOR either fixed or logged with an owner and rationale in the follow-up ledger.
   This gate passing is the *only* thing that unblocks T4.

---

## T4 — Add Windows targets to the release matrix

**Effort: S** · **Depends on:** T3 (hard gate — T3 AC8 must have passed)

### Files created/changed
- `go/release.sh` — add `windows/amd64` (and `windows/arm64`, see assumption A3) to the
  target list, with `.exe` suffix handling.
- `.github/workflows/release.yml` — add a `windows-latest` smoke job.
- `docs/WINDOWS-SUPPORT.md` — append the shipped-targets line and any documented limitation
  carried forward from T3.

### Acceptance criteria
1. `go/release.sh` produces `plan-sync-go_windows_amd64.exe` (and `_arm64.exe`) alongside the
   four POSIX artifacts, each under 15MB, each present in `SHA256SUMS`.
2. `release.yml`'s `windows-latest` smoke job downloads `plan-sync-go_windows_amd64.exe` and
   runs `--help` with exit code 0.
3. The Windows smoke job additionally runs one mutating command (`allow` against a temp repo)
   and asserts the identity marker `plan-sync: go/<version> (allow)` appears on stderr —
   confirming the marker path works on Windows, not just the read-only `--help` path.
4. `git log` shows T3's review-gate evidence (the follow-up ledger entry) landed **before**
   the commit that adds Windows to the matrix. Ordering is auditable, not asserted.

---

## T5 — Binary and module rename: `plan-sync-go` → `plan-sync`

**Effort: M** · **Depends on:** T1, T2, T4, **and** Phase 2's full cross-implementation
Tier-1/Tier-2 parity suite passing (the explicit gate stated in go-port.md's `$PATH`-collision AC)

This task has a **decision** half and an **execution** half. The decision half also resolves
go-port.md Follow-up 1 (module import path / repo layout), which is still open: `go/go.mod`
declares `module plan-sync/go`, which is not go-gettable, so `go install` distribution is
impossible until it changes.

### Files created/changed
- `go/go.mod` — module path `plan-sync/go` → `github.com/catesandrew/plan-sync/go`.
- Every `.go` file with an internal import (`plan-sync/go/internal/...` → new path) —
  mechanical, `go mod edit` + `gofmt -r` or a scripted rewrite.
- `go/cmd/plan-sync-go/` → `go/cmd/plan-sync/` (directory rename drives the default binary
  name).
- `go/build.sh`, `go/release.sh`, `go/.gitignore` — binary name and artifact names.
- `test/e2e/parity.test.ts:212-213` — hardcodes `plan-sync-go` and `./cmd/plan-sync-go`;
  breaks on rename if not updated.
- `go/cmd/plan-sync/main_test.go:165` — asserts the marker string; `go/internal/cli/cli.go`
  comments referencing `plan-sync-go`.
- `README.md`, `src/cli.ts` comments — user-facing and doc references.
- `docs/DESIGN.md` or a new `docs/COEXISTENCE.md` — the `$PATH` guidance after the rename.

### Acceptance criteria
1. A written decision is recorded (in this file's Decision Log section or an ADR) covering
   both: (a) whether the binary is renamed to `plan-sync` at all, and (b) the final Go module
   path. If the answer to (a) is "not yet", the rationale and the specific unmet condition
   are recorded — a deferral is an acceptable outcome, an *undocumented* deferral is not.
2. The rename gate's precondition is evidenced, not asserted: a link/reference to a green
   parity-suite run covering the **full** Tier-1 set (manifest bytes, `.sync-config.json`
   bytes, exit codes, `git ls-tree` of the shadow ref via a real round trip) and Tier-2
   normalized stdout, run after Phase 2 landed.
3. After execution: `cd go && go build ./cmd/plan-sync` produces a binary named `plan-sync`,
   and `go test ./...` is green with zero references to the old module path
   (`grep -rn "plan-sync/go/internal" go/` returns nothing).
4. `test/e2e/parity.test.ts` passes without modification *to its assertions* — only its
   binary-path constants change. If any assertion has to change, that is a parity regression
   and blocks the rename.
5. `go install github.com/catesandrew/plan-sync/go/cmd/plan-sync@latest` succeeds from a
   clean `GOPATH` against a pushed tag — the concrete proof the module path is correct.
6. The identity marker still distinguishes the two implementations after the rename: with
   both binaries named `plan-sync` on `$PATH`, `plan-sync push --help` emits either
   `plan-sync: go/<ver> (push)` or `plan-sync: ts/<ver> (push)` and the user can tell which
   ran. This is the entire justification for the marker and must be re-verified post-rename,
   since the rename is exactly the condition it was designed for.
7. `README.md` documents the collision explicitly: what happens when both are installed, how
   to tell which one ran, and how to pin one.

---

## T6 — Distribution documentation and install instructions

**Effort: S** · **Depends on:** T2, T4, T5

### Files created/changed
- `README.md` — new "Installing the Go binary" section.
- `docs/WINDOWS-SUPPORT.md` — user-facing limitations summary (already created in T3).

### Acceptance criteria
1. `README.md` documents three install paths with copy-pasteable commands: download from
   GitHub Releases (with checksum verification), `go install` (post-T5), and build from
   source via `go/build.sh`.
2. The supported-platform table lists all shipped targets and explicitly names any Windows
   limitation carried forward from T3's analysis (e.g. symlink creation requiring developer
   mode).
3. The concurrency warning required by go-port.md's Phase 1 documentation AC — that no
   locking exists in either implementation and concurrent invocation of either/both binaries
   against the same repo is unsupported — is present and survives into the Phase 3 docs
   (verify it was not dropped during the README rewrite).
4. Checksum-verification instructions are correct: following them verbatim against a real
   published release artifact succeeds.

---

## Success Criteria (epic-level)

- A tagged release produces verified, size-bounded, checksummed binaries for all supported
  targets, built by a committed script that also runs locally.
- CI runs Go tests, TS tests, and the cross-implementation parity suite on every push.
- Windows shipped only behind a documented containment analysis and a passed adversarial
  review — or explicitly and visibly not shipped.
- The `plan-sync-go` → `plan-sync` naming question is closed by a recorded decision, with the
  `$PATH` disambiguation story verified under the exact collision condition it exists for.
- No non-stdlib dependency was introduced anywhere in Phase 3.

---

## Assumptions made (non-interactive dispatch)

- **A1.** Non-Windows target list is taken verbatim from go-port.md Phase 1 AC2
  (`darwin/{amd64,arm64}`, `linux/{amd64,arm64}`). No `linux/386`, `freebsd`, or musl
  variants invented.
- **A2.** CI is GitHub Actions, since `package.json` declares
  `github.com/catesandrew/plan-sync` as the repository and no other CI system is configured.
- **A3.** `windows/arm64` is included alongside `windows/amd64` in T4 for symmetry with the
  POSIX matrix; `windows/amd64` is the one that must pass the smoke test. Drop `arm64` if
  the maintainer prefers a narrower Windows surface.
- **A4.** Release tags are `go-v*`-prefixed, to keep Go-binary releases distinguishable from
  any future TS release tags in the same repo.
- **A5.** npm publishing is out of scope: `package.json` is `"private": true` and Phase 3 is
  scoped to Go packaging in both go-port.md and the beads epic description.
- **A6.** The final module path is `github.com/catesandrew/plan-sync/go` (Go monorepo
  submodule layout), keeping the existing `go/` subdirectory rather than splitting to a
  separate repo — the lower-churn resolution of Follow-up 1.

## Open questions

Tracked in [`.omc/plans/open-questions.md`](./open-questions.md).
