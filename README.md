# plan-sync

`plan-sync` is a CLI for durably syncing the human-authored planning artifacts
in `.omc/` (and the planned `.omx/`) — plans, drafts, research notes,
handoffs, and similar files — to a remote, without those files ever showing
up in `git status`, `git diff`, or `git log` on your primary repository.

It offers two independent sync tracks:

- **Part A — sibling git repo** (`--track sibling`): sync `.omc/` content
  into an ordinary sibling git repository using real git semantics.
- **Part B — shadow-ref** (`--track shadow`): sync `.omc/` content into a
  hidden, local-only shadow git repository, pushed to a custom ref on your
  existing `origin` remote — the same mechanism `bd dolt push` uses to sync
  `.beads/`.

## Install

From this repo:

```
npm install
npm run build
```

Then either invoke the built CLI directly:

```
node /path/to/plan-sync/dist/cli.js <command> ...
```

or put a plain `plan-sync` on your `PATH`:

```
npm link
```

Everything below assumes `plan-sync` is on your `PATH`; substitute the
`node .../dist/cli.js` form if you didn't `npm link`.

## Which track should you use?

**Use Part A (`--track sibling`) by default.** It's the recommended path for
team and multi-machine durability: it's an ordinary git repository, so you
get full git semantics (real merge conflicts with standard `<<<<<<<`/`>>>>>>>`
markers, ordinary `git rm`/`git mv` for deletions/renames), and it's covered
by your host's existing secret-scanning, branch-protection, and backup
policies, exactly like any other repo.

**Use Part B (`--track shadow`) only as a narrower, single-developer,
single-machine personal backup mechanism.** It reproduces the same
reverse-engineered trick `bd dolt push` uses to sync `.beads/` — a hidden bare
git repository pushing to a custom ref (`refs/plan-sync/<project-id>/<root>/data`) outside
`refs/heads/*`/`refs/tags/*`, invisible to `git status`/`git branch -a`/`git
log --all`. It has no cross-machine conflict resolution; it supports only
push-from-this-machine and pull-onto-this-machine (`pull` materializes the
pushed ref's tree, it doesn't merge). It is **not recommended for team-wide
or multi-machine use** — if you need that, use Part A instead.

### "It says it pushed, but I don't see a branch or anything on GitHub"

That's expected, not a bug — it's the entire point of the shadow-ref track.
It pushes to `refs/plan-sync/<project-id>/<root>/data`, a ref outside `refs/heads/*` and
`refs/tags/*`. GitHub/GitLab/Azure DevOps UIs only ever list branches and
tags, so this ref is invisible there by design, and a plain `git fetch`/`git
clone` never retrieves it either (the default fetch refspec only matches
`refs/heads/*`). To prove it's really there:

```
git ls-remote origin "refs/plan-sync/*"
```

If a ref/sha shows up, the push worked. `plan-sync status` reporting a recent
"last push" timestamp is the normal, reliable signal that it worked — you
should not expect to see anything in the host's web UI.

## Global setup, once per repo: default track

The **first** `init` you run in a repo persists a default track to
`.omc/.sync-config.json`, so you don't have to repeat `--track` on every
later command:

```
plan-sync init --track shadow          # or --track sibling --remote ... --clone-path ...
plan-sync push                          # no --track needed — uses the persisted default
plan-sync status                        # same
```

