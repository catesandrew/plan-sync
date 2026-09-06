import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Configurable sync root (Feature: `--root <dir>` flag), generalizing what
 * used to be a single hardcoded `.omc` directory into "one root per
 * invocation" — a repo can host multiple roots (e.g. `.omc`, `.omx`,
 * `.adlc`), each with its own independent manifest, sync-config, and (for
 * the shadow track) ref namespace / local shadow-repo path, but any single
 * command invocation always operates against exactly one of them. Tracking
 * multiple roots simultaneously in one manifest is an explicitly separate,
 * larger future feature — out of scope here.
 */

/** Known root directory names auto-detection considers, in priority order. */
export const CANDIDATE_ROOTS = [".omc", ".omx", ".adlc"];

/** The root used when nothing else can be resolved (preserves prior behavior). */
export const DEFAULT_ROOT = ".omc";

const SYNC_CONFIG_FILE = ".sync-config.json";

/**
 * Resolves which root directory this invocation should operate against.
 *
 * Precedence:
 *   1. `explicitRoot` (from `--root <dir>`), if given — validated to be a
 *      single directory name, never a path that could escape `repoRoot`.
 *   2. Auto-detection: if exactly one of `CANDIDATE_ROOTS` exists as a
 *      directory under `repoRoot` AND contains a `.sync-config.json` at its
 *      top level, that one is used.
 *   3. `DEFAULT_ROOT` (`.omc`) otherwise — this covers both a totally fresh
 *      repo (nothing initialized yet) and an ambiguous state (zero or more
 *      than one candidate matches), preserving today's default behavior.
 */
export function resolveRootDir(repoRoot: string, explicitRoot?: string): string {
  if (explicitRoot) {
    return validateRoot(explicitRoot);
  }

  const detected = CANDIDATE_ROOTS.filter((candidate) =>
    isInitializedRoot(repoRoot, candidate),
  );

  if (detected.length === 1) {
    return detected[0];
  }

  return DEFAULT_ROOT;
}

function isInitializedRoot(repoRoot: string, candidate: string): boolean {
  const dir = path.join(repoRoot, candidate);
  try {
    if (!fs.statSync(dir).isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }
  return fs.existsSync(path.join(dir, SYNC_CONFIG_FILE));
}

/**
 * Rejects a `--root` value that isn't a single, bare directory name — no
 * path separators, no `.`/`..`, no absolute paths — since the resolved root
 * is joined directly onto `repoRoot` everywhere downstream (manifest path,
 * sync-config path, shadow ref/repo-path segments); an unvalidated value
 * here would reopen exactly the kind of path-escape this codebase otherwise
 * guards against.
 */
function validateRoot(root: string): string {
  const trimmed = root.trim();
  if (
    trimmed.length === 0 ||
    trimmed === "." ||
    trimmed === ".." ||
    path.isAbsolute(trimmed) ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    throw new Error(
      `--root must be a single directory name with no path separators, got '${root}'`,
    );
  }
  return trimmed;
}

/**
 * Strips a single leading `.` from `rootDir` (e.g. `.omc` -> `omc`, `.omx` ->
 * `omx`), for use in contexts that bake the root into a namespace segment
 * (the shadow-track ref name and local shadow-repo path) where a literal
 * leading dot is either invalid or merely noisy.
 */
export function rootSegment(rootDir: string): string {
  return rootDir.startsWith(".") ? rootDir.slice(1) : rootDir;
}
