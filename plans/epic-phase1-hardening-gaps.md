# Epic: Go Port Phase 1 Hardening Gaps (`plan-sync-6lq`)

Status: **ready to seed as beads** (non-interactive planning pass)
Source of truth for surrounding design: [`.omc/plans/go-port.md`](./go-port.md) (v3, Option B′)

Closes 3 audited gaps between the shipped Phase 1 code and `go-port.md`'s own Phase 1
Acceptance Criteria. All claims below were re-verified against current source; where the
dispatch brief's summary was inaccurate, the correction is called out inline.

---

## Verified current state (do not re-derive)

### `safeCopyFile` containment coverage — actual, per language

| Case | `safeWriteFile` | `safeCopyFile` | `safeRemove` |
|---|---|---|---|
| live symlink **at destination** | TS `:28` / Go `:87` | **absent both** | — |
| live symlinked **immediate-parent** ancestor | TS `:38` / Go `:102` | TS `:127` / Go `:220` | TS `:163` / Go `:277` |
| **dangling** symlink at **mid-path ancestor** | TS `:48` / Go `:117` | **absent both** ← *named gap 1* | TS `:175` / Go `:294` |
| regular file as mid-path ancestor (ENOTDIR) | TS `:59` / Go `:130` | TS `:139` / Go `:237` | TS `:185` / Go `:304` |
| **dangling** symlink **at destination** | TS `:78` / Go `:149` | **absent both** | **absent both** |
| live symlinked ancestor **depth ≥ 2** | TS `:101` / Go `:182` | **absent both** | **absent both** |

