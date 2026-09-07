# Epic Plan: Concurrency and Locking Design (`plan-sync-bm3`)

Status: **design-stage plan, pending human decision on Task 2**
Beads epic: `plan-sync-bm3` (P3, labels: `concurrency`, `deferred`, `design`)
Traces to: Follow-up 3 in `.omc/plans/go-port.md`; README §"Concurrency: no locking, in either implementation" (README.md:449-457)

## Context

`plan-sync` ships two same-purpose binaries (`plan-sync` TS, `plan-sync-go`) that derive
**byte-identical** on-disk paths and ref names (`src/tracks/shadow/paths.ts:37-76` vs
`go/internal/shadowpaths/shadowpaths.go:44-126`). Neither implements any locking primitive —
confirmed by exhaustive grep across both trees: zero `flock`, `sync.Mutex`, `LockFile`, or
temp+rename usage outside git's own internals. Today this is documented as a known gap and
nothing more.

The go-port plan's own Risks table names the coexistence window as making simultaneous
invocation *more* likely, not less, and explicitly scoped real locking work out of Phases 1-3
as Follow-up 3. This epic is that follow-up.

**This plan deliberately does not pick a locking mechanism.** Task 2 is an ADR, and the
mechanism choice is a decision for the maintainer to weigh in on, not a unilateral call by
whoever picks up the epic. See §"Task 2 decision — options for the human" below.

## Guardrails

**Must have**
- Task 1's written failure-mode enumeration lands *before* any mechanism is chosen. It is not
  meta-work: the audit already surfaced that the most severe scenario (`uninstall` racing
  everything) and the most likely one (manifest lost-update) need *different* lock scopes, and
  a mechanism picked without that list will be scoped wrong.
- Any mechanism both binaries must respect is specified as an **on-disk convention** (path,
  file format, semantics), not as a library choice — otherwise TS and Go silently diverge and
  the lock is worse than no lock.
- Fail-closed: a lock that cannot be acquired must abort with a clear message, never proceed.

**Must NOT have**
- No cross-machine distributed locking. The shadow track's remote ref already serializes
  cross-machine pushes via non-force `git push` (see below); do not rebuild that.
- No new runtime dependency added to the TS implementation without it being called out
  explicitly in the ADR (Node has no built-in `flock`; this materially constrains Option B).
- No lock held across a network round-trip longer than a bounded, documented timeout.
- Do not expand scope into the multi-writer reconciliation problem that `docs/DESIGN.md`
  already rejected twice (per-path causality tracking is out of scope, per that ADR's
  Follow-up 3).

## Grounding: what the audit already established

Recorded here so Task 1 starts from evidence rather than from zero. Task 1 must verify and
extend this, not merely restate it.

| # | Scenario | Severity | Evidence |
|---|---|---|---|
| 1 | `uninstall --track shadow` `rmSync`s the shared bare shadow repo while a concurrent push/restore/status has git plumbing open against it | CRITICAL | `src/tracks/shadow/uninstall.ts:33-37` (existsSync→rmSync, no coordination); victims at `push.ts:150-255`, `restore.ts` |
| 2 | Manifest lost update: `unallow`'s full-file `writeFileSync` overwrite clobbers a concurrent `allow`'s append | HIGH | read at `src/manifest.ts:235`, non-atomic overwrite at `:251`; append at `:143`. Also reachable from `shadow/restore.ts:120-144`, `sibling/pull.ts:118-149` |
| 3 | `.sync-config.json` read-merge-write lost update (e.g. `init --track sibling` racing `init --track shadow`) | HIGH | `src/sync-config.ts:65-80`, `go/internal/syncconfig/syncconfig.go:164-209` |
| 4 | Sibling track has **no** per-process isolation on the shared `clonePath`: `copyManifestFiles` races `git pull --rebase` / a second `push`, producing a commit containing a mix of two processes' file states, pushed to the shared remote | HIGH | `src/tracks/sibling/push.ts:31-58,168-185`, `pull.ts:87`. Live **TS↔Go** hazard today — sibling is fully ported |
| 5 | `safeWriteFile`/`safeCopyFile` are not atomic (no temp+rename, no fsync) | MEDIUM | `src/safe-write.ts:98-134`, `go/internal/safewrite/safewrite.go:235,271` |
| 6 | N-target `allow a b c` loops the RMW once per argument, multiplying scenario 2's window | MEDIUM | `src/commands/allow.ts:51-53`, `unallow.ts:47-49` |
| 7 | Init TOCTOU (`ensureBareRepo`, `ensureClone`) | LOW | `shadow/init.ts:80-85`, `sibling/init.ts:65-79` — fails loudly for the loser, benign |

