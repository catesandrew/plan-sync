# Epic: Shadow-Ref Durability Research Follow-Ups

**Beads epic:** `plan-sync-b60`
**Priority:** P3 — speculative / backlog. Explicit icebox candidate.
**Source:** `docs/DESIGN.md` (byte-identical to `.omc/plans/shadow-ref-git-sync-for-omc-artifacts.md`), Follow-ups (2) and (3) at line 186.

## Context

`docs/DESIGN.md` closes with four follow-ups. Two of them are *research/design* work rather than implementation, and neither blocks the v3 design as written:

- **Follow-up (2):** the remote already carries a `refs/notes/ai` ref. The design rejected `git notes` as a transport (line 157) on the grounds that `core.notesRef` defaults to `refs/notes/commits` and plain `git log` renders notes on displayed commits — but it explicitly flags this as an *uninvestigated* open question and suggests checking `refs/notes/ai` for prior art on this exact problem before building anything new.
- **Follow-up (3):** multi-machine support for §Part B of the design requires solving per-path causality tracking first (vector clocks or a per-path manifest). The doc is explicit that this is **new design work, not a patch to the v2/v3 approach**.

**Scope boundary:** this epic covers *only* the multi-machine/distributed-causality angle plus the `refs/notes/ai` prior-art check. Single-machine locking is a **separate epic (`plan-sync-bm3`)** and is out of scope here. Follow-ups (1) (org policy on sibling repos) and (4) (`.omx` scope model) are also out of scope.

Both tasks produce **documents only**. No production code changes. Implementation of anything either task recommends is a separate future epic, gated on the design being approved.

## Work Objectives

Produce two written artifacts that either (a) change the shadow-ref direction with a recorded rationale, or (b) close the open question with a documented "not applicable" so it stops resurfacing in review.

## Guardrails

**Must have:**
- Both outputs are written, committed documents — a research note / ADR, not a chat summary.
- Each output states a clear recommendation, not just a survey.
- A negative conclusion ("not applicable", "last-writer-wins is fine") is an acceptable and valuable outcome, provided the reasoning is recorded.

**Must NOT have:**
- No implementation. No new transport code, no ref-writing code, no clock/manifest code.
- No re-litigating single-machine locking (that is `plan-sync-bm3`).
- No expansion into follow-ups (1) or (4).
- No large speculative build-out. If a task's writeup exceeds ~2 pages, it is over-invested for a P3 icebox item.

## Task Flow

The two tasks are **independent** and may be done in either order or in parallel. Neither depends on the other; neither depends on `plan-sync-bm3`.

```
Task 1 (refs/notes prior art) ──┐
                                ├── (independent, no ordering constraint)
Task 2 (multi-machine causality)┘
```

---

## Task 1 — Research `refs/notes/ai` as prior art

**Effort:** M (research + writeup only)
**Depends on:** nothing

**What to do:**
1. Read how git's notes mechanism actually works: `refs/notes/*` layout, `core.notesRef`, `notes.displayRef`, `--notes` / `--no-notes` on `git log`, fetch/push refspec behavior for notes, and how notes survive (or don't survive) GC and `git gc --prune`.
2. Establish what `refs/notes/ai` on this repo's remote actually is — inspect the ref if fetchable (`git ls-remote origin 'refs/notes/*'`, then fetch and read it), and grep the repo docs for surrounding context (`docs/DESIGN.md` lines 51, 157, 186 are the known mentions).
3. Evaluate against plan-sync's shadow-ref requirements: does the notes mechanism solve the same problem (out-of-band artifact sync attached to a repo, invisible to default `git log`/`git status`, survives host GC)? Verify or refute the design's stated rejection rationale at line 157.
4. Write up findings and a recommendation: **relevant / not relevant to plan-sync's shadow-ref approach**, with the reasoning.

**Files touched:**
- New: `docs/decisions/ADR-00X-git-notes-as-shadow-transport.md` *if* the conclusion changes direction (i.e. notes are viable and should be reconsidered).
- OR: edit to `docs/DESIGN.md` line ~157 / ~186 converting the open question into a settled, cited conclusion, *if* the answer is "no, not applicable."
- Note: `docs/decisions/` does not exist yet; creating it is fine if an ADR is warranted.

**Acceptance criteria:**
- A written research note exists (as an ADR in `docs/decisions/` if it changes direction, or as a `docs/DESIGN.md` update if the conclusion is "not applicable").
- The note states explicitly whether `refs/notes/ai` / git notes is prior art for plan-sync's problem, and why.
- The design doc no longer carries the follow-up (2) open question as unanswered.

---

## Task 2 — Design multi-machine causality tracking for the shadow track

**Effort:** M (design output only; the *implementation* would be L and is explicitly out of scope)
**Depends on:** nothing

**What to do:**
1. State the problem concretely: what breaks today when the same repo's shadow state is written from two machines (per-path last-write conflicts, lost updates, non-monotonic ref history, fetch/merge behavior on the shadow ref).
2. Enumerate at least two viable approaches with bounded tradeoffs. Candidates named in the source doc and obvious neighbors:
   - **Vector clocks** — correct concurrent-write detection; cost is per-path clock state that grows with machine count and needs pruning.
   - **Lamport timestamps** — cheaper, total order, but cannot distinguish concurrent from causal.
   - **Per-path manifest** (the doc's own alternative phrasing) — explicit per-path metadata rather than a clock.
   - **Last-writer-wins on wall clock** — simplest; document exactly which anomalies it accepts (clock skew, silent lost updates) and whether those are tolerable for `.omc/` artifacts specifically.
3. Recommend one, with the decision drivers made explicit (artifact type, expected machine count, tolerance for silent loss, implementation cost against a P3 priority).
4. Record it as an ADR.

**Files touched:**
- New: `docs/decisions/ADR-00Y-multi-machine-shadow-track-causality.md`
- Optionally: a pointer from `docs/DESIGN.md` follow-up (3) to the new ADR.

**Acceptance criteria:**
- A design doc / ADR exists proposing an approach for correct shadow-track behavior when the same repo's shadow state is touched from multiple machines.
- At least two options are presented with tradeoffs; one is recommended with stated drivers.
- If last-writer-wins is the recommendation, the accepted anomalies are documented explicitly rather than assumed away.
- The ADR states that implementation is a **separate future epic**, gated on this design being approved.

---

## Success Criteria

- Both documents exist and are committed.
- `docs/DESIGN.md` follow-ups (2) and (3) are each either resolved in place or point at the new document that resolves them.
- Zero production code changed by this epic.
- Total effort stayed proportionate to P3 — if either task starts sprawling, cut it back or return it to the icebox.

## Out of Scope

- Single-machine locking design (`plan-sync-bm3`).
- `docs/DESIGN.md` follow-up (1): org policy on ad hoc sibling-repo creation.
- `docs/DESIGN.md` follow-up (4): whether `.omx` uses `.omc`'s manifest/scope model.
- Implementing any causality mechanism, or migrating the transport to `git notes`.
