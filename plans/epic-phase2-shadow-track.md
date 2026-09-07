# Epic: Go Port Phase 2 — Shadow Track Plumbing (`plan-sync-m02`)

Status: **ready to seed as beads child tasks**
Parent design doc: [`.omc/plans/go-port.md`](./go-port.md) (v3, Option B′, 3 phases)
Scope: bring `go/internal/tracks/shadow/` to behavioral parity with
`src/tracks/shadow/{push,status,uninstall,scan}.ts`, plus the `uninstall`
command that Phase 1 deliberately did not ship at all.

---

## Context

Phase 1 landed the complete containment surface (`internal/safewrite`,
`internal/manifest`, `internal/glob`, `internal/root`, `internal/reporoot`,
`internal/syncconfig`, `internal/shadowpaths`), the full sibling track, and the
shadow track's `Init` + `Restore`. `go/internal/tracks/shadow/` today contains
exactly three files: `git.go`, `init.go`, `restore.go`.

Phase 2's remaining TS surface is ~690 lines across four modules:

| TS module | Lines | Go target | Status |
|---|---|---|---|
| `src/tracks/shadow/scan.ts` | 61 | `go/internal/tracks/shadow/scan.go` | not started |
| `src/tracks/shadow/push.ts` | 303 | `go/internal/tracks/shadow/push.go` | not started |
| `src/tracks/shadow/status.ts` | 235 | `go/internal/tracks/shadow/status.go` | not started |
| `src/tracks/shadow/uninstall.ts` | 58 | `go/internal/tracks/shadow/uninstall.go` | not started |
| `src/commands/uninstall.ts` | 38 | `go/internal/commands/uninstall.go` | not started (no `uninstall` command in the Phase 1 binary) |

`go-port.md` states Phase 2 is "verified by construction (tree/blob-SHA
diffing) for its git-plumbing logic" **with two struck exceptions** that must
carry a scoped containment gate (v3, M2 in the Changelog; Follow-up 5):

1. `shadow/uninstall.ts:37`'s
   `fs.rmSync(shadowRepoPath, {recursive:true, force:true})` on an
   **environment-derived** path (`PLAN_SYNC_STATE_DIR`).
2. `shadow/push.ts:257`'s temp-directory cleanup
   (`fs.rmSync(path.dirname(indexFile), {recursive:true, force:true})`).

`go-port.md` also moves the **full observability AC** (broken `push`, `status`
staleness, `--stale-after 0h`) from Phase 1 into Phase 2 (C1 in the Changelog),
and requires Tier-2 parity on the resulting `status` staleness signal.

### Hard constraint discovered while planning (drives task ordering)

`go/internal/structuralcheck/nounguardedwrites_test.go` forbids
`os.RemoveAll(`, `os.Remove(`, `os.Create(`, `os.OpenFile(`, `os.WriteFile(`,
`os.Rename(`, and `io.Copy(` in **every** non-`_test.go` file outside
`internal/safewrite`, with a documented allowlist that today contains only
`internal/manifest` and `internal/syncconfig`. Both Phase 2 recursive deletes
(uninstall's shadow-repo teardown, push's temp-index cleanup) need
`os.RemoveAll`. Neither `push.go` nor `uninstall.go` can compile past CI
without a **sanctioned primitive in `internal/safewrite` first** — and
`internal/tracks/shadow/` currently has zero allowlist entries, a property
`nounguardedwrites_test.go:56-61` explicitly documents and that Phase 2 must
not break. This is why the containment-gate work splits into a **part A
(primitives, blocking)** and a **part B (scoped adversarial review, closing)**.

### Established Go-side patterns Phase 2 must follow

- **Errors**: return `error`, never panic. Wrap with `fmt.Errorf("<command>
  --track shadow: ...: %w", err)`. Tool-authored message text matches the TS
  string byte-for-byte; embedded subprocess stderr is Tier 3 (clear + names the
  failing op, wording not required to match).
- **Git**: `git.go`'s `runGit` / `runGitBytes` / `runGitBytesBounded` /
  `tryGit` / `gitDirFlag`. `tryGit` is the shape of TS's
  `try { execFileSync } catch { return undefined }` helpers.
- **Mutations**: everything through `internal/safewrite`. No raw stdlib writes.
- **Seams**: shadow entry points are reached through the package-level function
  variables in `go/internal/commands/shadow.go` so tests can swap them.