**Already correct — do not "fix":** shadow `push` uses a per-process `mkdtempSync`
`GIT_INDEX_FILE` (`push.ts:81-85`) so simultaneous pushers do not collide on an index, and its
final `git push origin <sha>:<refName>` (`push.ts:238`) is **non-force**, delegating
serialization to the remote's own ref lock — the code even names this in its error message
(`push.ts:245`). Neither track ever touches the anchor repo's own index/working tree, so the
tool never contends with a human's concurrent `git` usage.

**Not relevant despite the name:** `go/internal/structuralcheck/nounguardedwrites_test.go`
enforces the symlink-escape containment invariant only. It has no atomicity or locking
semantics.

---

## Tasks

### Task 1 — Enumerate concrete concurrency failure scenarios

**Effort: M** · **Depends on: —** (blocks Task 2)

Produce a written, file:line-grounded enumeration of what concurrent `plan-sync` invocations
can actually corrupt. Start from the table above; verify each claim against current source and
extend it.

**Files touched**
- `docs/concurrency-failure-modes.md` (new — the deliverable)

**Must additionally resolve (open in the current audit)**
- Confirm whether shadow `push`'s local `git update-ref` mirror (`push.ts:253`) is genuinely
  reachable only by the push winner, or whether two processes that both `fetch` first can both
  succeed and regress the local mirror ref. The audit asserts the former; it is unverified.
- Determine the correct **lock scope boundaries** — the audit suggests at least three distinct
  resources (shadow repo path, sibling `clonePath`, manifest + `.sync-config.json`), which may
  not want one global lock.
- Classify each scenario as *needs mutual exclusion* vs. *needs only atomic write* vs.
  *already safe*. This classification is what makes Task 3 separable from Tasks 4/5.