**Correction to the dispatch brief:** the two cases cited as "already covered"
(dangling-at-destination `safe-write.test.ts:78` / `safewrite_test.go:149`, and
depth≥2 `safe-write.test.ts:101` / `safewrite_test.go:182`) are **`safeWriteFile` tests, not
`safeCopyFile` tests**. Go's equivalent ancestor-symlink coverage was asked to be verified —
it is confirmed present and at parity with TS for `safeWriteFile`/`safeRemove`, and confirmed
**equally absent** for `safeCopyFile`. So `safeCopyFile` is missing *three* containment cases
in **both** languages, not one. `go-port.md:366-368` anticipated exactly this ("there is no
dangling-ancestor unit case for safeCopyFile today either, and one should be added alongside
(e)").

`safeCopyFile` today has exactly 3 tests per language: happy path, live symlinked immediate
parent, regular-file ancestor.

### TS case-sensitivity — confirmed absent, plus a net-new finding

`src/safe-write.ts` (186 lines, read in full) contains **zero** mention of case-sensitivity,
APFS, or canonicalization. Go has both an implementation note (`safewrite.go:138-152`) and a
test (`safewrite_test.go:515`). Confirmed as reported.

**Net-new finding (not in the brief): Go's two artifacts contradict each other.**

- `safewrite.go:142-152` asserts `filepath.EvalSymlinks` does **NOT** canonicalize
  path-segment casing, whereas Node's `fs.realpathSync` **does** — concluding "with a
  mis-cased ROOT, Go refuses where TS allows", direction fail-closed, "no code change
  recommended."
- `safewrite_test.go:538-540` asserts the opposite in its own comment: "Case-insensitive
  filesystem: EvalSymlinks canonicalizes casing, so the two resolve identically."

The test **cannot** catch this: it branches adaptively on whichever behavior it observes at
runtime (unresolvable → expect refuse; resolves-equal → expect allow; resolves-differently →
expect refuse) and therefore passes under *either* truth without ever pinning the verdict.
So `go-port.md`'s AC — "assert both implementations agree on the containment verdict" — is
**not** actually satisfied on the Go side either. The empirical fact has never been recorded.

### The Architect+Critic gate — partially run, non-independent, unrecorded

**Correction to the brief:** this is not a phantom gate. Two surviving code comments cite a
numbered fix ledger from a review that demonstrably ran:

- `go/internal/safewrite/safewrite.go:142` — "Logged (**Fix 6, completion review round 1**)"
- `go/internal/shadowpaths/shadowpaths.go:143` — "(**Fix 5, completion review round 1**)"

So ≥6 numbered fixes were produced by a "completion review round 1". But: no ledger file
exists (`docs/` holds only `DESIGN.md` and `HARDENING-HISTORY.md`; there is no
`docs/decisions/`), `HARDENING-HISTORY.md` covers only the TS implementation and never the Go
port, and the review was self-administered inside the porting session — violating
`go-port.md:507-512`'s explicit requirement that the pass be "run separately from whoever
authored the port," with a "zero CRITICAL" bar and a follow-up ledger.

The real gap is therefore **independence + recording**, not "never happened."

---

## Tasks

### Gap 1 — `safeCopyFile` ancestor/destination containment coverage

#### T1 · TS: add the three missing `safeCopyFile` containment tests
- **Files:** `test/safe-write.test.ts` (extend the `describe("safeCopyFile")` block, currently lines 117-149)
- **Effort:** S
- **Depends on:** —
- **Acceptance criteria:**
  - New test asserts `safeCopyFile` returns `false` when a **dangling** symlink sits at a
    **mid-path ancestor** of the destination (e.g. `root/plans` → a never-created target,
    destination `root/plans/foo.md`), and that the call does **not** throw. Mirrors the
    existing `safeWriteFile` case at `:48` and `safeRemove` case at `:175`.
  - New test asserts `safeCopyFile` returns `false` when the **destination itself** is a
    dangling symlink pointing outside `root`, and that the outside target is **not** created.
    Must include the same load-bearing precondition assertions as `:78`:
    `fs.existsSync(dest) === false` **and** `fs.lstatSync(dest).isSymbolicLink() === true`.
  - New test asserts `safeCopyFile` returns `false` for a **live symlinked ancestor at depth
    ≥ 2** where the destination's immediate parent does not exist on disk (mirror of `:101`),
    and that no directory is created through the symlink on the outside.
  - All three assert no file appears under the outside directory.
  - `npx vitest run test/safe-write.test.ts` passes.

#### T2 · Go: mirror the three `safeCopyFile` containment tests
- **Files:** `go/internal/safewrite/safewrite_test.go` (extend the `SafeCopyFile` group, currently lines 206-253)
- **Effort:** S
- **Depends on:** — (parallelizable with T1; test *names* must correspond 1:1 with T1's titles)
- **Acceptance criteria:**
  - `TestSafeCopyFileFailsClosedOnDanglingSymlinkMidPathAncestor` asserts `SafeCopyFile`
    returns `false` for a dangling mid-path ancestor symlink.
  - `TestSafeCopyFileRefusesDanglingSymlinkAtDestinationItself` asserts `false` and that the
    outside target is not created; includes the `os.Stat` (follows, reports absent) vs
    `os.Lstat` (sees the link) precondition pair, matching `safewrite_test.go:149`.
  - `TestSafeCopyFileRefusesLiveSymlinkedAncestorTwoLevelsUp` asserts `false` and that no
    directory was created through the symlink, matching `safewrite_test.go:182`.
  - Each test carries a comment naming its TS counterpart, matching the existing convention.
  - `go test ./...` passes from `go/`.

#### T3 · Both: strengthen existing fail-closed tests to assert outside content survived
- **Files:** `test/safe-write.test.ts`, `go/internal/safewrite/safewrite_test.go`
- **Effort:** S
- **Depends on:** T1, T2 (same blocks; sequence to avoid conflicts)
- **Acceptance criteria:**
  - The dangling-ancestor and regular-file-ancestor fail-closed tests — which today assert
    only `not.toThrow()` / a `false` return (TS `:48`, `:59`, `:139`, `:175`, `:185`) — also
    assert that pre-existing content outside `root` is **byte-unchanged** after the refused
    call, wherever an outside artifact exists to check.
  - The TS regular-file-ancestor `safeCopyFile` test (`:139`) stops calling `safeCopyFile`
    twice (once inside `expect(...).not.toThrow()`, once for the return-value assert) —
    single invocation, both properties asserted off it.
  - Satisfies `go-port.md:369-375`. Both suites pass.

### Gap 2 — TS case-sensitivity (APFS) containment probe

#### T4 · Empirically settle the EvalSymlinks-vs-realpath case behavior; fix the wrong comment
- **Files:** `go/internal/safewrite/safewrite.go` (comment `:138-152`), `go/internal/safewrite/safewrite_test.go` (comment `:538-540`) — whichever is wrong
- **Effort:** S
- **Depends on:** —
- **Acceptance criteria:**
  - A throwaway probe run on the macOS APFS dev machine records, as literal observed output,
    whether `filepath.EvalSymlinks("<tmp>/ROOT")` returns canonical-cased `.../root` or
    literal `.../ROOT`, and the same for Node's `fs.realpathSync`.
  - The contradiction between `safewrite.go:142-152` and `safewrite_test.go:538-540` is
    resolved: the comment that disagrees with the observed behavior is corrected in place.
  - The observed result is written into the task/beads note so downstream tasks do not
    re-derive it.
  - No behavior change in this task — comments and evidence only.

#### T5 · TS: add the case-sensitivity containment guard note to `src/safe-write.ts`
- **Files:** `src/safe-write.ts` (doc comment on `isSafeDestination`, near the `:53` comparison)
- **Effort:** M
- **Depends on:** T4
- **Acceptance criteria:**
  - `src/safe-write.ts` carries an explicit note at the containment comparison (`:53`) stating
    that the check is case-**sensitive**, what `fs.realpathSync` does with casing on a
    case-insensitive-but-case-preserving filesystem (per T4's recorded observation), and how
    that compares to Go's `filepath.EvalSymlinks` — the TS mirror of `safewrite.go:138-152`.
  - The note records the **decided** verdict (see Assumption A1): both implementations stay
    case-sensitive, no lowercasing/normalization is introduced in either, and any residual
    mis-cased-**root** divergence is documented as fail-closed and non-exploitable because
    `root` is always tool-derived (`git rev-parse --show-toplevel` + a `validateRoot`-checked
    name), never manifest-derived.
  - **No functional change to `isSafeDestination`** unless T4's probe shows TS is fail-**open**
    where Go is fail-closed; if so, this task expands to add the guard that closes it, and
    that expansion is recorded as a scope change rather than made silently.
  - Existing 177-test suite still passes.

#### T6 · TS: add the case-sensitivity containment test
- **Files:** `test/safe-write.test.ts`
- **Effort:** S
- **Depends on:** T5
- **Acceptance criteria:**
  - New test mirrors `TestContainmentIsCaseSensitive` (`safewrite_test.go:515`): exercises a
    destination whose on-disk casing differs from the root string's casing, and asserts the
    containment verdict.
  - Unlike the Go original, the test **pins** the verdict for the filesystem it runs on rather
    than branching adaptively into an always-passing shape — the observed-APFS branch from T4
    is asserted directly, with the case-sensitive-filesystem branch skipped explicitly
    (`it.skipIf`-style) rather than silently satisfied.
  - A sibling assertion covers the prefix-matching case (`<root>-evil` is not contained by
    `<root>`), matching `TestContainmentRejectsSiblingPrefixDirectory`
    (`safewrite_test.go:558`) — TS has no equivalent today.
  - Test comment cross-references the Go counterpart by name.

### Gap 3 — the Architect + Critic adversarial review gate

#### T7 · Run the independent Architect + Critic pass against Phase 1 Go code
- **Files:** none changed by the review itself; findings drive follow-up edits under `go/`
- **Effort:** L
- **Depends on:** T1, T2, T3, T5, T6 (review must see final Phase 1 code, not a moving target)
- **Acceptance criteria:**
  - Architect and Critic are run **sequentially and independently**, neither seeing the
    other's output, and **neither being the agent that authored the port** — this is the
    specific property `go-port.md:507-512` requires and that "completion review round 1"
    (evidenced at `safewrite.go:142`, `shadowpaths.go:143`) did **not** have.
  - Scope is Phase 1's actual Go source: `go/internal/{safewrite,manifest,glob,root,reporoot,syncconfig,shadowpaths,structuralcheck}`,
    `go/internal/tracks/{sibling,shadow}`, `go/internal/{commands,cli,args}`.
  - Every finding is triaged to a severity (CRITICAL / MAJOR / MINOR).
  - **Pass bar: zero CRITICAL findings remain open.** Every CRITICAL is fixed with a test that
    fails before and passes after; every MAJOR is either fixed or logged with an owner and an
    explicit rationale.
  - `go test ./...` and the TS suite both pass after any fixes land.

#### T8 · Record the review outcome as a durable artifact
- **Files:** new `docs/GO-PORT-REVIEW.md` (assumption A3); optionally cross-linked from `docs/HARDENING-HISTORY.md` and `.omc/plans/go-port.md`
- **Effort:** M
- **Depends on:** T7
- **Acceptance criteria:**
  - Document records, in `HARDENING-HISTORY.md`'s established style: date, who/what ran each
    pass, the exact scope reviewed, every finding with severity and disposition, and an
    explicit statement that the zero-CRITICAL bar was met.
  - **Retroactively reconstructs "completion review round 1"** as a first section: at minimum
    Fix 5 (`shadowpaths.go:143`, empty-string `HOME`) and Fix 6 (`safewrite.go:142`,
    EvalSymlinks casing) are recovered from their surviving code comments, with Fixes 1-4
    recovered if determinable and explicitly marked "not recoverable" if not — and the round
    is labelled **non-independent** so it is never mistaken for satisfying the gate.
  - Carries a forward ledger in the F1/F2/F3 pattern for anything deferred.
  - `go-port.md`'s Phase 1 Architect+Critic AC can be checked off with a citation to this file.
  - The T4 casing verdict and the A1 decision below are recorded here as an ADR entry
    (Decision / Drivers / Alternatives / Why chosen / Consequences / Follow-ups).

---

## Dependency graph

```
T1 ─┐                 T4 ── T5 ── T6 ─┐
T2 ─┴─ T3 ────────────────────────────┴─ T7 ── T8
```

T1, T2 and T4 have no predecessors and can start in parallel. Critical path: T4→T5→T6→T7→T8.

## Assumptions made (flagged for human confirmation)

- **A1 — Case-sensitivity resolution defaults to "document, don't change behavior."** The
  brief says TS "must match Go's decision on what's allowed/blocked." But Go's own recorded
  decision (`safewrite.go:150-152`) is that the residual mis-cased-**root** divergence is
  *deliberate*, fail-closed, non-exploitable, and "no code change recommended" — which is in
  tension with `go-port.md`'s AC wording "assert both implementations agree on the containment
  verdict." T5/T6 therefore keep both implementations case-sensitive and document the
  divergence, rather than changing shipping TS behavior. **If you want literal verdict
  agreement instead, T5 grows a real guard and this is a behavior change to the shipping TS
  binary.** Recommend also amending the `go-port.md` AC to "agree on the security-relevant
  verdict (neither fails open)."
- **A2 — Gap 3 is reframed from "never ran" to "ran, but non-independently and unrecorded."**
  T7 still runs a genuine independent pass (the missing property), and T8 additionally
  reconstructs the prior round rather than pretending it did not happen.
- **A3 — Artifact location is `docs/GO-PORT-REVIEW.md`.** Chosen over a `docs/decisions/` ADR
  tree (which does not exist yet) and over a beads-note-only record (not durable enough for a
  gate the plan calls mandatory). Trivial to relocate.
- **A4 — T3 is included although not one of the 3 named gaps.** It is required by
  `go-port.md:369-375`, touches the exact same test blocks as T1/T2, and is nearly free once
  those are open. Drop it if you want the epic scoped strictly to the audit's 3 items.

## Scope questions worth raising

- **`safeRemove` has the same two holes as `safeCopyFile`** — no dangling-symlink-at-destination
  case and no depth≥2 ancestor case, in either language. Out of this epic's named scope, but
  it is the identical gap class and would be cheap to close alongside T1/T2. Recommend adding
  it; not included above.
- **The Go case-sensitivity test's adaptive branching is an anti-pattern worth auditing for
  elsewhere.** A test that branches on observed runtime behavior and asserts a different
  expectation per branch cannot fail, and thus gates nothing. Worth a sweep across
  `go/internal/**/*_test.go` during T7.
- **`go-port.md` Phase 1 ACs beyond these 3 gaps were not audited** by this planning pass.
  Whether the other ~25 Phase 1 checkboxes are genuinely met is unverified here.
