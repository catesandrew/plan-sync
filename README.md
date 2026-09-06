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

## The manifest: nothing syncs unless you `allow` it

Both tracks share one manifest file, `.omc/.sync-manifest`, and one command
to add to it:

```
omc-sync allow <path>
```

`<path>` is relative to `.omc/` (e.g. `omc-sync allow plans/foo.md`, not
`.omc/plans/foo.md`). Adding an already-present path is a no-op — the
manifest never gets a duplicate entry.

Nothing under `.omc/` is ever synced unless it has been explicitly added to
the manifest with `allow`. There is no automatic directory- or
extension-based matching — this is a deliberate design choice: which files
are safe to push to a shared remote is a human judgment call, not something
a glob pattern can reliably make (a plans file can contain anything from
routine notes to sensitive proprietary content). By keeping sync strictly
opt-in per path, that judgment stays with the developer, exercised each time
a new path is added.

## Part A: sibling git repo

```
omc-sync init --track sibling --remote <url> --clone-path <path>
omc-sync allow <path>
omc-sync push --track sibling
omc-sync pull --track sibling
```

- `init --track sibling` writes `.omc/` into the anchor repo's
  `.git/info/exclude` (never the tracked `.gitignore`) and clones (or reuses
  an existing clone of) `<url>` at `<clone-path>`.
- `push --track sibling` copies every manifest-listed file from `.omc/` into
  the sibling clone, stages only those paths, commits, and pushes.
- `pull --track sibling` runs `git pull --rebase` in the sibling clone, then
  copies manifest-listed files back into `.omc/`, propagating deletions.

Example:

```
omc-sync init --track sibling --remote git@github.com:my-org/my-repo-omc-artifacts.git --clone-path ../my-repo-omc-artifacts
omc-sync allow plans/foo.md
omc-sync allow notes.md
omc-sync push --track sibling
# ...on another machine, after the same init...
omc-sync pull --track sibling
```

Conflicts are handled the ordinary git way: if the same manifest-listed file
is edited differently on two machines, whichever side pulls second gets a
real merge conflict with standard `<<<<<<<`/`>>>>>>>` markers in the sibling
clone. Resolve it manually there (edit, `git add`, `git rebase --continue`)
just as you would for any other git conflict — nothing is silently discarded
or auto-resolved.

## Part B: shadow-ref

```
omc-sync init --track shadow [--remote <url>]
omc-sync allow <path>
omc-sync push --track shadow
omc-sync restore --track shadow [--ref <sha>]
omc-sync status --track shadow [--stale-after <duration>]
omc-sync uninstall --track shadow
```

- `init --track shadow` creates a bare shadow git repo (idempotent), excludes
  `.omc/` via `.git/info/exclude`, and wires an `origin` remote — from
  `--remote` if given, otherwise inferred from the anchor repo's own
  `origin`.
- `push --track shadow` stages every manifest-listed file, runs an advisory
  secret-shape scan (JWT, PEM header, SSN, API-key shapes) per file and skips
  (with a logged warning) any file that matches, commits the resulting tree,
  and pushes to `refs/omc/<project-id>/data`.
- `restore --track shadow` materializes the tree at that ref (or a `--ref`
  override) back onto disk under `.omc/`, deleting any manifest-listed path
  that's absent from the target tree.
- `status --track shadow` reports the age of the last successful push, and
  flags it as stale if it's older than `--stale-after` (default `24h`;
  accepts `h`/`d`/`m` suffixes, e.g. `7d`, `30m`).
- `uninstall --track shadow` deletes the remote ref and removes the local
  shadow repo.

Example:

```
omc-sync init --track shadow
omc-sync allow plans/foo.md
omc-sync push --track shadow
# ...simulating a fresh machine...
omc-sync restore --track shadow
omc-sync status --track shadow --stale-after 12h
```

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

## Setup

```
npm install
npm run build
npm test
```

## Further reading

For the full design rationale and ADR behind both tracks, see
[`.omc/plans/shadow-ref-git-sync-for-omc-artifacts.md`](.omc/plans/shadow-ref-git-sync-for-omc-artifacts.md).
