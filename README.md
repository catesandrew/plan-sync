# omc-sync

`omc-sync` is a CLI for durably syncing the human-authored planning artifacts
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
node /path/to/omc-sync/dist/cli.js <command> ...
```

or put a plain `omc-sync` on your `PATH`:

```
npm link
```

Everything below assumes `omc-sync` is on your `PATH`; substitute the
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
git repository pushing to a custom ref (`refs/omc/<project-id>/data`) outside
`refs/heads/*`/`refs/tags/*`, invisible to `git status`/`git branch -a`/`git
log --all`. It has no cross-machine conflict resolution and no `pull`; it
supports only push-from-this-machine and restore-onto-this-machine. It is
**not recommended for team-wide or multi-machine use** — if you need that,
use Part A instead.

### "It says it pushed, but I don't see a branch or anything on GitHub"

That's expected, not a bug — it's the entire point of the shadow-ref track.
It pushes to `refs/omc/<project-id>/data`, a ref outside `refs/heads/*` and
`refs/tags/*`. GitHub/GitLab/Azure DevOps UIs only ever list branches and
tags, so this ref is invisible there by design, and a plain `git fetch`/`git
clone` never retrieves it either (the default fetch refspec only matches
`refs/heads/*`). To prove it's really there:

```
git ls-remote origin "refs/omc/*"
```

If a ref/sha shows up, the push worked. `omc-sync status` reporting a recent
"last push" timestamp is the normal, reliable signal that it worked — you
should not expect to see anything in the host's web UI.

## Global setup, once per repo: default track

The **first** `init` you run in a repo persists a default track to
`.omc/.sync-config.json`, so you don't have to repeat `--track` on every
later command:

```
omc-sync init --track shadow          # or --track sibling --remote ... --clone-path ...
omc-sync push                          # no --track needed — uses the persisted default
omc-sync status                        # same
```

An explicit `--track` on any command always overrides the persisted default
(useful if you've initialized both tracks in the same repo). `init` itself
always requires an explicit `--track` — it's the one command that decides
what to set up, so it never guesses.

## The manifest: nothing syncs unless you `allow` it

Both tracks share one manifest file, `.omc/.sync-manifest`, and two commands
to manage it:

```
omc-sync allow <path-or-glob> [<path-or-glob> ...]
omc-sync unallow <path-or-glob> [<path-or-glob> ...]
```

`<path>`/`<pattern>` is relative to `.omc/` (e.g. `omc-sync allow
plans/foo.md`, not `.omc/plans/foo.md`). Both commands accept multiple
targets in one call (`omc-sync allow a.md b.md "plans/*.md"`), each processed
independently. Adding an already-present path is a no-op — the manifest
never gets a duplicate entry. Removing a path that isn't present is also a
no-op, not an error.

`unallow` matches glob patterns against the manifest's *current entries*,
not the filesystem — so you can remove an entry even if its file was already
deleted from disk.

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

**Glob patterns are supported** as a convenience for expanding *now* against
files that already exist — `allow` is not a standing "watch this pattern
forever" rule, it's a one-time expansion that adds whatever currently
matches:

```
omc-sync allow "plans/**/*.md"     # every .md under .omc/plans/, any depth
omc-sync allow "*.md"              # every top-level .omc/*.md
omc-sync allow "reports/?.md"      # single-character wildcard
```

Quote glob patterns so your shell doesn't expand them first. Supported
wildcards: `*` (anything except `/`), `?` (one character except `/`), `**`
(anything including `/`, i.e. recursive), and `[...]` character classes.
Directories and symlinks are never matched — only real files. A pattern that
matches nothing prints a warning and does nothing (it's not an error); a
pattern that matches N files reports how many were newly added versus
already present.

**The manifest itself travels with the sync payload** in both tracks — you
never need to `allow` `.sync-manifest` yourself. `push` always includes it,
and `restore`/`pull` always merge the incoming entries into the local
manifest (a union — it only ever adds entries, never removes ones already
present locally). This is what makes the second-machine flow below work
without manually re-running `allow` for every file.

## Part A: sibling git repo

```
omc-sync init --track sibling --remote <url> --clone-path <path>
omc-sync allow <path-or-glob>
omc-sync push
omc-sync pull
omc-sync status
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
omc-sync init --track sibling --remote git@github.com:my-org/my-repo-omc-artifacts.git --clone-path ../my-repo-omc-artifacts
omc-sync allow "plans/**/*.md"
omc-sync allow notes.md
omc-sync push
```

### Second machine

```
git clone git@github.com:my-org/my-repo.git   # the ANCHOR repo, not the artifacts one
cd my-repo
omc-sync init --track sibling --remote git@github.com:my-org/my-repo-omc-artifacts.git --clone-path ../my-repo-omc-artifacts
omc-sync pull
omc-sync status
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
omc-sync init --track shadow [--remote <url>]
omc-sync allow <path-or-glob>
omc-sync push
omc-sync restore [--ref <sha>]
omc-sync status [--stale-after <duration>]
omc-sync uninstall
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
  `refs/omc/<project-id>/data`. If nothing actually changed since the last
  push, it's a genuine no-op (`"nothing changed since the last push"`) —
  that message means it worked and detected no delta, not that it failed.
