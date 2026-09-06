import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRepoRoot } from "./repo-root";
import { expandGlobUnderRoot, hasGlobMeta } from "./glob";

/**
 * Manifest file format: one path per line. Blank lines and lines starting
 * with `#` (comments) are ignored. Every other line is returned verbatim —
 * no directory-walking, glob expansion, or extension-based matching is ever
 * performed here; the manifest is the single source of truth for exactly
 * which paths are opted in to sync.
 */

const MANIFEST_DIR = ".omc";
const MANIFEST_FILE = ".sync-manifest";

/**
 * The manifest's own filename (relative to `.omc/`), exported so tracks can
 * recognize and specially handle the manifest file itself when it travels as
 * part of the sync payload (see push/restore/pull in both tracks) — it must
 * never be treated as an ordinary manifest-listed content file (no secret
 * scan, no wholesale overwrite on restore/pull, union-merged instead).
 */
export const MANIFEST_FILENAME = MANIFEST_FILE;

/**
 * Returns the default manifest path (`.omc/.sync-manifest`) relative to the
 * given repo root, defaulting to the git repository top level containing
 * the current working directory (via `resolveRepoRoot()`).
 */
export function defaultManifestPath(repoRoot: string = resolveRepoRoot()): string {
  return path.join(repoRoot, MANIFEST_DIR, MANIFEST_FILE);
}

/**
 * Returns true if a manifest file physically exists at `manifestPath`,
 * distinguishing a MISSING manifest file from a genuinely EMPTY (zero-entry)
 * one — `readManifest` deliberately returns `[]` for both, since that
 * collapse is safe for the sibling track (an empty/missing manifest there
 * just means "nothing to push"), but the shadow track needs to tell them
 * apart: a missing manifest file combined with a real previous tip on the
 * ref is a likely-accidental scenario (e.g. the manifest file itself got
 * deleted, or state resolved somewhere unexpected), not a legitimate
 * whole-manifest deletion.
 */
export function manifestExists(manifestPath: string): boolean {
  return fs.existsSync(manifestPath);
}

/**
 * Returns true if `relPath`, resolved relative to `omcRoot`, stays contained
 * within `omcRoot` — i.e. it is not an absolute path and does not escape via
 * `../` traversal. Bare absolute paths are always rejected outright, since
 * `path.resolve(omcRoot, relPath)` would otherwise ignore `omcRoot` entirely
 * and silently "resolve" to the absolute path itself.
 */
export function isPathContained(omcRoot: string, relPath: string): boolean {
  if (path.isAbsolute(relPath)) {
    return false;
  }

  const normalizedRoot = path.resolve(omcRoot);
  const resolved = path.resolve(omcRoot, relPath);
  return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep);
}

/**
 * Reads the manifest at `manifestPath` and returns the exact list of paths
 * listed in it, one per line, ignoring blank lines and `#`-prefixed comment
 * lines. Returns `[]` if the file doesn't exist.
 *
 * Any line that would resolve outside the manifest's `.omc/` directory (a
 * `../` traversal or an absolute path — e.g. from a hand-edited manifest
 * file) is skipped with a warning logged to stderr, rather than trusted and
 * returned as-is. This is a skip-and-warn check, not a fail-closed one: one
 * bad line in a hand-edited file shouldn't invalidate every other valid
 * entry.
 */
export function readManifest(manifestPath: string): string[] {
  if (!fs.existsSync(manifestPath)) {
    return [];
  }

  const omcRoot = path.dirname(manifestPath);
  const contents = fs.readFileSync(manifestPath, "utf8");
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .filter((line) => {
      if (!isPathContained(omcRoot, line)) {
        process.stderr.write(
          `omc-sync: ignoring out-of-bounds manifest entry '${line}'\n`,
        );
        return false;
      }
      return true;
    });
}

/**
 * Appends `entryPath` to the manifest at `manifestPath` if it isn't already
 * present (exact string match against existing lines). No-op if already
 * present. Creates the manifest file and its parent directory if they don't
 * exist yet.
 *
 * Rejects (throws, before writing anything) an `entryPath` that would
 * resolve outside the manifest's `.omc/` directory — this is an active
 * mutation the user just requested via `allow`, so it fails closed rather
 * than being merely blocked incidentally downstream by git.
 */