- Confirm the live TS↔Go sibling-track hazard (#4) empirically, not by code reading alone.

**Acceptance criteria**
- [ ] Every scenario has (a) the interleaving, (b) file:line evidence in both TS and Go where
      applicable, (c) the concrete damage (data loss / corrupt file / wedged repo / silently
      wrong commit pushed to a shared remote).
- [ ] Each scenario is tagged `needs-mutex` / `needs-atomic-write` / `already-safe`, with the
      resource it contends on named.
- [ ] Scenarios that are cross-binary (TS↔Go) are marked as such and distinguished from
      same-binary races.
- [ ] At least one scenario is reproduced by an actual failing test or a scripted race, not
      only by code reading — the plan is not allowed to proceed on a purely hypothetical basis.
- [ ] The four "must additionally resolve" items above each have a recorded answer.

---

### Task 2 — Choose a locking strategy and record it as an ADR

**Effort: M** · **Depends on: Task 1** (blocks Tasks 4, 5)
**⚠ HUMAN DECISION REQUIRED — this task's output is a proposal for the maintainer to accept,
amend, or reject. Whoever executes this task must not merge a chosen mechanism as settled
without maintainer sign-off.**

`docs/decisions/` **does not yet exist** — no ADR files are present anywhere in this repo's
history. This task establishes it, consistent with the project's practice of recording
hard-to-reverse and surprising decisions (the two large existing ADRs live inline in
`docs/DESIGN.md:179` and `.omc/plans/go-port.md:637`).

**Files touched**
- `docs/decisions/0001-concurrency-locking.md` (new)
- `docs/decisions/README.md` (new — one paragraph on the ADR convention and numbering)

**Acceptance criteria**
- [ ] ADR uses this project's established ADR fields: Decision, Drivers, Alternatives
      considered, Why chosen, Consequences, Follow-ups.
- [ ] ≥2 viable options presented with bounded pros/cons; rejected options carry a stated
      reason, not a dismissal.
- [ ] The ADR names the **lock scope(s)** (per-resource vs. global) chosen, citing Task 1's
      classification.
- [ ] The ADR states explicitly whether the mechanism is language-agnostic (one on-disk
      convention both binaries honor) or per-language, and if per-language, why that is safe
      given the byte-identical path derivation.
- [ ] The ADR specifies: lock file path(s), file format/contents, acquisition timeout,
      staleness policy, and the fail-closed behavior on non-acquisition.
- [ ] Status field is `proposed` until the maintainer accepts; only then `accepted`.
- [ ] Tasks 4 and 5 are explicitly gated on `accepted`.

#### Task 2 decision — options for the human

These are presented as a **leading recommendation plus alternatives**, not a settled choice.

**Option A (leading recommendation) — Lock file/directory convention, created `O_EXCL`,
with staleness detection.**
A deterministic lock path per contended resource (alongside the shadow repo path, the
`clonePath`, and the state dir), created atomically via `O_CREAT|O_EXCL` (or `mkdir`),
containing hostname + PID + start time + binary identity (`plan-sync` vs `plan-sync-go`).
Bounded acquisition timeout, then fail closed with a message naming the holder.
- *Pros:* language-agnostic by construction — a documented on-disk convention both binaries
  respect, which is the only thing that closes the live TS↔Go sibling hazard. No new
  dependency in either language. Holder identity is diagnosable by a human (`cat` the file).
  Works uniformly across the three distinct resources Task 1 identifies.
- *Cons:* requires explicit staleness detection (a crashed process leaves the lock behind),
  and staleness detection is itself racy if done naively — PID reuse is real. Needs a
  documented manual override/break path. This is the classic hard part.

**Option B — OS advisory locks (`flock(2)` / `LOCK_EX`) on a sentinel file.**
- *Pros:* the kernel releases the lock on process death, which **eliminates the staleness
  problem entirely** — the single biggest weakness of Option A. Go has `syscall.Flock`
  in-stdlib.
- *Cons:* **Node has no built-in `flock`** — this forces a new runtime dependency into the TS
  implementation (`proper-lockfile`, `fs-ext`, or a native addon), which the Guardrails flag as
  requiring explicit call-out. Semantics degrade on NFS and differ on Windows, and Windows is
  already a deferred, separately-gated concern in the go-port plan. A TS/Go asymmetry here is
  exactly the divergence risk that makes cross-binary locking unreliable.

**Option C — Git-native only: extend the existing CAS pattern, add no lock.**
Lean on what already works: shadow push's non-force `git push` already makes the *remote* the
arbiter for the shadow ref, and git's own `index.lock` / ref locks serialize plumbing calls.
Convert remaining mutations into compare-and-swap retry loops.
- *Pros:* no new mechanism, no staleness problem, no new dependency; correctly handles the
  cross-machine case, which no local lock can. Preserves a pattern the codebase already
  implements correctly and documents in its own error messages.
- *Cons:* **does not cover the majority of the identified damage.** The manifest,
  `.sync-config.json`, the sibling `clonePath` working tree, and the `uninstall` rmSync are all
  plain filesystem state with no git ref to CAS against. Scenarios 1-6 are largely untouched.
  Viable as a *component* of the answer, not as the whole answer.

**Option D — Atomicity-only, keep documenting "no locking".**
Fix temp+rename atomicity (Task 3) and stop there.
- *Pros:* cheapest; closes the corruption-shaped failures (torn writes) with no new concepts.
- *Cons:* leaves every lost-update and the CRITICAL `uninstall` race open. Honest only if the
  README warning stays. Should be considered the explicit do-less baseline the other options
  must beat.

**The recommendation to weigh:** Option A for local mutual exclusion, *composed with* Option C
for the cross-machine case — because they solve genuinely different problems and the audit
shows Option C alone cannot reach most of the damage. Option A's staleness handling is the
main thing the maintainer should push back on, and Option B's kernel-managed release is the
strongest argument against A — the tradeoff is squarely "staleness complexity (A)" vs. "a new
TS dependency and TS/Go asymmetry (B)". That tradeoff is the decision.

---

### Task 3 — Atomicity hardening (temp + rename), both languages

**Effort: M** · **Depends on: Task 1** · **NOT gated on the ADR**

Task 1's classification separates *needs atomic write* from *needs mutual exclusion*. The
former is a strict improvement under every Option A-D, so it can land while the ADR is being
decided. Scoped deliberately to not preempt the ADR: this makes writes atomic; it does **not**
prevent lost updates.

**Files touched**
- `src/safe-write.ts`, `go/internal/safewrite/safewrite.go`
- `src/manifest.ts` (`:251` overwrite), `go/internal/manifest/manifest.go`
- `src/sync-config.ts` (`:65-80`), `go/internal/syncconfig/syncconfig.go` (`:164-209`)
- `go/internal/structuralcheck/nounguardedwrites_test.go` (allowlist likely needs updating once
  writes route through a rename helper)
- corresponding tests in `test/` and `go/internal/**/*_test.go`

**Acceptance criteria**
- [ ] Every full-file write of a tool-owned file (manifest, `.sync-config.json`, restored
      artifacts) goes through write-temp-in-same-directory + `fsync` + `rename`.
- [ ] Temp file names are per-process unique (follow the existing `mkdtempSync` precedent at
      `shadow/push.ts:81-85`); no fixed temp path is introduced.
- [ ] Containment invariants from `docs/HARDENING-HISTORY.md` still hold for the temp path, not
      only the final path — a temp file must not be creatable outside the contained directory.
- [ ] `TestNoUnguardedWritesOutsideSafewrite` still passes, with any allowlist change justified
      in the diff.
- [ ] TS and Go produce byte-identical output files for the same input (the manifest byte-parity
      procedure from the go-port plan applies).
- [ ] A test asserts a reader never observes a partial file (e.g. concurrent read during write).
- [ ] Explicitly documented in the PR: this does **not** fix lost updates; those await Tasks 4/5.

---

### Task 4 — Implement the chosen mechanism in TypeScript

**Effort: M** · **Depends on: Task 2 ADR accepted, Task 3**

Split from Task 5 because the mechanism *may* differ per language (Option B in particular
forces asymmetry). If the ADR selects a language-agnostic on-disk convention (Option A), Tasks
4 and 5 implement the same spec twice and the conformance suite in Task 5 is what proves they
agree.

**Files touched**
- `src/lock.ts` (new — acquisition, release, staleness, timeout)
- `src/tracks/shadow/{push,restore,uninstall,status}.ts`
- `src/tracks/sibling/{push,pull,init}.ts`
- `src/commands/{allow,unallow,init,uninstall}.ts`
- `src/manifest.ts`, `src/sync-config.ts`
- `test/lock.test.ts` (new), plus updates to affected e2e tests

**Acceptance criteria**
- [ ] Implements exactly the ADR's spec (paths, format, timeout, staleness, fail-closed) — any
      deviation is an ADR amendment, not an implementation detail.
- [ ] Every scenario Task 1 tagged `needs-mutex` is covered by a lock at the scope the ADR names.
- [ ] Scenario 1 (`uninstall` vs. in-flight operation) is specifically covered — it is the
      CRITICAL one and the easiest to overlook because `uninstall` is rarely run.
- [ ] Locks are released on **all** exit paths including thrown errors and signals; verified by
      test, not by inspection.
- [ ] Lock acquisition failure produces an actionable message naming the holder
      (host/PID/binary) and the manual override path.
- [ ] Regression test per `needs-mutex` scenario: the race reproduced in Task 1 now fails
      closed instead of corrupting.
- [ ] No measurable regression on the single-invocation happy path.

---

### Task 5 — Implement the chosen mechanism in Go + cross-binary conformance

**Effort: M** · **Depends on: Task 2 ADR accepted, Task 3** (may run in parallel with Task 4)

Carries the cross-binary conformance suite, because that is the acceptance criterion neither
single-language task can own. Note Go's shadow `push`/`status`/`uninstall` are still Phase-2
stubs (`go/internal/commands/shadow.go:25-51`) — this task locks what exists and leaves a
documented hook for the Phase-2 shadow commands.

**Files touched**
- `go/internal/lock/lock.go` (new) + `lock_test.go`
- `go/internal/tracks/sibling/{push,pull,init}.go`
- `go/internal/tracks/shadow/{init,restore}.go`
- `go/internal/commands/*.go`
- `go/internal/{manifest,syncconfig}/*.go`
- `test/conformance/` or equivalent (new — cross-binary race harness)

**Acceptance criteria**
- [ ] Go implementation satisfies the same ADR spec as Task 4.
- [ ] **A conformance test runs the real `plan-sync` (TS) and `plan-sync-go` binaries
      concurrently against the same repo and asserts one is excluded** — this is the criterion
      that actually closes the live TS↔Go sibling hazard (scenario 4). Code-level agreement is
      not sufficient evidence.
- [ ] A lock written by one binary is correctly read, respected, and staleness-evaluated by the
      other, in both directions.
- [ ] Phase-2 shadow commands (`push`/`status`/`uninstall`) have a documented, tested
      integration point so locking is not retrofitted after the fact.
- [ ] Cross-binary manifest/config byte-parity still holds under contention.

---

### Task 6 — Replace the README warning; document the concurrency contract

**Effort: S** · **Depends on: Tasks 4, 5**

**Files touched**
- `README.md` (§"Concurrency: no locking, in either implementation", :449-457)
- `docs/DESIGN.md` / `.omc/plans/shadow-ref-git-sync-for-omc-artifacts.md` (these two are
  byte-identical and must stay so — update both or neither)
- `.omc/plans/go-port.md` (mark Follow-up 3 resolved; update the Risks table row at :565)
- `docs/decisions/0001-concurrency-locking.md` (status → `accepted`, Consequences finalized)

**Acceptance criteria**
- [ ] README states the *actual* guarantee now provided, its scope, and what remains
      unsupported (e.g. cross-machine sibling `clonePath` sharing, if still out of scope) —
      not a blanket "now safe".
- [ ] Documents the operator-facing behavior: what a lock-contention message looks like and how
      to break a stale lock.
- [ ] `docs/DESIGN.md` and `.omc/plans/shadow-ref-git-sync-for-omc-artifacts.md` verified
      byte-identical after the edit (`diff` in the PR).
- [ ] Follow-up 3 marked resolved with a link to the ADR; the go-port Risks row updated rather
      than deleted.
- [ ] Any scenario from Task 1 left deliberately unfixed is listed as a named, accepted
      limitation — silence is not acceptable given this epic exists because of an honest
      warning.

---

## Task graph

```
T1 (enumerate) ──┬─> T2 (ADR) ──[ACCEPTED gate]──┬─> T4 (TS impl) ──┐
                 │                                └─> T5 (Go impl + ├─> T6 (docs)
                 └─> T3 (atomicity, ungated) ────────> conformance)─┘
```

T3 is intentionally off the ADR critical path. T4 and T5 may run in parallel once T2 is
accepted; T5 owns the cross-binary conformance suite.

## Success criteria for the epic

- Every scenario in `docs/concurrency-failure-modes.md` is either fixed with a regression test
  or listed as a named accepted limitation.
- A cross-binary (TS + Go) concurrent-invocation test exists and passes.
- `docs/decisions/0001-concurrency-locking.md` exists with status `accepted` and a maintainer
  sign-off recorded.
- The README no longer warns that concurrent invocation is unsupported *without qualification*.

## Sequencing note

This epic is P3, below the Phase 1/2/3 Go port work. Task 5's value increases substantially
once Go's Phase-2 shadow commands land — before then it can only lock `init`/`restore` on the
shadow track. Tasks 1-3 have no such dependency and are worth doing at any point; in
particular Task 1 is cheap, is a prerequisite for a correctly-scoped decision, and its output
is useful even if the epic is deferred again.
