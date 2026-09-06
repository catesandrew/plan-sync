import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRepoRoot } from "./repo-root";

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