export function addToManifest(manifestPath: string, entryPath: string): void {
  const omcRoot = path.dirname(manifestPath);
  if (!isPathContained(omcRoot, entryPath)) {
    if (path.isAbsolute(entryPath)) {
      throw new Error(
        `allow: absolute paths are not allowed, got '${entryPath}'`,
      );
    }
    throw new Error(
      `allow: '${entryPath}' resolves outside .omc/ — refusing to add`,
    );
  }

  const existing = readManifest(manifestPath);
  if (existing.includes(entryPath)) {
    return;
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });

  const needsLeadingNewline =
    fs.existsSync(manifestPath) &&
    fs.readFileSync(manifestPath, "utf8").length > 0 &&
    !fs.readFileSync(manifestPath, "utf8").endsWith("\n");

  fs.appendFileSync(
    manifestPath,
    `${needsLeadingNewline ? "\n" : ""}${entryPath}\n`,
  );
}

/**
 * Reads the manifest at `manifestPath` (via `readManifest`) and resolves
 * every entry to concrete, currently-on-disk paths: EVERY entry is always
 * treated as a glob pattern and re-evaluated live against the current
 * filesystem under `.omc/`, via `expandGlobUnderRoot` — there is no
 * literal-vs-pattern branch here. A literal filename like `notes.md` is
 * just a degenerate pattern with no metacharacters, so `expandGlobUnderRoot`
 * naturally resolves it to itself (if it currently exists on disk, as a
 * regular file) or to nothing (if it doesn't exist, or is a symlink), via
 * the exact same walk+match logic used for every other entry — no
 * special-casing needed. Returns the deduplicated, combined list.
 *
 * This is deliberately a SEPARATE function from `readManifest`, not a
 * replacement for it: `readManifest`'s contract (raw entries verbatim,
 * never glob-expanded) must not change, since several call sites
 * legitimately need the raw list rather than "what should be synced right
 * now" — e.g. `unallow`'s glob-matching against current manifest entries,
 * `addToManifest`'s own duplicate-check, and the manifest-travel merge
 * logic in shadow/restore.ts and sibling/pull.ts that unions incoming
 * manifest lines into the local one.
 *
 * Note that push/status do NOT call this directly — see
 * `resolveManifestSyncCandidates` below for the list they actually
 * consume, which additionally preserves a literal entry even when it
 * doesn't currently resolve to anything (needed for deletion propagation,
 * "missing locally" reporting, and symlink-skip warnings).
 */
export function resolveManifestPaths(manifestPath: string): string[] {
  const entries = readManifest(manifestPath);
  const omcRoot = path.dirname(manifestPath);
  const resolved = new Set<string>();

  for (const entry of entries) {
    for (const match of expandGlobUnderRoot(omcRoot, entry)) {
      resolved.add(match);
    }
  }

  return [...resolved];
}

/**
 * The candidate path list actually consumed by both tracks' `push` and
 * `status`: the union of `resolveManifestPaths` (every entry's CURRENT
 * filesystem matches, live) with every literal (non-glob) manifest entry,
 * included even when it doesn't currently resolve to anything on disk.
 *
 * That extra inclusion is what push/status need beyond `resolveManifestPaths`
 * alone: a literal entry like `notes.md` always refers to exactly one
 * specific path, whether or not a file is currently there — and push's
 * deletion-propagation, status's "missing locally" reporting, and both
 * tracks' symlink-skip warnings all depend on that path surviving into the
 * candidate list even when it's absent or a symlink (both of which
 * `expandGlobUnderRoot`, underlying `resolveManifestPaths`, otherwise
 * silently omits, since it only ever collects currently-existing regular
 * files). A glob PATTERN entry (e.g. `plans/*.md`) has no single path of its
 * own to fall back to this way — if it currently matches nothing, it
 * contributes nothing, which is correct: there's no specific file a pattern
 * "used to mean" that a deletion or missing-locally check could act on.
 */
export function resolveManifestSyncCandidates(manifestPath: string): string[] {
  const entries = readManifest(manifestPath);
  const candidates = new Set(resolveManifestPaths(manifestPath));

  for (const entry of entries) {
    if (!hasGlobMeta(entry)) {
      candidates.add(entry);
    }
  }

  return [...candidates];
}

/**
 * Removes `entryPath` from the manifest at `manifestPath` if present (exact
 * string match against parsed entries — comments/blank lines are preserved
 * as-is around it). Returns `true` if it was present and removed, `false`
 * if it was already absent (a no-op, not an error — mirrors
 * `addToManifest`'s idempotent-add semantics for the removal direction).
 * No-op if the manifest file doesn't exist at all.
 */
export function removeFromManifest(manifestPath: string, entryPath: string): boolean {
  if (!fs.existsSync(manifestPath)) {
    return false;
  }

  const contents = fs.readFileSync(manifestPath, "utf8");
  const lines = contents.split("\n");
  let removed = false;

  const kept = lines.filter((line) => {
    if (line.trim() === entryPath) {
      removed = true;
      return false;
    }
    return true;
  });

  if (!removed) {
    return false;
  }

  fs.writeFileSync(manifestPath, kept.join("\n"));
  return true;
}
