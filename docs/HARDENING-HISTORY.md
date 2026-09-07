# Hardening History: `safe-write.ts` / `manifest.ts` Containment Logic

This document exists because a planning review (`.omc/plans/go-port.md`) found that the
claim "this logic went through 5 rounds of adversarial security review" was not checkable
by anyone outside the session that did the review — it appeared in no committed artifact.
This document is the fix: a durable, file:line-anchored record of what was found, why it
mattered, and where the fix lives in the current source, so a Go port (or any future change
to this logic) has a real checklist to port/preserve against instead of a bare assertion.

**Honest scoping note**: the review rounds described below happened as iterative
Architect-agent review passes within a single working session (via the `ralph` execution
skill), not as separate, individually-committed changes — each round's fixes were folded
into the feature commits listed in git log (`e620d41`, `8dd851c`... see `git log --oneline
-- src/safe-write.ts src/manifest.ts`), not preserved as a per-round diff. This document is
reconstructed from that session's record and cross-checked against current source. It is
file- and symbol-anchored, not uniformly file:line-anchored — treat any given line number
below as a hint to re-locate, not a guarantee; the go-port plan's own re-verification pass
found one wrong anchor (finding 7, corrected below) after an earlier claim that these
citations had already been double-checked, which this document no longer asserts. This is
not a substitute for re-deriving and re-verifying each item against whatever the source
looks like at the time you read this — re-verify against current source, not against the
line numbers cited here.

## Round 1 — Initial implementation gaps

1. **Destructive scan-skip.** The shadow track's advisory secret-shape scan, on a match,
   originally dropped the matched file from the synced tree entirely. Chained with restore's
   deletion logic, editing an already-synced file to accidentally trip the scan caused the
   next `restore` to delete the user's local copy. **Fix**: scan-matched files now retain
   their previous synced content instead of being dropped (`src/tracks/shadow/push.ts`,
   scan-skip branch).
2. **Crash on ordinary file deletion.** Deleting a manifest-listed file without also editing
   the manifest crashed `push` with an unhandled `ENOENT`, freezing the shadow-track backup
   at a stale tree. **Fix**: `push` now skips a missing source file gracefully.