- `restore` materializes the tree at that ref (or a `--ref` override) back
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
omc-sync init --track shadow
omc-sync allow "plans/**/*.md"
omc-sync push
omc-sync status
```

### Second machine

```
git clone git@github.com:my-org/my-repo.git
cd my-repo
omc-sync init --track shadow
omc-sync restore
omc-sync status
```

`init --track shadow` is the same, idempotent command on every machine —
there's no separate "bootstrap" step. `restore` brings back both file
content and the manifest itself.

The shadow repo lives outside `.omc/`, at
`$OMC_STATE_DIR/<project-id>/omc-shadow.git` when `OMC_STATE_DIR` is set,
otherwise at `${XDG_CACHE_HOME:-$HOME/.cache}/omc-shadow/<project-id>.git`.
Set `OMC_STATE_DIR` (or `XDG_CACHE_HOME`) to control where that data lives —
for example, to centralize shadow repos for multiple projects outside the
default cache location.

The advisory content scan is a backstop, not a substitute for judgment about
what you `allow`: it only catches a few specific secret shapes, and a file
that doesn't match any of them is pushed as-is. Only add paths you've
reviewed and are comfortable syncing.

## Command reference

| Command | Tracks | Key flags |
|---|---|---|
| `init` | both (always requires `--track`) | `--track sibling --remote <url> --clone-path <path>` &nbsp;/&nbsp; `--track shadow [--remote <url>]` |
| `allow <path-or-glob> [...]` | both (shared manifest) | — |
| `unallow <path-or-glob> [...]` | both (shared manifest) | — |
| `push` | both | — |
| `pull` | sibling only | — |
| `restore` | shadow only | `[--ref <sha-or-ref>]` |
| `status` | both | `--track shadow` accepts `[--stale-after <duration>]` |
| `uninstall` | shadow only | — |

Every command except `init` accepts `--track sibling|shadow` explicitly, or
falls back to whichever track was most recently `init`-ed in this repo (see
"Global setup" above). Running `pull --track shadow` or `restore --track
sibling` (etc.) errors with a message pointing you at the right command for
that track, rather than doing nothing silently.

## Sanity-checking that it's really invisible

After any `push`/`init`/`restore`, these should all be completely
unaffected on your primary repo:

```
git status --short      # empty
git branch -a            # no refs/omc/* entry, ever
git log --all --oneline  # no omc-sync commits, ever
```

To see the hidden data directly:

```
git ls-remote origin "refs/omc/*"
```

## Setup (for developing omc-sync itself)

```
npm install
npm run build
npm test
```

## Further reading

For the full design rationale and ADR behind both tracks, see
[`.omc/plans/shadow-ref-git-sync-for-omc-artifacts.md`](.omc/plans/shadow-ref-git-sync-for-omc-artifacts.md).