- **Tests**: `go/internal/tracks/shadow/helpers_test.go`'s `fixture` — hermetic
  anchor repo + bare origin + `PLAN_SYNC_STATE_DIR`, `t.Chdir`,
  `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/`GIT_TERMINAL_PROMPT=0`,
  `filepath.EvalSymlinks(t.TempDir())`. `commitFixtureTree` exists because
  `push` was Phase 2; once `Push` lands, tests should prefer real pushes where
  the TS test does.
- **Subprocess e2e**: `go/cmd/plan-sync-go/main_test.go`'s `buildBinary` /
  `execBinary` harness. Cross-implementation parity lives in
  `test/e2e/parity.test.ts` (TS side, builds the Go binary and diffs both).

---

## Task Flow

```
P2-1 scan ─────────────┐
                       ├──> P2-3 push ──┬──> P2-5 status ──┐
P2-2 containment ──────┤                │                  ├──> P2-6 e2e + parity + review gate
   primitives (part A) └──> P2-4 uninstall ─────────────────┘
```

`P2-1` and `P2-2` are independent and can run in parallel. `P2-3` and `P2-4`
both hard-depend on `P2-2`. `P2-5` and `P2-4` have a *soft* dependency on
`P2-3` (their TS tests create ref state via a real `push`; without it they'd
have to keep using `commitFixtureTree`, which is strictly worse coverage).
`P2-6` depends on all of them.

---

## Task P2-1 — Port the advisory secret-shape scan (`scan.ts` → `scan.go`)

**Effort: S** · **Depends on: nothing**

### Files
- create `go/internal/tracks/shadow/scan.go`
- create `go/internal/tracks/shadow/scan_test.go`

### Design
Export `ScanForSecrets(content []byte) []string`. Take `[]byte`, not `string` —
`push` reads file bytes and `regexp` matches on bytes natively, so this avoids a
lossy round-trip through `string` for non-UTF-8 content (TS reads
`fs.readFileSync(filePath, "utf8")`, which lossily replaces invalid sequences;
document the divergence in the doc comment).

Four pattern classes, compiled once at package level with `regexp.MustCompile`,
**returned in this exact order** (push joins them with `", "` into user-visible
stderr, so order is part of the output contract):

| label | Go pattern |
|---|---|
| `jwt` | `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` |
| `pem` | `(?s)‑----BEGIN.*?‑----` |
| `ssn` | `\b\d{3}-\d{2}-\d{4}\b` |
| `api-key` | `(?i)\b(sk\|pk\|api[_-]?key)[_-][A-Za-z0-9]{16,}\b` |

`go-port.md` Principle 2 already confirmed all four use no
lookaround/backreferences and compile under RE2. `[\s\S]` → `(?s).`; lazy `*?`
is supported by RE2; `\b` is ASCII-only in both JS's non-`u` `RegExp` and Go's
`regexp`, so it is a parity match.

### Acceptance criteria
- [ ] All six cases in `test/tracks/shadow/scan.test.ts` are ported 1:1 to
  `scan_test.go` and pass: JWT-shaped, PEM header, SSN-shaped, API-key-shaped,
  clean content → empty slice, multi-class content → multiple labels.
- [ ] Multi-class case asserts the **exact slice** `[]string{"jwt","pem"}`
  (order, not just set membership).
- [ ] Clean content returns a non-nil empty slice (`[]string{}`), matching TS's
  `[]`, so `len(matches) > 0` is the only branch condition push needs.
- [ ] A table-driven parity test feeds ≥12 fixture strings (the 6 TS cases plus:
  a `sk-` token of exactly 15 chars → no match, exactly 16 → match; an SSN
  embedded mid-word → no match; a `‑----BEGIN` with no closing `‑----` → no
  match; a multi-line PEM block → match; content containing a non-BMP emoji
  adjacent to a match → still matches) and asserts each against the labels the
  TS implementation produces for the same input.
- [ ] `go vet ./...` and `go test ./internal/tracks/shadow/...` pass.
- [ ] `internal/structuralcheck` still passes with **no new allowlist entry**.

---

## Task P2-2 — Containment gate, part A: sanctioned recursive-delete + temp-dir primitives

**Effort: M** · **Depends on: nothing** · **Blocks: P2-3, P2-4**

This is the scoped containment gate `go-port.md` v3 requires for Phase 2,
implementation half. The review half is P2-6.

### Files
- change `go/internal/safewrite/safewrite.go`
- change `go/internal/safewrite/safewrite_test.go`
- change `go/internal/shadowpaths/shadowpaths.go`
- change `go/internal/shadowpaths/shadowpaths_test.go`

### Design

**1. `safewrite.SafeRemoveTree(root, destPath string) bool`**

A containment-checked recursive delete — the sanctioned counterpart to
`fs.rmSync(p, {recursive:true, force:true})`. Contract:

- Runs `isSafeDestination(root, destPath)` **first and unconditionally**,
  before any existence check — same ordering and rationale as `SafeRemove`
  (`safewrite.go:315-328`).
- Additionally refuses when `destPath` is not a **strict descendant** of
  `root` after real-path resolution (`destPath == root` is refused; this is the
  case `SafeRemove` never had to consider because it only ever removed leaves).
- Existence via `os.Lstat`, never `os.Stat` — a dangling symlink must not read
  as absent (`safewrite.go:302-310`'s rationale).
- Genuinely absent → no-op, reports `true`.
- Deletes the **link itself**, never its target, when `destPath` is a symlink
  (`os.RemoveAll` already has this property; assert it rather than assume it).
- Any other resolution error → refuse (`false` + stderr warning), matching the
  fail-closed classification `resolveRealPath` established (Pre-mortem 1).
- `os.RemoveAll` is called **only here**; `internal/safewrite` remains the sole
  package containing it.
- Document explicitly that this is a *different* contract from `SafeRemove`,
  and that F1 (`safeRemove` not directory-safe, `docs/HARDENING-HISTORY.md`)
  does **not** transfer — `SafeRemoveTree` is deliberately directory-capable and
  is therefore restricted to a tool-owned containment root, never a
  manifest-entry-derived path.

**2. `safewrite.MakeTempDir(prefix string) (dir string, cleanup func(), err error)`**

Wraps `os.MkdirTemp(os.TempDir(), prefix)` and returns an **idempotent**
`cleanup` that removes the directory via `SafeRemoveTree(os.TempDir(), dir)`.
`cleanup` must be safe to call twice, must no-op on an empty `dir`, and must
never remove `os.TempDir()` itself. This is what makes push's `finally`-block
cleanup expressible as a plain `defer` without a raw `os.RemoveAll` in
`tracks/shadow`.

**3. `shadowpaths.ResolveShadowStateRoot() (string, error)`**

Returns the containment root that *contains* the shadow repo path, matching
`ResolveShadowRepoPath`'s two structurally-different branches
(`shadowpaths.go:105-127`):

- `PLAN_SYNC_STATE_DIR` set (non-empty) → that directory.
- else → `${XDG_CACHE_HOME:-<homeDir()>/.cache}/plan-sync-shadow`.

Must reuse the same `homeDir()` (the `os/user` passwd-fallback helper, *not*
`os.UserHomeDir`) so the two functions can never disagree about where state
lives. Uninstall's containment root is this, **not** `omcRoot` — it is the
second, previously-untested containment root Phase 2 introduces.

### Acceptance criteria
- [ ] `SafeRemoveTree` refuses and returns `false`, leaving everything on disk,
  for each of: `destPath` outside `root`; `destPath == root`; `destPath`
  reached through a **live symlinked ancestor** pointing outside `root`;
  `destPath` reached through a **dangling symlinked ancestor**; `destPath`
  whose ancestor is a **regular file** (`ENOTDIR` → fail-closed, not
  "absent, keep walking" — Pre-mortem 1); a `..`-traversal `destPath`.
  One test case per condition, each asserting a stderr warning was emitted
  **and** that the outside content still exists unchanged afterwards.
- [ ] `SafeRemoveTree` on a genuinely absent path returns `true` and writes
  nothing to stderr.
- [ ] `SafeRemoveTree` on a directory tree ≥3 levels deep with mixed
  files/subdirectories/symlinks removes it entirely and returns `true`.
- [ ] `SafeRemoveTree` on a **symlink at `destPath`** whose target is a
  populated directory *inside* `root` removes only the link; the target
  directory and its contents still exist afterwards.
- [ ] `MakeTempDir`'s `cleanup` is idempotent (calling it twice is not an
  error), no-ops on a zero-value dir, and a test asserts `os.TempDir()` itself
  still exists after a cleanup of a dir created directly beneath it.
- [ ] `ResolveShadowStateRoot` returns a strict prefix of
  `ResolveShadowRepoPath(projectId, rootDir)` for **all three** env branches:
  `PLAN_SYNC_STATE_DIR` set; `XDG_CACHE_HOME` set; both unset (`$HOME`-derived).
  Asserted as `filepath.Rel(stateRoot, repoPath)` yielding a relative path with
  no leading `..` element, not as a string-prefix check.
- [ ] `ResolveShadowStateRoot` propagates `root.RootSegment`'s rejection for a
  `--root` of `"..."` (the reproduced live escape, `go-port.md` Risks table) —
  no path is returned and no delete can be attempted.
- [ ] `internal/structuralcheck` passes; `os.RemoveAll` appears **only** in
  `internal/safewrite`; `internal/tracks/shadow/` gains **zero** allowlist
  entries.

---

## Task P2-3 — Port `push --track shadow` (`push.ts` → `push.go`)

**Effort: L** · **Depends on: P2-1 (scan), P2-2 (temp-dir primitive)**

### Files
- create `go/internal/tracks/shadow/push.go`
- create `go/internal/tracks/shadow/push_test.go`
- change `go/internal/tracks/shadow/git.go` (add a `runGitEnv(env []string,
  argv ...string)` variant — the `GIT_INDEX_FILE` plumbing needs an env
  override that `runGit` does not provide today)
- change `go/internal/commands/shadow.go` (`ShadowPush = shadow.Push`, delete
  the Phase-2 stub)
- change `go/internal/commands/commands_test.go` (the stub-message assertion
  becomes a real-dispatch assertion)
- change `go/internal/tracks/shadow/git.go`'s package doc comment (it currently
  says "push/status/uninstall/scan are Phase 2 and deliberately absent")

### Design
Straight port of `src/tracks/shadow/push.ts`'s `run`, preserving every branch
and every stderr string. In order:

1. `--root` flag → `reporoot` → `root.ResolveRootDir` → `ResolveProjectId` →
   `ResolveShadowRepoPath`.
2. Missing shadow repo → error, exact TS text (`push --track shadow: no shadow
   repo found at %s — run \`plan-sync init --track shadow\` first`).