3. **Manifest path traversal.** `allow ../../etc/passwd` was accepted verbatim into the
   manifest; only git's own repo-boundary check caught it downstream, after an out-of-bounds
   local write had already happened. **Fix**: `src/manifest.ts`'s `isPathContained` (current
   implementation) rejects absolute paths and `../` traversal in `addToManifest` (fail-fast,
   before any write) and filters them with a warning in `readManifest` (skip-and-warn, so one
   bad hand-edited line doesn't invalidate the rest).
4. **Symlink dereference on push (read side).** A symlink under `.omc/` had its *target's*
   content synced, in both tracks' push implementations. **Fix**: both push paths `lstat`
   the source and skip (with a logged warning) if it's a symlink, rather than dereferencing.

## Round 2 — Re-verification found new gaps in the round-1 fixes

5. **Whole-manifest deletion silently discarded.** Deleting *every* manifest-listed file and
   pushing hit a "nothing to push" short-circuit gated on survivor *count*, not tree
   *identity* — so the deletion never committed, and the old (stale) tree stayed live. A
   subsequent `restore` on a fresh clone then resurrected all the "deleted" files. **Fix**:
   the shadow push's "nothing changed" check now compares the new tree's SHA against the
   previous tip's tree SHA, not the survivor count (`src/tracks/shadow/push.ts`).
6. **Incomplete symlink guard (write side).** A destination-write guard existed but only
   covered 2 of what should have been more call sites, and — separately — the guard itself
   used `fs.existsSync` (which follows symlinks) rather than `fs.lstatSync`, so a **dangling**
   symlink at the destination was not detected as a symlink at all and got silently
   created-through.

## Round 3 — Re-verification found the round-2 guard was still bypassable

7. **`existsSync` vs `lstatSync` (confirmed exploitable).** Reproduced: a dangling symlink at
   a manifest-listed destination path was silently created-through by `restore`, because the
   existence check followed the link. **Fix**: `src/safe-write.ts`'s containment check uses
   `fs.lstatSync(path, {throwIfNoEntry: false})`, which reports the dangling symlink itself
   (not "path doesn't exist") without following it — the call lives in `isSafeDestination`
   (`src/safe-write.ts:43-57`, the `lstatSync` call itself at `:45`; corrected from an earlier
   version of this document that cited `:28-38`, which is inside this file's doc comment, not
   the check itself).
8. **Immediate-parent-only ancestor check.** The guard checked only the destination's
   immediate parent directory for a symlink, so a symlinked ancestor two or more directory
   levels up (where the immediate parent doesn't exist on disk yet) was never checked, and
   `mkdirSync(..., {recursive:true})` walked straight through it. **Fix**:
   `resolveRealPath`/`isSafeDestination` walk up to the **nearest existing ancestor** before
   comparing realpaths, not just the immediate parent (`src/safe-write.ts:74-90`, per the
   go-port review's citation).
9. **`process.cwd()` vs. the actual git repo root.** Root-directory resolution used raw
   `process.cwd()` in several places, which could disagree with the git repository's actual
   top level (e.g. running from a subdirectory), causing a push from a subdirectory to
   silently commit an empty tree — which a `restore` elsewhere then read as "genuinely
   deleted," destroying real local files with no attacker required. **Fix**: repo-root
   resolution is anchored via `git rev-parse --show-toplevel`
   (`src/repo-root.ts`), not raw `process.cwd()`.
10. **Missing-vs-empty manifest conflated.** A missing manifest file and a genuinely empty
    one were treated identically, so — combined with finding 9 — a push from the wrong
    directory could commit an empty tree indistinguishable from a legitimate whole-manifest
    deletion. **Fix**: `src/manifest.ts`'s `manifestExists()` distinguishes the two; the
    shadow push refuses (rather than committing an empty tree) when the manifest file is
    missing entirely and a real previous tip exists on the ref.

## Round 4 — Re-verification found the guard was only wired into some call sites

11. **Guard applied as a predicate, not a choke point.** The round-3 fix produced a correct
    `isSafeDestination`-style predicate, but it was only *called* at 3 of the (eventually) 7
    actual destination-mutation sites across both tracks (`restore`'s write path and
    `sibling/push`'s two copy sites were guarded) — `restore`'s delete path,
    `sibling/pull`'s copy-in and delete-propagation, and `sibling/push`'s deletion branch
    were all found unguarded (4 sites), each independently reproduced as a live escape.
    **Fix**:
    `src/safe-write.ts` was refactored from a bare predicate into safe *operation* functions
    — `safeWriteFile`/`safeCopyFile`/`safeRemove` — that are the only way any track mutates a
    destination; a structural test (`test/no-unguarded-writes.test.ts`) scans for any
    raw, unguarded `fs.rmSync`/`writeFileSync`/`copyFileSync` call outside this module, so a
    future missed call site fails CI rather than requiring another review round to find.
12. **Guard could throw instead of failing closed.** An unexpected filesystem error during
    the containment check itself (e.g. `ENOTDIR` on a regular-file ancestor, `ENOENT`
    resolving a dangling-symlink ancestor's realpath) could propagate as an uncaught
    exception, aborting an entire push/restore mid-run rather than just skipping the one
    unsafe path. **Fix**: the containment check's realpath/lstat resolution is wrapped in
    try/catch that treats any such error as "unsafe, refuse" (`src/safe-write.ts`).

## Round 5 — Final adversarial pass, approved with 3 non-blocking follow-ups

Confirmed: the choke-point refactor closed every prior finding, all 7 destination-mutation
call sites route through `safeWriteFile`/`safeCopyFile`/`safeRemove`, and the structural test
genuinely walks the whole `src/tracks/` tree rather than a fixed file list. Three items were
explicitly logged as accepted, non-blocking follow-ups rather than being fixed immediately —
**these are load-bearing for anyone porting this logic, since they are known, current,
real gaps, not historical ones**:

- **F1 — `safeRemove` is not directory-safe.** `fs.rmSync(destPath, {force:true})` (no
  `recursive:true`) is called outside the function's own try/catch, so a directory at a
  manifest-derived destination throws `ERR_FS_EISDIR` uncaught, aborting the whole
  operation. **Explicit warning inherited from the original review**: do not fix this by
  adding `recursive:true` — that would grant `restore` recursive directory-tree delete
  authority driven by a prefix-matching ref-history check, which is a strictly worse,
  broader authority than the guard is supposed to grant. The correct fix (not yet done) is
  rejecting directory entries in `addToManifest` plus an explicit `isDirectory` check in
  `safeRemove` that refuses (rather than crashes) on a directory.
- **F2 — the structural regression test's scope is narrower than "every destination
  mutation."** `test/no-unguarded-writes.test.ts` scans only `src/tracks/`, and its forbidden
  pattern list covers `rmSync`/`writeFileSync`/`copyFileSync` but not `appendFileSync` or
  `renameSync` — meaning three real raw writes outside its scan
  (`src/manifest.ts`'s own `appendFileSync`/`writeFileSync`, `src/sync-config.ts`'s
  `writeFileSync`) are not covered. These are currently defensible (tool-owned config, not a
  manifest-derived destination path), but the test's coverage should not be assumed broader
  than it actually is.
- **F3 — hardlink write-through.** A hardlink at a destination path to a file outside the
  containment root is written through, since `realpath`-based containment has no notion of a
  hardlink's "other name" and `lstat` reports it as an ordinary regular file. Requires the
  attacker to already have write access inside the containment root; no current acceptance
  criterion covers it. A temp-file-then-`rename` write pattern would close this (and also
  closes the check-then-act TOCTOU window between the containment check and the actual
  write, which was never separately raised as its own finding but is the same underlying
  gap).

## What this means for a port to another language/runtime

Every fix above depends on a specific, verified primitive behavior in the TS/Node runtime.
**Do not assume the equivalent primitive in another runtime behaves the same way — verify
it empirically first**, the same way each of these was found by executing the actual
runtime, not by reasoning from documentation. In particular, for a Go port:

- Round 3's fix (finding 7) depends on `fs.lstatSync(path, {throwIfNoEntry:false})`
  suppressing *only* `ENOENT` and still throwing (propagating to the outer fail-closed catch)
  on `ENOTDIR`/`EACCES`/`ELOOP`. Go's `os.Lstat` returns an ordinary `error` for all of these
  with no built-in distinction — a naive `if err != nil { treat as absent, keep walking }`
  silently converts the fail-**closed** `ENOTDIR`/`EACCES`/`ELOOP` case into fail-**open**,
  which is exactly the class of gap round 3 exists to prevent. The Go port must explicitly
  distinguish `errors.Is(err, fs.ErrNotExist)` from every other error class.
- Round 3's fix (finding 8) depends on `fs.realpathSync` and the walk-up loop's exact
  ancestor-resolution order; Go's `filepath.EvalSymlinks` has different behavior on a
  dangling final component and different case-sensitivity/prefix semantics on Windows —
  verify both before assuming parity.
- F1's directory-safety gap (`fs.rmSync` without `recursive`) has a different Go analogue:
  `os.Remove` errors on a non-empty directory but *succeeds* on an empty one — not the same
  failure shape as Node's `EISDIR`, and must be independently decided, not assumed inherited.