An explicit `--track` on any command always overrides the persisted default
(useful if you've initialized both tracks in the same repo). `init` itself
always requires an explicit `--track` — it's the one command that decides
what to set up, so it never guesses.

## The manifest: nothing syncs unless you `allow` it

Both tracks share one manifest file, `.omc/.sync-manifest`, and two commands
to manage it:

```
plan-sync allow <path-or-glob> [<path-or-glob> ...]
plan-sync unallow <path-or-glob> [<path-or-glob> ...]
```

`<path>`/`<pattern>` is relative to `.omc/` (e.g. `plan-sync allow
plans/foo.md`, not `.omc/plans/foo.md`). Both commands accept multiple
targets in one call (`plan-sync allow a.md b.md "plans/*.md"`), each processed
independently. Adding an already-present path is a no-op — the manifest
never gets a duplicate entry. Removing a path that isn't present is also a
no-op, not an error.

`unallow` matches glob patterns against the manifest's *current entries*,
not the filesystem — so you can remove an entry even if its file was already
deleted from disk.

**Every manifest entry is always a live pattern, re-evaluated at every
`push`/`status`** — there's no separate "expand once" mode and no flag to
opt into live matching. `plan-sync allow "plans/*.md"` saves that pattern
string verbatim as one manifest line; a literal filename like `notes.md` is
just a degenerate pattern with no wildcards, so it behaves identically to
today either way. This means a file created *after* you ran `allow` still
gets picked up automatically the next time you `push` or `status`, as long
as it matches a pattern already in the manifest — the same way npm's
`package.json` `files` field stays a live glob rather than a frozen
snapshot, rather than requiring you to re-run `allow` for every new file.

### Editing the manifest by hand

`.omc/.sync-manifest` is a plain text file, one path per line; blank lines
and `#`-prefixed comment lines are ignored. You can open it in any editor
and add, remove, or comment out lines directly — it's validated on every
read (an out-of-bounds line is skipped with a warning, not trusted blindly),
so hand-editing is safe. `allow`/`unallow` are just a convenient CLI for the
same file; neither is required.

Nothing under `.omc/` is ever synced unless it has been explicitly added to
the manifest with `allow`. There is no automatic directory- or
extension-based matching — this is a deliberate design choice: which files
are safe to push to a shared remote is a human judgment call, not something
a glob pattern can reliably make (a plans file can contain anything from
routine notes to sensitive proprietary content). By keeping sync strictly
opt-in per path, that judgment stays with the developer, exercised each time
a new path is added.

**Glob patterns are supported** — and, per the note above, are saved
verbatim and re-evaluated live on every `push`/`status`, not expanded once:

```
plan-sync allow "plans/**/*.md"     # every .md under .omc/plans/, any depth, now and later
plan-sync allow "*.md"              # every top-level .omc/*.md
plan-sync allow "reports/?.md"      # single-character wildcard
```

Quote glob patterns so your shell doesn't expand them first. Supported
wildcards: `*` (anything except `/`), `?` (one character except `/`), `**`
(anything including `/`, i.e. recursive), and `[...]` character classes.
Directories and symlinks are never matched — only real files. `allow` still
prints how many files currently match, purely for feedback — that count is
never written to the manifest, only the pattern string itself is.

**The manifest itself travels with the sync payload** in both tracks — you
never need to `allow` `.sync-manifest` yourself. `push` always includes it,
and `pull` always merges the incoming entries into the local manifest (a
union — it only ever adds entries, never removes ones already present
locally). This is what makes the second-machine flow below work without
manually re-running `allow` for every file.

## Part A: sibling git repo

```
plan-sync init --track sibling --remote <url> --clone-path <path>
plan-sync allow <path-or-glob>
plan-sync push
plan-sync pull
plan-sync status
```

- `init --track sibling` writes `.omc/` into the anchor repo's
  `.git/info/exclude` (never the tracked `.gitignore`) and clones (or reuses
  an existing clone of) `<url>` at `<clone-path>`. Persists the default
  track and the clone/remote config to `.omc/.sync-config.json`.
- `push` copies every manifest-listed file (plus `.sync-manifest` itself)
  from `.omc/` into the sibling clone, stages only those paths, commits, and
  pushes.
- `pull` runs `git pull --rebase` in the sibling clone, then copies
  manifest-listed files (and merges the incoming manifest) back into
  `.omc/`, propagating deletions.
- `status` reports, per manifest-listed file, one of `in sync`, `pending
  (local changes)`, `pending (never synced)`, or `missing locally` —
  comparing `.omc/<path>` against the clone's copy — followed by a summary
  count.

### First machine

```
plan-sync init --track sibling --remote git@github.com:my-org/my-repo-omc-artifacts.git --clone-path ../my-repo-omc-artifacts
plan-sync allow "plans/**/*.md"
plan-sync allow notes.md
plan-sync push
```

### Second machine

```
git clone git@github.com:my-org/my-repo.git   # the ANCHOR repo, not the artifacts one
cd my-repo
plan-sync init --track sibling --remote git@github.com:my-org/my-repo-omc-artifacts.git --clone-path ../my-repo-omc-artifacts
plan-sync pull
plan-sync status
```

`--clone-path` is still required on every machine (it's a local filesystem
location, inherently machine-specific) — but you do **not** need to re-run
`allow` for anything: `pull` brings back both file content and the manifest
itself, merged into whatever's already local.

Conflicts are handled the ordinary git way: if the same manifest-listed file
is edited differently on two machines, whichever side pulls second gets a
real merge conflict with standard `<<<<<<<`/`>>>>>>>` markers in the sibling
clone. Resolve it manually there (edit, `git add`, `git rebase --continue`)
just as you would for any other git conflict — nothing is silently discarded
or auto-resolved.

## Part B: shadow-ref

```
plan-sync init --track shadow [--remote <url>]
plan-sync allow <path-or-glob>
plan-sync push
plan-sync pull [--ref <sha>]
plan-sync status [--stale-after <duration>]
plan-sync uninstall
```

- `init --track shadow` creates a bare shadow git repo (idempotent), excludes
  `.omc/` via `.git/info/exclude`, and wires an `origin` remote — from
  `--remote` if given, otherwise inferred from the anchor repo's own
  `origin`. Persists the default track to `.omc/.sync-config.json`.
- `push` stages every manifest-listed file (plus `.sync-manifest` itself,
  unconditionally), runs an advisory secret-shape scan (JWT, PEM header,
  SSN, API-key shapes) per file and skips — with a logged warning, keeping
  the file's prior synced content rather than deleting it — any file that
  matches, commits the resulting tree, and pushes to
  `refs/plan-sync/<project-id>/<root>/data`. If nothing actually changed since the last
  push, it's a genuine no-op (`"nothing changed since the last push"`) —
  that message means it worked and detected no delta, not that it failed.
- `pull` materializes the tree at that ref (or a `--ref` override) back
  onto disk under `.omc/`, deleting any manifest-listed path that's
  genuinely absent from the target tree (not merely scan-skipped), and
  merges the incoming `.sync-manifest` into the local one.
- `status` prints a per-file report (same four states as the sibling track,
  comparing local content against the pushed ref's tree via `git
  hash-object`), then reports the age of the last successful push, flagging
  it as stale if older than `--stale-after` (default `24h`; accepts
  `h`/`d`/`m` suffixes, e.g. `7d`, `30m`).
- `uninstall` deletes the remote ref and removes the local shadow repo.

### First machine

```
plan-sync init --track shadow
plan-sync allow "plans/**/*.md"
plan-sync push
plan-sync status
```

### Second machine

```
git clone git@github.com:my-org/my-repo.git
cd my-repo
plan-sync init --track shadow
plan-sync pull
plan-sync status
```

`init --track shadow` is the same, idempotent command on every machine —
there's no separate "bootstrap" step. `pull` brings back both file
content and the manifest itself.

The shadow repo lives outside `.omc/`, at
`$PLAN_SYNC_STATE_DIR/<project-id>/<root>/plan-sync-shadow.git` when `PLAN_SYNC_STATE_DIR` is set,
otherwise at `${XDG_CACHE_HOME:-$HOME/.cache}/plan-sync-shadow/<project-id>/<root>.git`.
Set `PLAN_SYNC_STATE_DIR` (or `XDG_CACHE_HOME`) to control where that data lives —
for example, to centralize shadow repos for multiple projects outside the
default cache location.

`<project-id>` is the first 12 hex characters of the repo's root commit hash
(`git rev-list --max-parents=0 HEAD`) — git's own content-addressed identity
for "this is the same repository history" — not anything derived from the
`origin` remote URL. That makes identity stable across repo renames, remote
URL changes (including switching between SSH and HTTPS, or moving to a
different host entirely), and independently computable on every machine/clone
of the repo, since they all share the same root commit.

The advisory content scan is a backstop, not a substitute for judgment about
what you `allow`: it only catches a few specific secret shapes, and a file
that doesn't match any of them is pushed as-is. Only add paths you've
reviewed and are comfortable syncing.

## Command reference

| Command | Tracks | Key flags |
|---|---|---|
| `init` | both (always requires `--track`) | `--track sibling --remote <url> --clone-path <path>` &nbsp;/&nbsp; `--track shadow [--remote <url>]` &nbsp;(both accept `[--root <dir>]`) |
| `allow <path-or-glob> [...]` | both (shared manifest) | `[--root <dir>]` |
| `unallow <path-or-glob> [...]` | both (shared manifest) | `[--root <dir>]` |
| `push` | both | `[--root <dir>]` |
| `pull` | both | `[--root <dir>]` (shadow track also accepts `[--ref <sha-or-ref>]`) |
| `status` | both | `--track shadow` accepts `[--stale-after <duration>]`; both accept `[--root <dir>]` |
| `uninstall` | shadow only | `[--root <dir>]` |

Every command except `init` accepts `--track sibling|shadow` explicitly, or
falls back to whichever track was most recently `init`-ed in this repo (see
"Global setup" above). Running `uninstall --track sibling` (etc.) errors
with a message pointing you at the right command for that track, rather
than doing nothing silently.

## Configurable root directory: `--root <dir>`

Every command in the table above accepts `--root <dir>`, which generalizes
what used to be a hardcoded `.omc` directory into "one root per invocation" —
the same repo can host multiple independent roots (e.g. `.omc`, `.omx`,
`.adlc`), each with its own manifest, sync-config, and (for the shadow track)
ref namespace / local shadow-repo path, but any single command always
operates against exactly one of them. Tracking multiple roots
simultaneously in one manifest is a separate, larger feature — out of scope
here.

Resolution, when `--root` isn't given:

1. If exactly one of `.omc`, `.omx`, `.adlc` exists as a directory **and**
   contains a `.sync-config.json` at its top level, that one is
   auto-detected and used.
2. Otherwise (nothing initialized yet, or more than one candidate matches),
   falls back to `.omc` — this preserves today's default behavior for the
   common case and for a totally fresh repo.

```
plan-sync init --track shadow --root .omx
plan-sync allow "plans/**/*.md" --root .omx
plan-sync push --root .omx           # --track omitted: falls back to the
                                       # default persisted inside .omx/.sync-config.json
```

Two roots initialized in the same repo (e.g. both `.omc` and `.omx` on the
shadow track) never collide: the shadow-track ref name and local shadow-repo
path both bake in the (dot-stripped) root segment —
`refs/plan-sync/<project-id>/omc/data` vs.
`refs/plan-sync/<project-id>/omx/data` — so pushing to one never affects the
other's tree.

## Sanity-checking that it's really invisible

After any `push`/`init`/`pull`, these should all be completely
unaffected on your primary repo:

```
git status --short      # empty
git branch -a            # no refs/plan-sync/* entry, ever
git log --all --oneline  # no plan-sync commits, ever
```

To see the hidden data directly:

```
git ls-remote origin "refs/plan-sync/*"
```

## Setup (for developing plan-sync itself)

```
npm install
npm run build
npm test
```

## Further reading

For the full design rationale and ADR behind both tracks — including the
reverse-engineering of `bd dolt push`'s mechanism and the three prior
designs that were rejected during review before arriving at this one — see
[`docs/DESIGN.md`](docs/DESIGN.md).

## License

[MIT](LICENSE)