3. `previousTip` via a `tryRevParse`-equivalent (`tryGit(gitDir, "rev-parse",
   "--verify", refName)`, empty string ⇒ absent).
4. **Manifest-missing-but-previous-tip-exists guard** — refuse rather than
   commit an empty tree (`push.ts:68-72`). This is the guard that stops a later
   `restore` from mass-deleting.
5. `manifest.ResolveManifestSyncCandidates(manifestPath)`.
6. Temp index dir via `safewrite.MakeTempDir("plan-sync-shadow-index-")` +
   `defer cleanup()`; `GIT_INDEX_FILE=<dir>/index` via `runGitEnv`.
7. Per candidate: absent on disk → stderr skip, continue (this absence is the
   *one* legitimate deletion signal restore relies on); symlink (`os.Lstat` +
   `ModeSymlink`) → stderr skip, continue; scan match → carry the previous
   tip's blob forward via `ls-tree` + `update-index --add --cacheinfo
   <mode>,<sha>,<path>` and count it as surviving, else genuine skip (the scan
   is **advisory only and never has delete authority**); otherwise
   `hash-object -w` + `update-index --add --cacheinfo 100644,<sha>,<path>`.
8. Stage the manifest's own raw bytes unconditionally (unless it is a symlink),
   never scanned, **excluded from `surviving`**.
9. `write-tree`; if `previousTip` and `<tip>^{tree}` == new tree → "nothing
   changed since the last push", return nil; else if no `previousTip` and
   `len(surviving) == 0` → "nothing to push (...)", return nil.
10. `commit-tree <tree> [-p <tip>] -m "plan-sync: sync N file(s)"`.
11. `git push origin <commit>:<ref>` — **plain, non-force**; the ordinary
    non-fast-forward rejection *is* the concurrency mechanism. Wrap failure with
    the TS message shape.
12. `update-ref <ref> <commit>` to mirror the tip locally.

### Acceptance criteria
- [ ] All 11 cases in `test/tracks/shadow/push.test.ts` are ported to
  `push_test.go` and pass: uninitialized-repo error; scan-skip + warning +
  rest still synced; skip commit entirely when nothing survives; sequential
  pushes parent via `commit-tree`; scan-matched file's prior blob **retained**
  in the new tree (non-destructive scan-skip); locally-deleted manifest-listed
  path skipped without crashing and genuinely absent from the new tree; "N1"
  delete-everything push commits the now-different tree and restore does not
  resurrect; concurrent same-machine push rejected by git's plain
  non-fast-forward check; push from a subdirectory resolves the identical
  project-id and ref; refuses to push when the manifest file is missing (not
  just empty) while a previous tip exists; a symlink under `<rootDir>/` pointing
  outside the repo is skipped, not dereferenced.
- [ ] **Tier 1 parity**: for an identical repo + manifest + file state,
  `git ls-tree -r <ref>` output and every blob SHA are byte-identical between
  `pnpm plan-sync push --track shadow` and `plan-sync-go push --track shadow`,
  including CRLF and non-UTF-8 file content (the `core.autocrlf=false` +
  `* -text` round-trip `Init` pins). The commit message is byte-identical.
- [ ] **Tier 2 parity**: every tool-authored stderr line matches the TS text
  byte-for-byte — the four skip/retain warnings (`push.ts:101-103,108-111,
  138-140,143-146`), "nothing changed since the last push", "nothing to push
  (no manifest files, or all were skipped by the advisory scan)". Only the
  embedded git stderr in the push-rejected error is Tier 3.
- [ ] **Temp-dir cleanup (containment gate)**: a test sets `TMPDIR` to a fixture
  directory, snapshots its entry count, and asserts the count is unchanged after
  **each** of these exit paths: successful push; "nothing changed" early return;
  "nothing to push" early return; `hash-object` failure; `write-tree` failure;
  push-rejected error; a panic-free error returned from any staging step. No
  temp directory is leaked and nothing outside the created temp directory is
  removed.
- [ ] The temp-dir cleanup path is exercised with a symlink planted at the temp
  directory's location and asserts `SafeRemoveTree` refuses rather than deleting
  through it.
- [ ] `commands.ShadowPush` is wired to `shadow.Push`; the Phase-2 stub message
  is gone from `shadow.go` and from `commands_test.go`.
- [ ] `internal/structuralcheck` passes with **no new allowlist entry** for
  `internal/tracks/shadow/`.

---

## Task P2-4 — Port `uninstall --track shadow` + ship the `uninstall` command

**Effort: M** · **Depends on: P2-2 (hard: `SafeRemoveTree` +
`ResolveShadowStateRoot`); P2-3 (soft: tests want a real pushed ref to delete)**

This is the second half of the scoped containment gate — the recursive delete on
an **environment-derived** path that `go-port.md` v3 explicitly struck from the
"verified by construction" claim.

### Files
- create `go/internal/tracks/shadow/uninstall.go`
- create `go/internal/tracks/shadow/uninstall_test.go`
- create `go/internal/commands/uninstall.go`
- change `go/internal/commands/shadow.go` (add `ShadowUninstall =
  shadow.Uninstall`)
- change `go/internal/commands/commands_test.go`
- change `go/internal/cli/cli.go` (add `uninstall` to `Usage`, add it to
  `mutatingCommands` — it deletes a remote ref and a local repo; update the
  package doc comment's "exactly six commands / no uninstall" statement)
- change `go/internal/cli/cli_test.go`
- change `go/cmd/plan-sync-go/main.go` (register `cli.Commands["uninstall"]`)
- change `go/cmd/plan-sync-go/main_test.go`

### Design
`shadow.Uninstall(argv []string) error`, port of
`src/tracks/shadow/uninstall.ts`:

1. Resolve `--root` → repo root → root dir → project id → shadow repo path →
   ref name. `RootSegment` already re-validates its own output
   (`root.go:103-112`), so `--root "..."` fails here, before anything is
   deleted.
2. If the shadow repo path exists, delete the remote ref via
   `git --git-dir=<path> push origin --delete <ref>`, tolerating
   `/remote ref does not exist/i` in the combined stderr as a **successful
   no-op**, and surfacing every other failure (auth/network) as an error with
   the TS message shape.
3. Recursively remove the local shadow repo via
   `safewrite.SafeRemoveTree(shadowpaths.ResolveShadowStateRoot(), shadowRepoPath)`.
4. **Never** touch the anchor repo's `.git/info/exclude` entry or the shared
   manifest — both are shared with the sibling track.

`commands.Uninstall(argv []string) error`, port of `src/commands/uninstall.ts`:
`--help` first (help text byte-identical to `HELP_TEXT` at `uninstall.ts:7-15`),
then `resolveContext`, then `resolveTrack("uninstall", ...)`; shadow →
`ShadowUninstall(rest)`; sibling → the exact TS error ("only the shadow track
has teardown state to remove — sibling-track cleanup is an ordinary 'rm -rf
<clone-path>'").

**Decision required, and it is a real divergence (flagged, not invented):** TS
gates the remote-ref delete on `fs.existsSync` (which **follows** symlinks),
while Phase 1's Go shadow code uses `os.Lstat` (which does not) with an
explicitly documented rationale (`restore.go:84-87`). These disagree when a
**dangling symlink** is planted at the shadow repo path: TS skips the remote
delete and then removes the link; a naive `os.Lstat` port would attempt a
remote delete against a broken `--git-dir` and fail the whole command.
**Required behavior:** use `os.Stat` (TS-matching, follows) for the
*remote-delete gate*, and let `SafeRemoveTree`'s own `os.Lstat` govern the
*removal*. Document the split and why in the function's doc comment.

### Acceptance criteria
- [ ] All four cases in `test/tracks/shadow/uninstall.test.ts` are ported and
  pass: removes the local shadow repo directory **and** the remote ref after
  `init` + `push`; does **not** touch the anchor repo's exclude entry or
  manifest; is a safe no-op when there is nothing to uninstall; tolerates the
  remote ref already being absent (a second `uninstall` run succeeds).
- [ ] **Containment (gate)**: a test plants a symlink at `shadowRepoPath`
  pointing at a populated directory **outside** the state root and asserts
  `uninstall` removes only the link, the outside directory and all its contents
  survive unchanged, and a refusal/warning appears on stderr where applicable.
- [ ] **Containment (gate)**: a test where `PLAN_SYNC_STATE_DIR` is set such
  that a **live symlinked ancestor** of `shadowRepoPath` resolves outside the
  state root asserts the delete is refused, `uninstall` reports a clear error or
  warning, and nothing outside the state root is removed.
- [ ] **Containment (gate)**: `plan-sync-go uninstall --track shadow --root
  "..."` exits non-zero with a clear error and performs **zero** filesystem
  deletions and **zero** remote-ref pushes (asserted by snapshotting the state
  dir and the origin's ref list before and after).
- [ ] **Containment (gate)**: no invocation of `uninstall` can delete
  `ResolveShadowStateRoot()` itself, `os.TempDir()`, the anchor repo, or
  `<repoRoot>/<rootDir>/` — one explicit negative test per target.
- [ ] The dangling-symlink-at-`shadowRepoPath` case behaves identically to the
  TS implementation (exit code and post-state), per the `os.Stat`/`os.Lstat`
  decision above, with the divergence documented in the doc comment.
- [ ] `plan-sync-go uninstall --help` output is byte-identical to
  `pnpm plan-sync uninstall --help`.
- [ ] `plan-sync-go uninstall --track sibling` produces the exact TS error text
  and exit code 1.
- [ ] `uninstall` appears in `cli.Usage` in the same position as the TS
  `USAGE`, and emits the stderr identity marker `plan-sync: go/0.1.0
  (uninstall)` (it is a mutating command; the TS side already lists it).
- [ ] `internal/structuralcheck` passes with **no new allowlist entry** for
  `internal/tracks/shadow/` or `internal/commands/`.

---

## Task P2-5 — Port `status --track shadow` (`status.ts` → `status.go`)

**Effort: M** · **Depends on: P2-3 (soft — its tests create ref state via a real
`push`, matching the TS tests)**

### Files
- create `go/internal/tracks/shadow/status.go`
- create `go/internal/tracks/shadow/status_test.go`
- create `go/internal/tracks/shadow/status_perfile_test.go`
- change `go/internal/commands/shadow.go` (`ShadowStatus = shadow.Status`,
  delete the Phase-2 stub)
- change `go/internal/commands/commands_test.go`

### Design
Port of `src/tracks/shadow/status.ts`. Output **ordering** is part of the
contract and is easy to get wrong — TS prints the per-file report *before* the
"shadow repo initialized at" line (`status.ts:50,54`). Exact sequence:

1. Parse `--stale-after` off `args`, then `--root` off the **remainder**
   (`status.ts:29-30`) — flag-parse order is observable when both are present.
   Default `24h`.
2. `parseDuration`: `^(\d+)\s*(h|d|m)$` (h/d/m ⇒ hours/days/minutes), invalid ⇒
   error with the exact TS text.
3. No shadow repo ⇒ print `plan-sync: shadow repo not initialized (no repo at
   %s)` to **stdout**, then return the error `STALE: shadow repo not
   initialized — no push has ever happened` (non-zero exit).
4. Best-effort `tryFetchRef` (failure silently tolerated).
5. Per-file report: for each `ResolveManifestSyncCandidates` entry, classify as
   `in sync` / `pending (local changes)` / `pending (never synced)` /
   `missing locally` via `ls-tree` blob SHA vs. local `hash-object`; one line
   each, then the summary line with all four counts.
6. `plan-sync: shadow repo initialized at %s`.
7. Last-push timestamp via `git log -1 --format=%cI <ref>`; absent ⇒ print
   `plan-sync: no push has ever happened` and return `STALE: no push has ever
   happened`.
8. `plan-sync: last push %s (%s)` with the human age and the raw ISO string.
9. Over threshold ⇒ print the `STALE: ...` line to stdout **and** return an
   error with the identical text (TS does both, `status.ts:66-71`).
10. Else `OK\n`.

`formatAge` must reproduce JS `Math.round` (half **away from zero**; Go's
`math.Round` matches) and the exact singular/plural boundaries at 60s / 3600s /
86400s. `Date.now() - Date.parse(iso)` → parse `%cI` with
`time.Parse(time.RFC3339, ...)` and `time.Since`.

`status` is **read-only** and must stay out of `cli.mutatingCommands` (no
identity marker) — already correct in `cli.go:36-42`; assert it stays that way.

### Acceptance criteria
- [ ] All four cases in `test/tracks/shadow/status.test.ts` are ported and pass:
  reports not-initialized and returns an error (non-zero exit) with no shadow
  repo; reports `OK` with a recent timestamp right after a push; reports `STALE`
  and errors when the last push is older than `--stale-after`; treats a push
  whose commit timestamp was rewritten into the past as stale.
- [ ] The single case in `test/tracks/shadow/status-per-file.test.ts` is ported:
  one manifest entry per state, each reported with the correct one of the four
  labels, plus a correct summary count line.
- [ ] `--stale-after 0h` on a just-completed push reports `STALE` and exits
  non-zero (required by the Phase 2 observability AC).
- [ ] Invalid `--stale-after` values (`24`, `24x`, `h`, empty, `-1h`) each
  produce the exact TS error text and a non-zero exit.
- [ ] **Tier 2 parity**: `plan-sync-go status --track shadow` and `pnpm
  plan-sync status --track shadow` produce identical stdout for the same repo
  state **after normalizing only** the `formatAge` token; the ISO timestamp on
  the `last push` line, all per-file lines, the summary counts line, and the
  `OK`/`STALE` markers must match byte-for-byte. Per `go-port.md`, Tier-2
  parity on the `STALE` line means comparing the literal `STALE` marker text —
  that line carries no ISO timestamp to normalize against.
- [ ] Line **ordering** matches TS exactly (per-file report before the
  "initialized at" line), asserted on full captured stdout, not on
  substring containment.
- [ ] `status` emits **no** stderr identity marker (it is read-only); a test in
  `cli_test.go` asserts `mutatingCommands` still excludes it.
- [ ] `commands.ShadowStatus` is wired to `shadow.Status`; the Phase-2 stub is
  gone.

---

## Task P2-6 — Containment gate part B (scoped review) + Phase 2 e2e, observability, and cross-implementation parity

**Effort: L** · **Depends on: P2-1, P2-2, P2-3, P2-4, P2-5**

Closes the Phase 2 acceptance criteria `go-port.md` states explicitly
(Follow-up 5 and the "Observability parity, Phase 2 portion" AC).

### Files
- create `go/cmd/plan-sync-go/shadow_lifecycle_test.go` (reuses the existing
  `buildBinary` / `execBinary` harness in `main_test.go`)
- create `go/cmd/plan-sync-go/observability_test.go`
- change `test/e2e/parity.test.ts` (extend the shadow-track parity case from
  Phase 1's `init → pull` to the full `init → allow → push → status →
  fresh-machine pull → uninstall` round trip across both binaries)
- change `docs/HARDENING-HISTORY.md` (append the Phase 2 gate's findings ledger)
- create `.omc/plans/phase2-review-ledger.md` (MAJOR findings with owner +
  rationale, mirroring the F1/F2/F3 pattern)
- change `README.md` (drop the "Phase 1 cannot push/status/uninstall shadow
  state" limitation note that Phase 1 was required to publish)

### Acceptance criteria
- [ ] **Go e2e lifecycle**: a subprocess test drives the compiled binary through
  `init → allow → push → fresh-machine pull → checksum match → uninstall`,
  mirroring `test/e2e/shadow-lifecycle.test.ts`, and asserts byte-identical
  content on the restoring machine and complete teardown at the end.
- [ ] **Observability (the AC moved from Phase 1)**: an unreachable shadow-track
  `origin` causes `push` to exit non-zero with non-empty stderr; the real remote
  ref is left untouched; `status` still reports the last known-good push
  accurately; and `--stale-after 0h` correctly flags it `STALE`. Verified as a
  Go port of `test/e2e/observability.test.ts`.
- [ ] **Cross-implementation parity, Tier 1**: after an identical operation
  sequence, `git ls-tree -r <ref>` output, all blob SHAs, the manifest file
  bytes, `.sync-config.json` bytes, and all exit codes are identical whether the
  sequence ran through the TS binary or `plan-sync-go`. Includes a **mixed**
  sequence (TS pushes, Go pulls; Go pushes, TS pulls) since coexistence is the
  point.
- [ ] **Cross-implementation parity, Tier 2**: `status` stdout matches under the
  declared normalization (age token only) for a fresh push and for an
  identically-broken push condition on both binaries.
- [ ] **Cross-implementation parity, Tier 1**: `uninstall` through either binary
  leaves the same post-state — remote ref gone, local shadow repo gone,
  `.git/info/exclude` entry and manifest **untouched** — byte-compared.
- [ ] **Scoped adversarial review gate** (Architect + Critic, sequential, run by
  someone other than whoever wrote the code) covering exactly two surfaces:
  `uninstall`'s recursive delete on the environment-derived path, and `push`'s
  temp-directory cleanup semantics including every error path. Pass bar,
  matching Phase 1's: **zero CRITICAL findings**, and every MAJOR finding either
  fixed or logged with a named owner and rationale in the review ledger before
  Phase 2 is considered complete.
- [ ] `internal/structuralcheck` passes with `internal/tracks/shadow/` and
  `internal/commands/` holding **zero** allowlist entries, and
  `TestAllowlistEntriesStillExist` passes (no stale entries).
- [ ] `go build ./...`, `go vet ./...`, `go test ./...`, and `pnpm test` (all
  177+ TS tests) are green together.
- [ ] The Phase 1 "creates shadow state it cannot tear down" limitation note is
  removed from the CLI help text, the `push`/`status` stub messages are gone
  from the codebase entirely, and README no longer advertises the limitation.

---

## Guardrails

**Must have**
- Every recursive delete routes through `internal/safewrite`; the structural
  check passes with zero new `tracks/shadow` allowlist entries.
- Tool-authored user-visible strings are byte-identical to the TS original.
  Only embedded subprocess stderr is Tier 3.
- Push's advisory scan retains **never delete authority** — a scan-matched path
  that was previously synced carries its prior blob forward.
- Push uses a plain, non-force `git push`; the non-fast-forward rejection is the
  concurrency mechanism. No `--force-with-lease`, no custom lock.
- `uninstall` never touches `.git/info/exclude` or the manifest.

**Must NOT have**
- No `os.RemoveAll` / `os.Remove` / `os.WriteFile` / `os.Create` /
  `os.OpenFile` / `os.Rename` / `io.Copy` outside `internal/safewrite`.
- No new non-stdlib dependency (`go list -m all` shows only the module itself).
- No `GOOS=windows` work — still Phase 3's own gated sub-phase.
- No renaming the binary to `plan-sync` — still an explicit Phase 3 gate.
- No changes to Phase 1 containment semantics beyond the **additive**
  `SafeRemoveTree` / `MakeTempDir` / `ResolveShadowStateRoot`.
- No `test.skip`, no stub tests, no TODO placeholders as evidence of completion.

---

## Assumptions (made rather than blocking; flag any you disagree with)

1. **`ScanForSecrets` takes `[]byte`, not `string`.** TS reads the file as UTF-8
   (lossy for non-UTF-8 content); taking bytes in Go is strictly better and
   cannot change which files match in practice, since all four patterns are
   ASCII-only. Documented as a deliberate divergence.
2. **A new `SafeRemoveTree` in `internal/safewrite` is the right home for the
   recursive delete**, rather than an allowlist entry for `tracks/shadow`. This
   preserves the "zero exceptions in tracks/" property the structural check's
   own doc comment advertises.
3. **`shadowpaths.ResolveShadowStateRoot` is net-new API.** Uninstall's
   containment root is the shadow *state* root, not `omcRoot` — a second
   containment root Phase 1 never exercised.
4. **`uninstall` uses `os.Stat` for the remote-delete gate and `os.Lstat` (via
   `SafeRemoveTree`) for the removal**, resolving a genuine TS/Go divergence on
   a dangling symlink at the shadow repo path. See P2-4.
5. **Go e2e tests live in `go/cmd/plan-sync-go/`**, reusing the existing
   `buildBinary`/`execBinary` harness, rather than in a new `go/e2e/` package.
6. **`uninstall` is a mutating command** and therefore emits the stderr identity
   marker (the TS side already lists it).
7. **`status_test.go` and `uninstall_test.go` use a real `Push`** once P2-3
   lands, rather than `commitFixtureTree` — matching what the TS tests do. This
   is why P2-3 is sequenced first even though the dependency is soft.

---

## Scope questions worth a human decision

- **Does Phase 2 also fix the shipping TS `--root "..."` bug?** `go-port.md`
  says to file it against TS "independently of the Go port." Go's
  `root.RootSegment` already re-validates, so Go is safe; the TS side may still
  be exposed. Phase 2 could land the TS fix alongside, or leave it as a separate
  ticket.
- **F1/F2/F3 applicability for `SafeRemoveTree`.** Phase 1's blocking AC decided
  F1/F2/F3 for the *existing* functions. `SafeRemoveTree` is a new
  directory-capable primitive; whether F1's "not directory-safe" note is now
  partially superseded should be recorded in `docs/HARDENING-HISTORY.md` rather
  than left implicit.
- **Is the mixed-binary parity sequence (TS push → Go pull, Go push → TS pull)
  in scope for Phase 2 or Phase 3?** It is listed under P2-6 because Phase 2 is
  the first point at which a full round trip is even possible, but it is
  arguably a Phase 3 release-gate concern.
