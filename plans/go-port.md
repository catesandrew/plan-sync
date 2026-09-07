# Plan: Go Port of `plan-sync`, Coexisting with the TypeScript Implementation

Status: **pending approval** (consensus mode, RALPLAN-DR deliberate form, non-interactive)
Version: **v3** — targeted revision after a second independent review round (Architect +
Critic, run separately, neither seeing the other's output) both returned **REVISE** on v2:
the mutation-surface re-cut and 7-of-7 call-site enumeration were independently confirmed
correct, but a mandatory Phase 1 Acceptance Criterion required Phase-2-only code (C1), the
AC advertised as "corrected from v1's wrong citations" itself cited the wrong tests for 2 of
4 cases (C2, the same defect class that sank v1, at the identical AC, in round 2 of 5), and
9 further MAJOR findings were confirmed against source (byte-parity behavior stated
backwards, an env-derived recursive-delete path exempted from review, a self-contradictory
decision on Option D, two citation errors in `docs/HARDENING-HISTORY.md` including a git SHA
that does not exist in this repo, and Phase 1 scope gaps). See Changelog for the complete
history of what changed and why.

## Why v2 looks different from v1

v1 proposed phasing the port by *track* (shadow track first, sibling track second), on the
theory that this concentrates review effort on the code that has already been through
adversarial hardening. Both review rounds — independently, using different methods —
demonstrated this was backwards: of the 7 actual `safeWriteFile`/`safeCopyFile`/`safeRemove`
call sites that carry the hardening history's weight, only **2** are in the shadow track
(both in `src/tracks/shadow/restore.ts`); the other **5**, including all 3 `safeCopyFile`
call sites, are in the sibling track (`src/tracks/sibling/push.ts:45,56,159`,
`src/tracks/sibling/pull.ts:64,75`). v1's Phase 1 would have reviewed 2 of 7 call sites and
declared the containment logic "confirmed sound" before the other 5 — plus a second,
untested containment root (`clonePath`, distinct from `omcRoot`) — ever passed the gate. Both
reviewers named this the same way: it reproduces, in a second language, the exact
"missed call site" failure mode `src/safe-write.ts`'s own code comment says caused two prior
hardening rounds in the TS original.

v2 re-cuts the phases along the **mutation-surface axis** instead: Phase 1 now contains
*every* hardened destination-mutation call site plus the full sibling track (which is
porcelain-git-only and adds almost no additional plumbing risk), and defers only the shadow
track's plumbing-heavy, `safe-write`-call-site-free remainder to Phase 2. Both reviewers
also found the plan's "byte-for-byte parity" principle was falsified by the actual source
(wall-clock-dependent `status` output, embedded Node runtime error strings) and that its
central hardening-history claim — the entire justification for deliberate mode and for
Principle 1 — existed nowhere in the repository, making it unverifiable by anyone but the
original authoring session. Both are fixed: parity is now a tiered, achievable bar, and
[`docs/HARDENING-HISTORY.md`](../../docs/HARDENING-HISTORY.md) is a new, durable, file- and
symbol-anchored record written as part of this revision (not merely promised) — **corrected
in v3**: round-2 review found the document's own claim to be uniformly "file:line-anchored"
was itself inaccurate (one wrong anchor, one nonexistent commit SHA), so the document and
this plan now describe it more conservatively, and its own re-verification claim ("verified
by two separate review passes") has been removed since it was circular.

## Requirements Summary

The maintainer asked, exploratively, whether a small-binary, no-Node-runtime Go version of
`plan-sync` was feasible and could coexist with the shipping TypeScript version. That
question was answered affirmatively (Go's stdlib covers the tool's actual needs —
subprocess `git`, filesystem/symlink primitives — with zero external dependencies, and
cross-compiles trivially to small static binaries). The user then invoked `/plan
--consensus` for a full port.

Current TypeScript surface to port (re-verified against actual source for v2, correcting
v1's inaccuracies):

- **CLI commands: 7**, not 8 as v1 stated (`src/cli.ts:15-23`): `init`, `allow`, `unallow`,
  `push`, `pull` (handles both tracks — for `--track shadow` it performs what used to be a
  separate `restore` command), `status`, `uninstall`. All 7 support `--help`/`-h`.
- **Two sync tracks**: Part A (sibling git repo, `src/tracks/sibling/{init,push,pull,status}.ts`,
  ~548 lines, porcelain-git only) and Part B (shadow-ref,
  `src/tracks/shadow/{init,paths,push,restore,status,uninstall,scan}.ts`, ~1147 lines,
  including `GIT_INDEX_FILE`/`hash-object`/`write-tree`/`commit-tree` plumbing).
- **Shared infrastructure**: `src/manifest.ts` (always-live glob manifest, `isPathContained`,
  `resolveManifestSyncCandidates`/`resolveManifestPaths`), `src/safe-write.ts`
  (`safeWriteFile`/`safeCopyFile`/`safeRemove` — the hardened choke point), `src/glob.ts`
  (hand-rolled glob-to-regex + symlink-safe directory walk), `src/root.ts` (configurable
  `--root` directory, `.omc`/`.omx`/`.adlc` auto-detection), `src/repo-root.ts` (`git
  rev-parse --show-toplevel`-anchored root), `src/sync-config.ts` (`.sync-config.json`,
  persisted default track), `src/tracks/shadow/paths.ts` (project-id via root-commit-hash).
- **Test surface**: 177 tests across 29 files (confirmed by running `vitest run`), including
  `test/no-unguarded-writes.test.ts`, a structural regression test whose *intent* — not its
  literal TS-source-scanning implementation — must have a Go equivalent.
- **The actual hardening history**: 5 rounds, now durably recorded in
  [`docs/HARDENING-HISTORY.md`](../../docs/HARDENING-HISTORY.md), including 3 explicitly
  accepted, currently-unfixed follow-ups (F1/F2/F3) that a port must carry forward as known
  issues, not silently re-ship as if they were fresh, issue-free code.

## RALPLAN-DR Summary

**Principles**
1. **Security parity is gated against a checkable record, not an assertion.** The Go port's
   containment logic (`safeWriteFile`/`safeCopyFile`/`safeRemove` equivalents) must close
   every finding `docs/HARDENING-HISTORY.md` assigns to it — **corrected in v3**: each
   finding is re-verified against **current source**, not against the document's own line
   numbers, which are hints to re-locate rather than a guarantee (the document itself no
   longer claims uniform file:line precision, after round-2 review found one wrong anchor)
   — including empirically re-verifying every runtime-primitive assumption the TS fixes
   depend on (Go's `os.Lstat`/`filepath.EvalSymlinks` are not guaranteed to match Node's
   `fs.lstatSync`/`fs.realpathSync` in every edge case; see Pre-mortem 1).
2. **No new runtime dependency for the core value proposition.** Stdlib only
   (`os/exec`, `flag`, `path/filepath`, `os`, `crypto/sha256`, `regexp`) — independently
   confirmed achievable for this codebase: `src/tracks/sibling/status.ts`'s `sha256` maps
   directly to `crypto/sha256`, and all four `src/tracks/shadow/scan.ts` regexes use no
   lookaround/backreferences and compile under Go's RE2 engine.
3. **Coexistence means zero coupling, but shared on-disk/on-remote formats as a correctness
   requirement.** The two implementations share no code or build step, but a repo synced by
   one must be fully operable by the other: same manifest syntax, same `.sync-config.json`
   shape, same shadow-ref name (including the dot-stripped root segment,
   `refs/plan-sync/<project-id>/<root-without-dot>/data` — `src/root.ts:95-97`,
   `src/tracks/shadow/paths.ts:61`), and — critically, since it has **two structurally
   different branches** (`src/tracks/shadow/paths.ts:46-51`) — the exact same local
   shadow-repo path shape under both the `PLAN_SYNC_STATE_DIR`-set and
   `${XDG_CACHE_HOME:-$HOME/.cache}`-fallback cases, including the differing filename/nesting
   between them.
4. **Parity is tiered, not uniform, and each tier's bar is independently achievable** —
   corrected from v1's single, self-contradicting "byte-for-byte... same shape" principle,
   which both reviews confirmed is falsified by wall-clock-dependent `status` output
   (`src/tracks/shadow/status.ts:61-63,217-234`) and by Node-runtime error strings embedded
   in multiple error paths (`src/cli.ts:65-66`; `src/tracks/sibling/pull.ts:91-95`
   *unconditionally*; `src/tracks/shadow/{restore,push,uninstall}.ts`'s stderr-fallback
   branches). See **Parity Tiers** below for the corrected, three-tier definition.
5. **Phase around the mutation-surface axis, not the feature/track-count axis** — corrected
   from v1's track-based cut, which both reviews independently showed inverts its own stated
   purpose (2 of 7 hardened call sites in Phase 1; 0 of 3 `safeCopyFile` sites). Noted in
   round-2 review as more of a phasing *decision* than an independent principle (it exists to
   select Option B′ over A/B and is inapplicable under Option D) — retained here as a
   principle since the RALPLAN-DR structure expects Principles to justify the recommended
   option, but its actual justification lives in the Option B′ vs. A tradeoff in the ADR, not
   in an independent rationale of its own. This axis is now operationalized narrowly as
   "has a `safe-write` call site," which is why the Phase 2 containment-review scope needed
   a v3 correction (see "Why v2 looks different" is superseded by this document's own
   Changelog, and the Option B′ description above) — `shadow/uninstall.ts`'s recursive delete
   is a real destination mutation with no `safe-write` call site, so it fell through this
   axis's definition even though it should have been in scope for review.

**Parity Tiers (replaces v1's Principle 4)**

- **Tier 1 (strict, byte-identical, gating)**: on-disk artifacts — manifest file bytes,
  `.sync-config.json` bytes; on-remote artifacts — shadow ref name, `git ls-tree` output of
  that ref, blob SHAs; local state — shadow-repo path (both branches), synced file content;
  process contract — exit codes. A parity-suite failure on any Tier 1 dimension blocks the
  phase.
- **Tier 2 (structural, gating with named exclusions)**: stdout output matches a shared,
  declared set of format templates, with explicitly normalized-out fields: `status`'s
  human-readable age token (`formatAge` output — compare the underlying ISO timestamp
  instead, which *is* deterministic) and any subprocess-error-detail fragment (compare that
  *a* clear error occurred and mentions the failing operation, not its exact text).
- **Tier 3 (explicitly non-parity, documented, not tested for equality)**: any error text
  whose exact wording originates from the host runtime itself (Node's `Error.message`
  formatter, `execFileSync`'s `"Command failed: ..."` fallback, vs. Go's
  `exec.ExitError.Error()`). Both implementations must surface a **clear, non-empty error
  referencing the failing command/path** on the same failure conditions — the literal text is
  not required to match and is not achievable without hand-transcribing Node's internal
  formatter into Go, which is not a goal.

Under this correction, v1's Option C (relaxed stdout/error parity, strict on-disk parity) is
no longer a distinct, rejectable alternative — it *is* what Tiers 1–3 already specify. It is
folded into the corrected principles rather than kept as a separately-scored option.

**Decision Drivers (top 3)**
1. **Security-hardening parity against the checkable record in `docs/HARDENING-HISTORY.md`**,
   independently re-verified for the Go port's actual runtime primitives — not assumed by
   analogy to Node's behavior.
2. **Cross-implementation on-disk/on-remote compatibility** (Parity Tier 1) — since
   "coexist" means either binary may run against the same repo, and the two most likely
   collide on `$PATH` under the same command name (see Risks table, `$PATH` collision row).
3. **Minimal footprint** (stdlib-only, small cross-compiled binaries) — the core motivating
   driver. A fairly-scored alternative (Option D, below) does not achieve this driver
   (measured: 60MB vs. this plan's ~15MB target) but is **not eliminated** by it or any other
   principle — see Option D's entry for the corrected, non-contradictory framing (v3): the Go
   port proceeds because the user's request named Go explicitly, not because Driver 3 forces
   it.

**Viable Options**

- **Option A — Full port in one pass.** All 7 commands, both tracks, full shared
  infrastructure, ported and reviewed together as a single, complete, frozen mutation
  surface.
  - *Pros*: a single adversarial review pass sees the **entire** mutation surface at once —
    the only condition under which a `no-unguarded-writes`-equivalent structural check is
    load-bearing rather than partially vacuous; no interim "which binary supports what"
    confusion; matches the literal "full port" request.
  - *Cons*: a large, single diff (~1700 lines) dilutes per-line reviewer attention; no
    interim shippable artifact if the review finds something that needs rework.

- **Option B (v1, superseded) — Phased by track.** Rejected in v2: demonstrated by both
  review rounds to invert its own stated risk-concentration purpose (see "Why v2 looks
  different," above). Retained here only as the alternative *this plan itself* previously
  chose and had to walk back, per this skill's requirement to show invalidation rationale
  for rejected alternatives.

- **Option B′ — Phased by mutation-surface axis (recommended).** Phase 1 = the
  **complete** containment surface: `safe-write`, `manifest`, `glob`, `root`, `repo-root`,
  `sync-config` (full library API, including `addToManifest` — which `restore`'s
  manifest-merge depends on, so it cannot be deferred independently of the `allow` command
  that also uses it) + the full sibling track (`init`/`push`/`pull`/`status` — porcelain-git
  only, all 5 non-shadow `safe-write` call sites live here; `allow`/`unallow` are corrected
  in v3 to be described accurately — they are track-agnostic commands in `src/commands/`, not
  sibling-track files, but are equally in Phase 1 scope) + the shadow track's `restore` (the
  other 2 call sites) + `init` (included as a necessary
  test-fixture dependency for exercising `restore` end-to-end against a real shadow repo —
  and, as clarified in v3, it also ships and is CLI-wired in Phase 1, see the dedicated AC
  below — not because it is itself hardened code in the `safe-write` sense; `shadow/init.ts`
  has zero `safe-write` call sites, but it does have two raw filesystem mutations that are
  reviewed under a separate, scoped gate, below). Phase 2 = the shadow track's remaining
  plumbing (`push`/`status`/`uninstall`/`scan`), which has **zero** `safe-write` call sites
  and is verified by construction (tree/blob-SHA diffing) for its git-plumbing logic —
  **corrected in v3**: this does *not* extend to `shadow/uninstall.ts`'s
  `fs.rmSync(shadowRepoPath, {recursive:true, force:true})` on an environment-derived path
  (`src/tracks/shadow/uninstall.ts:36`) or `shadow/push.ts`'s temp-directory cleanup, neither
  of which is a git-plumbing correctness question that tree/blob-SHA diffing can verify.
  Round-2 review reproduced a live one-directory-level escape reachable through this exact
  code path (see Risks table, `--root "..."` row) — the "no adversarial review needed" framing
  is struck for these two call sites specifically; Phase 2's acceptance criteria must include
  a scoped containment gate covering them, even though the rest of Phase 2 remains
  construction-verified. Phase 3 = packaging/cross-compilation/release, with Windows treated
  as its own explicitly gated sub-phase (see Risks table) rather than bundled into Phase 1's
  cross-compilation acceptance criterion.
  - *Pros*: the adversarial review gate sees **all 7** hardened call sites and both
    containment roots (`omcRoot`, `clonePath`) before anything is declared sound; the
    shippable Phase 1 artifact fully supports the sibling track — the tool's own
    *recommended* track for team use — rather than only the narrower, single-writer shadow
    track; Phase 2's remaining risk is verifiable by construction, not by another subjective
    review pass.
  - *Cons*: Phase 1 is a somewhat larger diff than v1's Phase 1 was; the shadow track (the
    literal answer to "how does `bd dolt push` do this?" that motivated this whole project)
    isn't fully usable end-to-end until Phase 2.

- **Option D — Single-file executable of the existing TypeScript (Node SEA or `bun build
  --compile`), not a Go port at all.** Added in v2 after both reviews independently noted it
  was missing from v1's option space, given `package.json` already declares **zero runtime
  dependencies** — every `devDependency` is build/test tooling, every `src/` import is
  `node:*` or relative, so there is nothing to bundle and no second implementation of the
  containment logic to get wrong. **Measured in v3** (round 2 review found v2's size figure
  was an unmeasured ballpark, cited to a Verification Step that didn't actually contain it):
  `bun build --compile src/cli.ts` produces a working, verified-functional (`--help` runs
  correctly) **60MB** binary — a real number, not a range, replacing v2's "50–110MB, not
  session-measured" claim.
  - *Pros*: perfectly satisfies Decision Driver 1 (security parity) **for free** — it is the
    same, already-5-round-hardened code, not a re-derivation; ships fastest (effort:
    single build-tooling change, order-of-hours, not the multi-week effort Phase 1–3 of the
    Go port represents — see Sizing); zero cross-implementation format-compatibility risk
    (Decision Driver 2) since there is only one implementation.
  - *Cons*: does **not** satisfy Decision Driver 3 — 60MB measured vs. this plan's ~15MB Go
    target, a 4x gap (corrected from v2's unmeasured "5-20x"), and Driver 3 (minimal
    footprint) is the one dimension the user's original exploratory question named explicitly
    as a motivation ("small binary... no Node runtime dependency"). Also: Node's Single
    Executable Application feature is explicitly experimental (Node's own docs mark SEA
    unstable), while `bun build --compile` is a stable, documented feature of a
    non-Node-project-governed runtime — these are not interchangeable fallbacks, and the
    measurement above used `bun`, not Node SEA. Cross-compilation is also asymmetric: `bun
    build --compile --target=<platform>` can target other OS/arch combinations from one
    machine (matching this plan's Phase 1 AC2 requirement), but Node SEA cannot without the
    target platform's actual `node` binary present — Option D is not held to the same
    cross-compilation criterion Phase 1 gates the Go port on, and should be, before being
    treated as a like-for-like fallback. Does not produce an independent second-language
    implementation, which may carry standalone value (architecture diversity, a from-scratch
    security re-derivation exercise) beyond pure practicality — a value judgment only the
    maintainer can make, not one any stated principle resolves.
  - **Corrected self-contradiction (round-2 finding, blocking in v2):** v2 simultaneously
    claimed, in Decision Driver 3, that Option D "does not achieve" the driver and is
    therefore "why it isn't simply adopted instead" (a rejection-on-driver), while also
    stating in this option's own entry that it is "not eliminated by any stated principle."
    Both cannot be true. **Resolved plainly in v3**: Option D is **not** eliminated by any
    stated principle or driver — Driver 3 states a real, measured tradeoff (60MB vs. 15MB),
    not a disqualification. The Go port is this plan's chosen direction because **the user's
    own request named Go specifically**, not because any principle forces it — this is an
    explicit, non-principle-derived preference, stated as such rather than dressed up as a
    driver-forced conclusion. Option D is recorded as the fastest, zero-security-re-derivation
    fallback if the Go port's Phase 1 adversarial gate finds something genuinely hard to
    close (see Rollback, below).

**Recommendation: Option B′, with Option D recorded as the explicit fallback if Phase 1's
gate does not pass.** Neither review round rejects the idea of a Go port; both reject the
specific phase boundary and the parity principle v1 used to justify it. B′ preserves v1's
real insight (narrow, focused review beats one broad pass — this project's own hardening
history is direct evidence) while fixing the specific inversion both reviews demonstrated.

## Pre-mortem (deliberate mode, revised)

**Scenario 1 (revised) — Go's error classification silently converts a fail-closed check
into fail-open.** This is the single most important, previously-unstated risk, surfaced by
the Critic review's own investigation and now the pre-mortem's primary scenario (v1's
version of this scenario asked a question and then answered it mid-sentence without
identifying the actual hazard). `src/safe-write.ts`'s containment check depends on
`fs.lstatSync(path, {throwIfNoEntry:false})` suppressing **only** `ENOENT` — it still throws
on `ENOTDIR`, `EACCES`, `ELOOP`, and those throws propagate to the outer catch, which fails
closed (treats the path as unsafe). Go's `os.Lstat` returns an ordinary `error` value for
**all** of these cases with no built-in distinction. A Go port written with the natural,
unexamined pattern `if err != nil { treat as absent, keep walking up }` silently converts
the fail-**closed** `ENOTDIR`/`EACCES`/`ELOOP` case into fail-**open** — reopening exactly
the class of gap `docs/HARDENING-HISTORY.md` round 3 exists to prevent, in code that would
otherwise look like a faithful, careful port. **Mitigation**: the Go containment check must
explicitly branch on `errors.Is(err, fs.ErrNotExist)` vs. every other error class, and a
dedicated unit test must simulate an `EACCES`/`ENOTDIR` condition and assert the path is
treated as unsafe, not merely "did not throw."

**Scenario 2 (retained, strongest analytical content in v1, unchanged) — Cross-implementation
drift breaks a repo silently.** A team with one developer on the TS binary and another on
the Go binary, both named `plan-sync`, pointed at the same repo. If glob semantics diverge
even slightly (see Risks table, glob-engine-divergence row), the same manifest line resolves
to a *different* file set depending on which binary last ran `push`/`status` — silently
syncing different content with no error, no warning, and no detection short of noticing a
file didn't show up. Worse than either implementation having a bug alone, because it's
asymmetric and intermittent.

**Scenario 3 (revised) — The port is declared done on a green test suite, without the
adversarial review the TS version's own history shows was actually necessary.** v1's version
of this scenario restated known TS process history as a generic argument for reviews being
good; v2 makes it concrete and falsifiable: the TS suite's 177 tests did **not** catch
findings 5–12 in `docs/HARDENING-HISTORY.md` — those required a dedicated Architect/Critic
pass specifically probing for bypasses the test suite's own author hadn't thought to write.
A Go port whose completion criterion is "`go test ./...` is green" (with no independent
adversarial pass, run separately from whoever wrote the port) will very likely ship with an
undiscovered instance of the same bug class the TS version had at every one of its first
four review rounds. **Mitigation**: the Architect+Critic gate (Acceptance Criteria, below)
is mandatory and has an explicit, falsifiable pass bar — not "reviewer discretion."

## Acceptance Criteria — Phase 1 (mutation-surface core, Option B′)

- [ ] A Go module (final import path/repo-layout decision — `go/` subdirectory in this repo
  vs. a separate repo — is Follow-up 1, not blocking Phase 1's start) builds a `plan-sync-go`
  binary (see `$PATH`-collision decision, below — **not** named `plan-sync` yet) via `go
  build`, with `go list -m all` showing no non-stdlib dependency.
- [ ] `GOOS=darwin GOARCH=arm64/amd64` and `GOOS=linux GOARCH=amd64/arm64` cross-compile
  successfully from one macOS development machine, each producing a binary under 15MB
  (`-ldflags="-s -w"`, verified via `ls -lh`). **`GOOS=windows` is explicitly deferred to
  Phase 3's own gated sub-phase** (see Risks table) — Windows symlink/junction semantics,
  developer-mode symlink-creation privilege requirements, and case-insensitive-filesystem
  containment-check behavior are all materially different from POSIX and are not validated
  by this AC.
- [ ] The Go implementation of `safeWriteFile`/`safeCopyFile`/`safeRemove`-equivalent
  functions closes every containment-related finding in
  [`docs/HARDENING-HISTORY.md`](../../docs/HARDENING-HISTORY.md) that those functions
  themselves own — **re-scoped in v3** to findings **3, 4, 6, 7, 8, 11, 12** (not 6–12:
  finding 3, manifest path traversal via `isPathContained`, and finding 4, symlink
  dereference on push's read side, both live in `src/manifest.ts`/track push code that is
  squarely Phase 1 scope and were wrongly excluded from the v2 range), each independently
  re-verified against Go's actual stdlib runtime behavior (not assumed by analogy) —
  explicitly including Pre-mortem 1's `ENOTDIR`/`EACCES`/`ELOOP` classification requirement.
  Additionally, Go's `isPathContained` equivalent must be verified against Windows-shaped and
  UNC-shaped inputs (e.g. `C:\...`, `\\server\share\...`) even though Windows support itself
  is deferred to Phase 3, because `filepath.IsAbs` does not treat those as absolute on a
  non-Windows build — a manifest line shaped like a Windows path could silently pass the
  containment check on a POSIX build if this isn't explicitly tested.
- [ ] Findings **9** (`process.cwd()` vs. `git rev-parse --show-toplevel` anchoring,
  `src/repo-root.ts`) and **10** (missing-vs-empty manifest distinction, `manifestExists()`
  in `src/manifest.ts`) are separately verified in Phase 1, since both modules are in Phase 1
  scope but neither finding is a `safe-write` containment concern: Go's repo-root resolution
  must use the equivalent of `git rev-parse --show-toplevel`, never a raw current-working-
  directory primitive, and Go's manifest-existence check must distinguish "file absent" from
  "file present and empty" the same way `manifestExists()` does.
- [ ] Corrected in v3, re-verified line-by-line against the actual test file (v2's own
  citations for cases (c) and (d) were still wrong despite v2's changelog claiming this was
  fixed — the same defect class that sank v1, caught by round-2 review at the identical AC,
  in round 2 of 5): the Go unit suite covers, with citations re-verified against current
  source — (a) live symlink at destination (`test/safe-write.test.ts:28-36`), (b) live
  symlinked ancestor at *immediate parent* depth, one case per operation
  (`test/safe-write.test.ts:38-46` safeWriteFile, `:81-91` safeCopyFile, `:117-127`
  safeRemove), (c) fail-closed on `ENOTDIR`/regular-file-as-ancestor, one case per operation
  (`test/safe-write.test.ts:59-68` safeWriteFile, `:93-101` safeCopyFile, `:139-144`
  safeRemove — **not** `:81-91,117-127`, which are the symlinked-ancestor cases in (b) and
  contain no `ENOTDIR` scenario at all), (d) absent-path no-op for remove
  (`test/safe-write.test.ts:105-108` — **not** `:139-144`, which is the fail-closed
  regular-file-ancestor case in (c)) — **plus two genuinely new cases that do not exist at
  the unit level in either language today** and must be added to **both** the TS and Go
  suites as part of this phase: (e) a **dangling** symlink specifically **at the
  destination** (today only covered at integration level, as a symlinked *ancestor*, not the
  destination itself — `test/tracks/shadow/restore.test.ts:239`, titled "a DANGLING symlink
  at a manifest-listed destination path is not silently created-through by restore" — and at
  the unit level only as a dangling mid-path *ancestor*, one case per write/remove operation:
  `test/safe-write.test.ts:48-57` safeWriteFile, `:129-137` safeRemove; there is no dangling-
  ancestor unit case for safeCopyFile today either, and one should be added alongside (e)),
  and (f) a live symlinked ancestor at path **depth ≥2** where the immediate parent doesn't
  exist on disk (today only covered as an immediate-parent symlink per (b) above; covered at
  integration level at `restore.test.ts:268`). Additionally, strengthen the dangling-ancestor
  fail-closed tests (`:48-57,129-137`) and the regular-file-ancestor fail-closed tests in (c)
  above, which today assert only `not.toThrow()` (or, for `safeWriteFile`'s regular-file
  case, `not.toThrow()` plus a `false` return), to also assert that any outside content
  survived unchanged where applicable — in **both** languages. The genuine no-op test (d)
  already asserts `toBe(true)`; it needs no strengthening, only the citation fix above.
- [ ] Project-id derivation (root-commit-hash, first 12 hex chars, lexically-sorted if
  multiple roots) produces the identical string as the TS implementation, verified both (a)
  against a normal single-root-commit repo and (b) against a fixture repo with two root
  commits joined via `git merge --allow-unrelated-histories` (v1's AC omitted case (b)
  entirely, so the lexical-sort tie-break was never exercised).
- [ ] The manifest file format and `.sync-config.json` shape are read/written identically by
  both implementations, verified by procedures that actually exercise Phase 1 writers on the
  path that reaches them (v1's AC used `push`/`status`, which never write the manifest at
  all; v2's AC pointed the removal-byte requirement at a merge path that never calls the
  removal function it was testing — **corrected in v3, re-derived by executing the actual
  algorithm**):
  - **Additive-merge byte parity** (`addToManifest`-equivalent, reached via `pull --track
    shadow`'s manifest-merge step, `src/tracks/shadow/restore.ts:108,133`): TS `allow` on one
    machine's clone → construct the ref's manifest blob directly via git plumbing in the test
    (since `push` is Phase 2) → Go `pull --track shadow` merges the incoming manifest via its
    `addToManifest` equivalent → assert the resulting local manifest file is byte-identical
    to the TS implementation's output for the same merge, **including
    `addToManifest`'s `needsLeadingNewline` edge case** (`src/manifest.ts:138-141`: a leading
    newline is inserted only when the existing file is non-empty and does not already end in
    `\n`) — this is the actual byte-edge-case on this path, and is currently uncovered.
  - **Removal byte parity** (`removeFromManifest`-equivalent — note this function has no
    merge-path caller; its only callers are `unallow`, `src/commands/unallow.ts:54,74`): TS
    `unallow` → Go `unallow` → byte-diff the manifest file. The actual behavior
    (`src/manifest.ts:236,251`: `contents.split("\n")`, filter out the matched line, then
    `writeFileSync(kept.join("\n"))`) is **not** "drops the trailing newline when the last
    line is removed" as v2 stated — executing it shows the trailing newline is **preserved**
    in the ordinary multi-entry case (`split` yields a trailing empty-string element that
    survives the filter, so `join` reintroduces it), and the file becomes **zero-length**
    only in the degenerate case where the removed entry was the sole remaining line. Both
    the multi-entry (newline-preserved) and single-entry (file-emptied) cases must match
    byte-for-byte between implementations.
- [ ] `.sync-config.json` byte-shape parity (net-new in v3 — Tier 1, previously ungated): TS
  writes via `JSON.stringify(config, null, 2) + "\n"` (`src/sync-config.ts:79`), which
  appends a trailing newline and preserves insertion-order keys. Go's `json.MarshalIndent`
  does neither by default (no trailing newline; struct-field order, not insertion order). The
  Go writer must explicitly match both: append the trailing newline, and order keys to match
  the TS struct's field order (or serialize to a stable, explicitly-ordered map). Verify by
  byte-diffing a config file written by each implementation for the same logical config.
- [ ] `readManifest`'s skip-and-warn behavior on an out-of-bounds line (traversal or absolute
  path in a hand-edited manifest, `src/manifest.ts:96-104`, finding 3's read-side half) is
  ported with matching behavior: the offending line is dropped, parsing continues for the
  remaining valid lines, and a warning referencing the offending line is written to stderr
  (Tier 2 parity — the exact wording need not match, but a warning must appear and must name
  the rejected entry).
- [ ] The shadow-track ref name and **both** local shadow-repo path branches
  (`PLAN_SYNC_STATE_DIR`-set vs. `${XDG_CACHE_HOME:-$HOME/.cache}` fallback — these have
  different filenames and nesting, not just different roots) are identical between
  implementations, verified by exercising both branches, not just the default one.
- [ ] **Net-new in v3, addressing a reproduced live escape (see Risks table, `--root "..."`
  row)**: `rootSegment`'s output (`src/root.ts:95-97`) is re-validated — not just
  `validateRoot`'s input (`src/root.ts:72-87`) — before it is used as a filesystem path
  segment or a git refname segment, in **both** languages. Reproduced against the current TS
  implementation: `validateRoot("...")` accepts the value (it is not `.`, not `..`, has no
  separators), but `rootSegment` then strips one leading dot and returns `".."`, which
  escapes one directory level under `PLAN_SYNC_STATE_DIR` and produces an invalid git
  refname. The Go port must reject this at the same point the TS fix does (whichever is
  landed first per Follow-up 2 below), not merely inherit the current TS behavior unexamined.
- [ ] A structural regression check exists in the Go test suite with an explicit,
  named mechanism (corrected from v1, which offered three non-equivalent options with no
  pass criterion; extended in v3 to close a gap Architect round 2 found in the mechanism
  itself): a single package (e.g. `internal/safewrite`) is the sole allowed importer of any
  raw file-mutating stdlib call — `os.WriteFile`, `os.Remove`, `os.RemoveAll`, `os.Rename`,
  `os.Create`, `os.OpenFile` (opened with any write-capable flag), `io.Copy`-to-a-file-
  destination — enforced by a test that scans every *other* package and fails on a match,
  with an explicit allowlist mirroring `test/no-unguarded-writes.test.ts:32-48`'s exemptions
  (documented reasons required for each entry, e.g. a temp-directory-scoped write). This is a
  **stricter** scope than the TS original (which only scans `src/tracks/` and whose forbidden-
  pattern list omits `appendFileSync`/`renameSync`, per F2) — deliberately, since the port is
  new code with no legacy scope constraint.
- [ ] The glob-matching engine divergence (Risks table) is closed, not merely tested against
  a fixed pattern list: **decided in v3** — both implementations adopt a hand-written,
  host-engine-independent segment matcher (v2 left this as an undecided either/or against a
  second option that does not actually close the gap: character-class validation alone does
  nothing about `?`, which `src/glob.ts:45-48` compiles to `[^/]`, matching one UTF-16 code
  unit in JS's non-`u`-flagged `RegExp` but one rune in Go's RE2 — the primary divergence the
  risk row identifies). Pass criterion: a shared, documented segment-matcher spec, implemented
  independently (not shared code) in both languages, verified by a test corpus covering
  non-BMP filenames (emoji, CJK extension-B), POSIX bracket classes (`[[:alpha:]]`), and
  backslash-escaped characters inside a bracket expression. This requires a scoped,
  explicitly-tracked change to the **existing, shipping TS `src/glob.ts`** as part of this
  phase, not only new Go code — see Consequences in the ADR for the release/regression
  implication of that change.
- [ ] **Observability parity, Phase 1 portion — corrected in v3.** v2's version of this AC
  required the full `test/e2e/observability.test.ts` scenario, which needs `push --track
  shadow` (`:103,:129`) and `status --track shadow` (`:105,:146,:154`) — both Phase 2
  commands under this plan's own phase cut — making the AC unsatisfiable inside Phase 1
  without either collapsing the phase boundary or silently dropping the AC (the plan's own
  Verification Steps → Integration bullet already reasons correctly about this same
  constraint for `restore`'s fixture-ref approach; that reasoning was not applied here in
  v2). Phase 1's portion is only what Phase 1 can produce: `pull --track shadow` against an
  unreachable-origin or corrupt fixture ref exits non-zero with non-empty stderr and leaves
  local files untouched (no partial write).
- [ ] **Observability parity, Phase 2 portion (moved from v2's Phase 1 AC — inherited scope,
  not new).** Phase 2's acceptance criteria must include: an unreachable shadow-track
  `origin` causes `push` to exit non-zero with non-empty stderr, the real remote ref is left
  untouched, `status` still reports the last known-good push accurately, and `--stale-after
  0h` correctly flags it STALE, verified against the Go port of
  `test/e2e/observability.test.ts`, with Tier 2 parity on the resulting `status` staleness
  signal — noting that the STALE line itself (`src/tracks/shadow/status.ts:66-70`) carries no
  ISO timestamp to normalize against (that only appears on the preceding `last push` line,
  `:63`); Tier 2 parity on the STALE line means comparing only the literal `STALE` marker
  text, not a timestamp.
- [ ] **Phase 1 file scope, stated explicitly (net-new in v3 — v2's scope prose omitted
  modules its own ACs require).** Phase 1 ports: `src/safe-write.ts`, `src/manifest.ts`,
  `src/glob.ts`, `src/root.ts`, `src/repo-root.ts`, `src/sync-config.ts`,
  `src/tracks/shadow/paths.ts` (imported by `restore.ts:14`; required by the project-id and
  shadow-repo-path ACs above), the full sibling track
  (`src/tracks/sibling/{init,push,pull,status}.ts`), `src/tracks/shadow/{init,restore}.ts`,
  `src/args.ts` (`hasHelpFlag`, `parseTrack`, `parseFlag`), `src/cli.ts` (`dispatch`,
  `USAGE`), and all six command-dispatch modules
  (`src/commands/{init,allow,unallow,push,pull,status}.ts` — **not** `uninstall.ts`, whose
  shadow branch has no Phase 1 implementation to dispatch to). The Go `plan-sync-go` binary
  ships all six of these commands in Phase 1: for `push`/`status`, the `--track sibling`
  branch is fully functional and the `--track shadow` branch returns a clear "not available
  until Phase 2" error (added to the Tier 1 exit-code parity set — both implementations must
  agree this specific case exits non-zero with a stderr message referencing Phase 2); there
  is no `uninstall` command in the Phase 1 binary at all (not even a stub), since the TS
  `uninstall` command has no sibling-track-only path to fall back to.
- [ ] **`shadow/init.ts`'s role, stated explicitly (net-new in v3 — v2 left this genuinely
  ambiguous across three axes, per round-2 review).** `shadow/init.ts` **ships and is
  CLI-wired** in the Phase 1 binary (`plan-sync-go init --track shadow` creates real local
  shadow-repo state, matching TS behavior) — it is not fixture-only test scaffolding, despite
  having zero `safe-write` call sites itself (it does have two raw mutations,
  `fs.mkdirSync`/`fs.writeFileSync`, which is why it is one of the three entries on
  `test/no-unguarded-writes.test.ts:32-48`'s allowlist that the structural-check AC above
  requires the Go check to mirror). It is **inside** the adversarial gate's scope for that
  reason. This creates a known, explicitly-documented Phase 1 limitation, not a silent gap: a
  user can run `init --track shadow` in Phase 1 and create real local + (once pushed by a TS
  binary or a fixture) remote shadow state that Phase 1's Go binary cannot yet `push`,
  `status`, or `uninstall` — Phase 1's CLI help text and the `push`/`status` stub-error
  messages above must say so explicitly, so this is discoverable rather than surprising.
- [ ] A dedicated Architect + Critic adversarial review pass (sequential, per this skill's
  own protocol, run separately from whoever authored the port) is performed against Phase
  1's actual Go code, with an explicit pass bar (corrected from v1, which left this
  undefined): **zero CRITICAL findings**, and every MAJOR finding either fixed or explicitly
  logged with an owner and rationale in a follow-up ledger (mirroring
  `docs/HARDENING-HISTORY.md`'s own F1/F2/F3 pattern) before Phase 1 is considered complete.
- [ ] The `$PATH`-collision risk (Risks table) is resolved by an explicit decision, not
  deferred: the Go binary is named `plan-sync-go` throughout Phases 1–2; both
  implementations emit a one-line identity marker to stderr on every mutating command (e.g.
  `plan-sync: go/0.1.0` vs. `plan-sync: ts/0.1.0`); renaming the Go binary to the shared
  `plan-sync` name is an explicit Phase 3 gate, contingent on the full cross-implementation
  Tier-1/Tier-2 parity suite passing. Note: this is a user-visible stderr behavior change to
  the **shipping TS binary**, not just new Go code — verified against the current suite (no
  test asserts exact or empty stderr, only `toContain`, so this does not break the existing
  177-test suite), but it should land as an explicit, reviewed line item in the TS
  implementation, not as a side effect of a naming decision buried in this plan.
- [ ] **Net-new in v3 (blocking — the Risks table row states this is a Phase 1 precondition
  but v2 left it ungated).** Empirically probe case-sensitivity/canonicalization behavior on
  the stated macOS development platform before Phase 1's containment logic is considered
  verified there: `src/safe-write.ts:53`'s containment check
  (`realDir === realRoot || realDir.startsWith(realRoot + path.sep)`) is case-**sensitive**,
  but Node's `fs.realpathSync` returns macOS's on-disk canonical casing while Go's
  `filepath.EvalSymlinks` does lexical resolution plus `readlink` and does not canonicalize
  case — a test must exercise a path whose on-disk casing differs from the manifest-entry
  casing on a case-insensitive-but-case-preserving filesystem (the macOS APFS default) and
  assert both implementations agree on the containment verdict.
- [ ] A `>100MB` blob during shadow-restore (`src/tracks/shadow/restore.ts:204`,
  `maxBuffer: 100*1024*1024` — a **Phase 1** call site, since `restore` is Phase 1) is a hard,
  explicit failure in TS with no direct Go analogue (`exec.Cmd.Output()` buffers unbounded by
  default). The Go port must implement an equivalent explicit bound, with a test using a blob
  at/over the boundary in both implementations, as part of Phase 1 — not deferred.
- [ ] **Net-new in v3.** Before Phase 1's gate closes, an explicit, owned decision is
  recorded on whether F1 (`safeRemove` not directory-safe), F2 (structural test's
  narrower-than-assumed scope), and F3 (hardlink write-through) — all in
  `docs/HARDENING-HISTORY.md` — apply to the Go implementation and, if they do, whether they
  are fixed in TS first, Go first, or simultaneously (this is Follow-up 2 below, but must be
  *decided*, not merely *checked*, before Phase 1 is considered complete — F1 in particular
  is a live uncaught-throw crash in currently-shipping code, not a hypothetical).
- [ ] **Net-new in v3, documentation-level only (not a design/locking AC — that remains
  Follow-up 3).** Since shipping two same-purpose binaries during the coexistence window
  makes simultaneous invocation against the same repo *more* likely, not less (Risks table),
  Phase 1's README/usage docs must carry an explicit, user-facing warning that no locking
  exists in either implementation and concurrent invocation of either/both binaries against
  the same repo is unsupported — this is the minimum bar to ship the coexistence window
  honestly, independent of whether/when the real design in Follow-up 3 lands.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Go's error classification silently converts a fail-closed containment check into fail-open (Pre-mortem 1) | Explicit `errors.Is(err, fs.ErrNotExist)` branch, with a dedicated unit test simulating `EACCES`/`ENOTDIR` and asserting fail-closed — not merely "did not throw" |
| Glob engine divergence: `globToRegExp` (`src/glob.ts:21-71`) builds a regex **source string** consumed by the *host language's own engine* — JS's UTF-16-code-unit `RegExp` vs. Go's rune-based RE2 — so even a literal line-by-line translation diverges on non-BMP characters (emoji, CJK extension-B) in filenames, and unescaped character-class passthrough (`glob.ts:51-66`) means the manifest's glob dialect is implicitly defined by whichever engine runs it. Confirmed the mechanism is not limited to character classes: `?` compiles to `[^/]` (`glob.ts:45-48`), matching one UTF-16 code unit in JS vs. one rune in RE2 | **Decided in v3**: both implementations adopt a hand-written, engine-independent segment matcher (see Acceptance Criteria) — a documented character-class-validation-only alternative was considered and rejected, since it does not address the `?`/rune divergence, which is the primary mechanism, not an edge case of it. Do not rely on a fixed cross-implementation pattern-list test alone — that only catches divergences someone thought to include, which is the exact blind spot Pre-mortem 2 describes |
| Two same-named `plan-sync` binaries (`npm link`'d TS vs. a hypothetically `go install`'d Go one) collide on `$PATH`, and a user can't tell which one ran a given command | Decided now, not deferred (see Acceptance Criteria): Go binary is `plan-sync-go` through Phases 1–2; both implementations print a stderr identity marker on every mutating command; renaming to the shared name is an explicit, gated Phase 3 decision |
| The three known, currently-unfixed TS follow-ups (F1: `safeRemove` not directory-safe; F2: structural test's narrower-than-assumed scope; F3: hardlink write-through — all detailed in `docs/HARDENING-HISTORY.md`) get silently re-shipped in "new" Go code as if it had no known issues | An explicit, owned applicability-and-sequencing decision is required before Phase 1's gate closes (see Acceptance Criteria) — not merely "checked": some may not apply, given different stdlib primitives (e.g. F1's Go analogue, `os.Remove` on a non-empty vs. empty directory, is a **different** failure shape than Node's `EISDIR` and must be independently decided, not assumed inherited) |
| Windows containment semantics (symlink/junction behavior, developer-mode privilege requirement for creating symlinks at all, case-insensitive-filesystem containment-check comparisons) are materially different from the POSIX assumptions every current containment fix depends on | Windows is explicitly **out of Phase 1's acceptance criteria** and is its own gated sub-phase in Phase 3, with its own containment analysis and its own adversarial review pass — not bundled into Phase 1's cross-compilation AC as if POSIX validation transfers |
| Root-commit-hash project-id collision across two *different* repositories that happen to share a common history root (e.g. one forked from the other) | Out of scope — a limitation already accepted in the current TS implementation, not a new Go-specific risk |
| Case-insensitive filesystems (macOS APFS default, Windows NTFS): `src/safe-write.ts`'s containment prefix check is case-**sensitive**, and canonicalization behavior may differ between Node's `fs.realpathSync` and Go's `filepath.EvalSymlinks` regarding path-segment casing | **Blocking, per this row's own precondition** (see Acceptance Criteria — this was flagged as a Phase 1 precondition in v2 but left ungated; v3 adds a gating AC): empirically probe both runtimes on the stated macOS development platform before Phase 1's containment logic is considered verified there — not assumed safe |
| `os.homedir()` (Node) vs. `os.UserHomeDir()` (Go) may resolve differently in edge cases, affecting the shadow-repo path's cache-fallback branch. **Corrected in v3**: the existing AC's "both path branches" claim does not actually cover this — a test that sets `XDG_CACHE_HOME` to exercise the fallback branch never calls `homedir()`/`UserHomeDir()` at all; the real risk is unset `$HOME` with `XDG_CACHE_HOME` also unset, where Go's `os.UserHomeDir()` returns an error and Node's `os.homedir()` does not | A **third** path-branch case must be added to the shadow-repo-path AC: `XDG_CACHE_HOME` unset **and** `$HOME` unset, asserting both implementations make the same decided choice (error vs. a defined fallback), not merely that the two already-named branches are exercised |
| Two concurrent invocations (of either binary, or one of each) against the same shadow repo — no locking exists in the TS implementation today, and two same-purpose binaries on one machine make simultaneous invocation more likely, not less | Real locking/design work is out of scope for Phase 1–3 as currently planned (Follow-up 3); a minimum documentation-level warning is now a Phase 1 AC (see Acceptance Criteria) so this isn't silently unmentioned during the coexistence window |
| A `>100MB` blob during shadow-restore is a hard failure in TS (`maxBuffer: 100*1024*1024` at the relevant blob-read call, `src/tracks/shadow/restore.ts:204` — a **Phase 1** call site) with no direct Go analogue (`exec.Cmd.Output()` buffers unbounded by default) | Explicitly decide and implement an equivalent bound in the Go port, as a **Phase 1** gating AC (corrected in v3 — v2 left this risk row without a gating AC despite the call site being in Phase 1 scope); add a test with a blob near/over the boundary in both implementations |
| **Net-new in v3, reproduced as a live escape.** `--root` accepts `"..."` (passes `validateRoot`'s checks — not `.`, not `..`, no separators — `src/root.ts:72-87`), but `rootSegment` (`src/root.ts:95-97`) strips one leading dot and returns `".."`, escaping one directory level under `PLAN_SYNC_STATE_DIR` when set, and producing an invalid git refname (so `push`/`status` fail loudly afterward). Requires `PLAN_SYNC_STATE_DIR` to be set and an operator-supplied `--root "..."`; blast radius is one directory level inside a tool-owned state directory | Both implementations must re-validate `rootSegment`'s *output*, not just `validateRoot`'s input, before using it as a path or refname segment (see Acceptance Criteria). File this as a live bug against the current shipping TS implementation independently of the Go port — it is not Go-specific |

## Rollback / Decision Point

If Phase 1's mandatory Architect+Critic gate does not pass — specifically, if it finds a
containment gap that cannot be closed with reasonable effort in Go (e.g. a fundamental
primitive-behavior mismatch that Pre-mortem 1's mitigation doesn't fully resolve) — this
plan's explicit rollback path is: **do not merge or release the Go directory in that state.**
Document the specific unresolved finding, present it to the maintainer via this same
consensus process (a fresh Architect/Critic pass against the specific gap, not a silent
retry), and treat **Option D** (the TS single-file-executable fallback) as the immediately
available alternative that still satisfies the original "small binary, no Node needed"
motivation's *distribution* goal, if not its *binary size* goal, without carrying any new
security-re-derivation risk.

## Verification Steps (expanded test plan — deliberate mode)

- **Unit**: Go package-level tests for `internal/safewrite`, `internal/manifest`,
  `internal/glob`, `internal/root`, `internal/reporoot`, **and `internal/syncconfig`**
  (omitted from v1's list despite `sync-config.ts` being in scope and
  `test/sync-config.test.ts` existing) — each a direct, corrected port of the corresponding
  TS test file's actual scenarios (not the scenarios v1 assumed were there).
- **Integration**: real throwaway git repos in `t.TempDir()` (Go's direct equivalent of the
  TS suite's `fs.mkdtempSync` pattern), covering the full sibling-track lifecycle and the
  shadow track's `init`+`restore` (against a fixture ref constructed directly via git
  plumbing, since `push` — the command that would normally produce that ref — is Phase 2),
  including every adversarial symlink/traversal case from `docs/HARDENING-HISTORY.md`.
- **E2E**: corrected from v1, which claimed the TS suite invokes the CLI as a subprocess — it
  does not. All five `test/e2e/*.test.ts` files import `dispatch` from `src/cli.ts` directly
  and invoke it **in-process**, capturing output via `vi.spyOn(process.stdout/stderr,
  "write")` (this is a deliberate, documented choice in the TS suite). The Go E2E tests
  should build the actual `plan-sync-go` binary and exec it as a real subprocess (Go doesn't
  have the same in-process dispatch pattern available across a compiled binary boundary),
  which means the **cross-implementation parity harness is genuinely net-new infrastructure
  on both sides**, not "a small script" as v1 characterized it — it needs a real subprocess-
  exec test harness on the TS side too (which doesn't exist today) in addition to the Go
  side. This is now an explicit, separately-scoped Phase 1 work item.
- **Cross-implementation parity (Tier 1 + Tier 2)**: the net-new harness above, running the
  same operation sequence through both binaries against the same repo/remote and diffing:
  manifest file bytes, `.sync-config.json` bytes, exit codes, `git ls-tree` output of the
  ref (once Phase 2 makes shadow-track push available for full round-trip parity — Phase 1
  can still verify this against fixture refs), and Tier-2-normalized stdout.
- **Observability**: split across phases per the corrected Acceptance Criteria above — Phase
  1 verifies `pull --track shadow` against an unreachable/corrupt fixture ref (non-zero exit,
  non-empty stderr, no partial local write); the full net-new Go port of
  `test/e2e/observability.test.ts` (broken `push`, `status`'s staleness reporting,
  `--stale-after 0h`), plus explicit Tier-2 parity verification on the `status` staleness
  signal between both binaries under an identical broken-push condition, is a Phase 2
  criterion, since it requires `push`/`status --track shadow`.

## Sizing (rough, non-committal — added in v2 per Critic's finding that v1 gave no effort
signal at all, making the Option A vs. B′ tradeoff unjudgeable; corrected in v3 — v2's line
count was measured against the wrong figure)

Order-of-magnitude only, not a schedule commitment. **Corrected in v3**: Phase 1 is
**~2,270 lines** of TS to reference-port (`wc -l` across `src/*.ts`, `src/commands/*.ts`,
`src/tracks/sibling/*.ts`, plus `src/tracks/shadow/{init,paths,restore}.ts` — v2's "~1,700"
figure was measured wrong; the codebase totals 2,957 lines and Phase 2's files
(`shadow/{push,status,uninstall,scan}.ts` + `commands/uninstall.ts`) are only ~690 of them,
so Phase 1 is **~77% of the codebase**, not the minority split "Phase 1 is the largest
phase" language in v2 implied), plus the net-new dual-binary parity harness and the
glob-engine rework on top of that line count. Phase 2 (~690 lines, shadow's remaining
plumbing, no full-containment-review gate needed, but see the scoped `uninstall.ts`/`push.ts`
gate added in v3) is smaller. Phase 3 (packaging + the separate Windows sub-phase) is
comparable in effort to Phase 2 but carries its own, currently-unscoped containment-analysis
risk for Windows specifically. **Option D** (measured in v3): order-of-hours effort — one
`bun build --compile` invocation against the existing, already-complete TS codebase, versus
Phase 1-3's multi-phase, multi-week Go port; this is the real asymmetry Decision Driver 3's
tradeoff is weighed against.

## ADR

- **Decision**: Build the Go port in three phases, cut along the mutation-surface axis
  (Option B′): Phase 1 = complete containment surface (shared infrastructure + full sibling
  track + shadow track's `restore`+`init`); Phase 2 = shadow track's remaining
  plumbing-heavy, `safe-write`-call-site-free commands; Phase 3 = packaging/distribution,
  with Windows as its own explicitly gated sub-phase.
- **Drivers**: security-hardening parity against a now-durable, checkable record
  (`docs/HARDENING-HISTORY.md`); cross-implementation on-disk/on-remote compatibility
  (Parity Tier 1); minimal footprint (stdlib-only, small cross-compiled binaries).
- **Alternatives considered**: Option A (full port, one pass) — a legitimate alternative,
  not eliminated by any principle, whose real tradeoff against B′ is completeness-of-review
  (A sees the whole surface at once) vs. depth-of-focus (B′ concentrates attention, but on a
  now-correctly-drawn boundary that no longer excludes most of the hardened surface); either
  is defensible, B′ is recommended because it preserves an earlier shippable, reviewed
  artifact. Option B (v1's track-based cut) — superseded; demonstrated by two independent
  review rounds to invert its own risk-concentration purpose. Option D (TS single-file
  executable) — not eliminated by any principle; satisfies the security-parity driver
  perfectly and for free but fails the minimal-footprint driver by a **measured** 60MB vs.
  ~15MB (corrected in v3 from v2's unmeasured "50-110MB" ballpark); recorded as the explicit
  rollback path if Phase 1's Go containment logic cannot be closed to the gate's pass bar.
- **Why chosen**: B′ is the only phasing whose cut boundary actually matches the risk model
  it claims to serve, verified against the real call-site distribution rather than assumed
  from the track/security-history association that turned out to be false.
- **Consequences**: Phase 1 ships the sibling track (the tool's own *recommended* track)
  fully, plus `push`/`status` with a stubbed shadow branch, plus a hardened-but-not-yet-
  fully-usable shadow `init`+`restore`; the shadow track isn't completely usable end-to-end
  until Phase 2, and `init --track shadow` can create real state Phase 1 cannot yet tear down
  (documented explicitly per the `shadow/init.ts` AC, not silently); a temporary binary-naming
  convention (`plan-sync-go`) and per-command identity marker are required during the
  coexistence window; a real, net-new subprocess-exec test harness must be built on **both**
  sides for cross-implementation parity verification, which did not exist before this plan.
  **This plan requires three scoped changes to the existing, shipping TS implementation**,
  not only new Go code: a rework of `src/glob.ts` to a hand-written segment matcher (closing
  the glob-engine-divergence risk structurally), two genuinely new unit test cases added to
  `test/safe-write.test.ts` (dangling-symlink-at-destination and symlinked-ancestor-at-
  depth-≥2), and a per-command stderr identity marker on every mutating command. Each is a
  real, user-visible or behavior-adjacent change to production TS code and needs its own
  release/regression gate (a version bump and changelog entry, at minimum) — this plan does
  not itself define that gate, and implementation should not treat these as incidental
  side-effects of Go-port work.
- **Follow-ups**: (1) decide the Go module's import path/repo layout before Phase 1
  implementation begins; (2) decide whether F1/F2/F3 get fixed in TS first, Go first, or
  simultaneously — **this decision itself is now a blocking Phase 1 AC** (see Acceptance
  Criteria), not merely deferred to this follow-up; (3) design a concurrency/locking story
  for two same-purpose binaries potentially running simultaneously against the same shadow
  repo (a minimum documentation-level warning is now a Phase 1 AC; the real locking design
  remains out of scope here); (4) *(resolved in v3 — struck)* Option D's binary size is now
  measured (60MB via `bun build --compile`), replacing the prior deferred-measurement
  follow-up; (5) Phase 2 and Phase 3 each need their own scoped acceptance criteria once
  Phase 1's actual findings are known, deliberately not over-specified now — Phase 2's
  criteria must additionally cover the scoped containment gate for `shadow/uninstall.ts`'s
  recursive delete and `shadow/push.ts`'s temp-directory cleanup, and the full
  `test/e2e/observability.test.ts` scenario moved from v2's Phase 1 AC (see Acceptance
  Criteria).

## Changelog

- v1: initial Planner draft. Rejected by both Architect and Critic (run independently,
  neither seeing the other's output): the shadow-track-first phase cut was shown, by both
  methods, to invert its own risk-concentration rationale (2 of 7 `safe-write` call sites,
  0 of 3 `safeCopyFile` sites, in Phase 1); "byte-for-byte behavioral parity" was falsified
  by wall-clock-dependent `status` output and embedded Node-runtime error strings, in
  multiple distinct, verified locations; the "5 rounds / ~12 findings" hardening-history
  claim — the entire justification for deliberate mode and the gating Principle 1 — was
  confirmed absent from every repository artifact by both reviewers independently; several
  Acceptance Criteria cited test coverage or verification procedures that don't match the
  actual current test suite (e.g. AC3's cited `test/safe-write.test.ts` cases don't include
  two of the four named scenarios; AC5's verification procedure used commands that never
  write the manifest at all); the option space was pre-converged around "how much Go to
  port at once," missing a genuinely strong alternative (a Node/Bun single-file executable,
  feasible for free given the codebase's zero runtime dependencies) that satisfies the
  security-parity driver without any re-derivation risk.
- v2 (this draft): full rewrite. Re-cut phases along the mutation-surface axis (Option B′,
  replacing v1's Option B); corrected the parity principle into three explicit, independently
  achievable tiers and folded v1's Option C into that correction rather than keeping it as a
  separate rejected alternative; added Option D (TS single-file executable) as a fairly
  scored, non-eliminated alternative and explicit rollback path; wrote
  `docs/HARDENING-HISTORY.md` as a new, durable, file:line-anchored record of the actual 5
  hardening rounds (including the F1/F2/F3 follow-ups), making Principle 1 checkable for the
  first time; corrected AC3's test-file citations and added the two genuinely-missing unit
  test cases (dangling-symlink-at-destination, symlinked-ancestor-at-depth-≥2) as required
  net-new work in **both** languages; corrected AC5's verification procedure to use an
  actual Phase 1 manifest-writer; gave AC7's structural-regression-test requirement a single,
  named mechanism with an explicit pass criterion instead of three non-equivalent options;
  corrected the E2E section's mischaracterization of the existing TS test suite's invocation
  style and added the now-explicit net-new dual-binary subprocess harness as its own Phase 1
  work item; added a full Observability section (previously entirely absent, despite the TS
  suite having a real observability test with no Go counterpart proposed); replaced
  Pre-mortem Scenario 1 with the Go error-classification (fail-closed-to-fail-open) hazard,
  the single most important previously-unstated risk found by review; decided the
  `$PATH`-collision naming question explicitly (`plan-sync-go` + stderr identity markers)
  instead of deferring it; scoped Windows out of Phase 1's cross-compilation AC into its own
  gated Phase 3 sub-phase; added a Rollback/Decision-Point section and a rough Sizing
  section (both entirely absent from v1); corrected the CLI command count (7, not 8); added
  the missing multi-root-commit fixture case to the project-id AC; added `sync-config` to
  the unit-test list; defined the Architect+Critic gate's pass bar explicitly (zero
  CRITICAL, MAJORs fixed-or-logged-with-owner) instead of leaving it as undefined "reviewer
  discretion."
- v3 (this draft): targeted revision after round-2 Architect+Critic review of v2, both
  REVISE (not approve). Fixed: C1, the Observability AC required Phase-2-only commands
  inside Phase 1 — split into a Phase 1 portion (`pull` only) and a Phase 2 portion (the full
  `push`/`status` scenario, moved verbatim). C2, AC4's test citations were still wrong for 2
  of 4 cases despite v2's changelog claiming this was fixed — re-verified line-by-line
  against `test/safe-write.test.ts` and corrected, with the full per-operation citation
  breakdown made explicit this time. M1, AC5's manifest byte-parity procedure pointed at an
  unreachable code path and stated the removal behavior backwards (trailing newline is
  *preserved* on ordinary removal, not dropped) — corrected by executing the actual
  algorithm and re-deriving the procedure against `unallow`, the function's only real caller.
  M2, struck the "Phase 2 needs no adversarial review" claim for `shadow/uninstall.ts`'s
  recursive delete and `shadow/push.ts`'s temp-dir cleanup, added a scoped Phase 2 gate for
  both, and added a `rootSegment`-output-revalidation AC after reproducing a live one-level
  path escape via `--root "..."`. M3, added blocking ACs for the macOS case-sensitivity probe
  and the `>100MB` blob bound (both previously ungated despite being stated Phase 1
  preconditions/call sites), added an owned F1/F2/F3 applicability-and-sequencing decision as
  a blocking AC, and added the missing third `$HOME`-unset path-branch case to the homedir
  risk row. M4, decided the glob AC's previously-undecided either/or in favor of the
  hand-written matcher, since the alternative (character-class validation) doesn't address
  the `?`/rune divergence that is the risk's actual primary mechanism. M5, measured Option
  D's binary size for real (`bun build --compile` → 60MB, not a "50–110MB, unmeasured"
  ballpark), resolved the Decision-Driver-3-vs-Option-D self-contradiction by stating plainly
  that the Go choice is the user's explicit preference rather than principle-forced, fixed
  the Follow-up cross-reference, and added Option D's effort figure and SEA-experimental /
  cross-compile-asymmetry Cons. M6, fixed `docs/HARDENING-HISTORY.md`'s two citation errors
  (finding 7's anchor, the nonexistent commit SHA) and finding 11's arithmetic, and downgraded
  the document's and this plan's "file:line-anchored" language to "file- and
  symbol-anchored" since that claim was not uniformly true. M7, added an explicit Phase 1
  file-scope enumeration (`shadow/paths.ts`, `args.ts`, `cli.ts`, and the six Phase 1 command
  modules were previously omitted despite being required by other ACs) and specified that
  `push`/`status` ship in Phase 1 with a stubbed shadow branch, while `uninstall` does not
  ship in Phase 1 at all. M8, stated explicitly that `shadow/init.ts` ships and is CLI-wired
  in Phase 1, is inside the adversarial gate's scope, and documented the resulting known
  limitation (Phase 1 can create shadow state it cannot yet push/status/uninstall). M9,
  re-scoped AC3 to the findings the containment functions actually own (3, 4, 6, 7, 8, 11,
  12 — not 6–12) and added a separate AC for findings 9/10, plus a Windows-shaped/UNC-shaped
  input test requirement for `isPathContained` even though Windows itself is deferred.
  Also fixed: the Sizing section's line count (corrected from an unmeasured "~1,700" to a
  measured ~2,270, ~77% of the codebase); the `.sync-config.json` JSON-shape drift and
  `readManifest`'s skip-and-warn behavior each got a dedicated Tier 1/Tier 2 AC (previously
  ungated); a documentation-level concurrency-warning AC was added (the real locking design
  remains Follow-up 3); the ADR's Consequences section now names the three scoped changes
  this plan requires in the *shipping TS implementation* (glob rework, two new unit tests, a
  stderr identity marker) as needing their own release/regression gate, not as incidental
  Go-port side effects; the sibling-track file list no longer mislabels `allow`/`unallow` as
  sibling-track files.
- **Next**: this plan is offered as `pending approval` in non-interactive consensus mode.
  Two full independent review rounds have now run against two successive plan versions (4
  reviews total: Architect+Critic × v1, Architect+Critic × v2), each re-deriving its claims
  against actual current source rather than trusting the plan's own summary, and each
  producing a bounded, mechanical, individually-recoverable fix list rather than a
  structural rejection of the recommended direction (Option B′, the mutation-surface cut,
  has been independently confirmed sound by both round-2 reviews). Per this skill's
  iteration budget (max 5), this is iteration 2 of 5; further Architect/Critic iteration on
  v3 is left to whoever picks this up for Phase 1 implementation, rather than continuing to
  spend review cycles here before any code exists to review — the open items that remain
  (module layout, F1/F2/F3 fix sequencing decision, concurrency/locking design) are
  implementation-time decisions, not unresolved design disagreements. If a third review
  round is wanted before implementation begins, it should focus specifically on whether the
  Phase 1/Phase 2 split of the Observability AC (C1's fix) and the re-derived manifest
  byte-parity procedure (M1's fix) are now correct, since those two were the most
  substantively rewritten, not merely re-cited.
